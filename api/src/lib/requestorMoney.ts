/**
 * Driver pay is not requestor-visible.
 *
 * A requestor books deliveries. What the driver earns for one is HR data about
 * a third party, and the truck's rate card is commercial data — neither is
 * theirs to read. The mobile app already behaves correctly (TripCard, the only
 * component that renders an amount, is used solely by the driver and admin
 * screens), but the API was handing the numbers over anyway: the shared
 * TRIP_INCLUDE returns every Trip scalar, and `truck: true` returns the whole
 * truck row.
 *
 * Measured on a real requestor token before this existed: `GET /trips` returned
 * 275 of the requestor's own trips, 150 of them carrying a non-null
 * `incentive_earned` alongside the named driver. Ownership scoping was correct
 * — every trip was genuinely theirs — so this was field-level exposure, not a
 * cross-tenant one, and read-only. But a requestor could still total up an
 * individual driver's earnings, and read the truck rate card straight out of
 * the payload.
 *
 * Redaction happens at ONE choke point (a res.json wrapper on the trips
 * router), for the same reason POD photo signing does: with two dozen
 * endpoints returning trips, patching call sites guarantees that one is missed,
 * and one missed site is the entire bug. Anything added to the router later is
 * covered without anyone remembering to think about it.
 */

/**
 * Field names stripped from any requestor-bound payload.
 *
 * Matched by NAME wherever they appear, at any depth — trip scalars, the nested
 * `truck` rate card, and per-stop scoring alike. Every name here is money-only,
 * so a blanket strip cannot remove something a requestor legitimately needs;
 * that is what makes name-matching safe rather than fragile.
 */
export const REQUESTOR_HIDDEN_MONEY_FIELDS: ReadonlySet<string> = new Set([
  // Trip: the proposal, the approved figure, and the locked-in rate snapshot.
  "incentive_earned",
  "incentive_final",
  "rate_used",
  "entitled_claim_weekday",
  "entitled_claim_offpeak",
  "daily_deduction_points",
  "deduction_applied",
  // Trip: the APPROVAL story. `incentive_override_reason` is required whenever
  // the approved figure differs from the proposal (POD-approval gate, 16 Jul
  // 2026), so it is free-text disciplinary judgement — "driver damaged pallet,
  // pay reduced" — sitting in the same payload as driver.name and driver.phone.
  // Redacting the amount and leaving the reason for it was the wrong half.
  // `incentive_approved_by` also hands an internal admin user id outward.
  "incentive_override_reason",
  "incentive_approved_at",
  "incentive_approved_by",
  // Trip: the tier that paid. Combined with was_repeat below it reconstructs
  // the scoring shape of every drop.
  "off_peak",
  // Truck (`truck: true` returns the full row) — the rate card itself, in both
  // its current and its STAGED form. The pending_* columns carry a rate edit
  // that takes effect next MYT day (Mr. Teh, 3 Jul 2026): on the day an edit is
  // staged they are the only place the new figure lives, so omitting them would
  // have leaked forward-looking commercial pricing — strictly worse than the
  // historical amount this function exists to hide.
  "pending_claim_weekday",
  "pending_claim_offpeak",
  "pending_deduction_points",
  "pending_rates_effective",
  // interplant_* do not exist on main yet; they arrive with the interplant pay
  // branch, and naming them now means that merge cannot silently re-open this.
  "interplant_claim_weekday",
  "interplant_claim_offpeak",
  // TripStop: per-stop scoring, and the finalize-time evidence written beside
  // it. `was_repeat` plus `zone_code` reconstructs full-points-vs-flat-1 for
  // every drop, which is the scoring rule itself.
  "points_awarded",
  "zone_points",
  "was_repeat",
]);

/** A value we should walk into: a plain object or array, never a Date/Decimal. */
function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-copy `body` with every hidden field removed.
 *
 * Non-plain objects (Prisma Decimal, Date, Buffer) are passed through by
 * reference rather than recursed into: they carry no nested payload fields, and
 * rebuilding them would destroy the prototype the serializer relies on — a
 * Decimal flattened to `{}` would corrupt every remaining amount on the way out.
 */
export function redactRequestorMoney<T>(body: T): T {
  if (Array.isArray(body)) {
    return body.map((item) => redactRequestorMoney(item)) as unknown as T;
  }
  if (!isPlainContainer(body)) return body;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (REQUESTOR_HIDDEN_MONEY_FIELDS.has(key)) continue;
    out[key] = redactRequestorMoney(value);
  }
  return out as unknown as T;
}

/**
 * The Express layer that applies the redaction, exported as a NAMED function so
 * a test can assert its POSITION in the middleware stack by identity.
 *
 * Position is the whole guarantee. The redaction only covers a router because it
 * is registered before it: anything mounted on /api/v1/trips ahead of this layer
 * is not covered, silently, with no behavioural test going red — the exceptions
 * router was in exactly that state and survived only because tripsRoutes
 * happened to be mounted first. A comment saying "keep this first" is not a
 * guarantee; tests/requestorMoneyMount.test.ts is.
 */
export function redactRequestorMoneyLayer(
  req: { user?: { role?: string } },
  res: { json: (body: unknown) => unknown },
  next: () => void
): void {
  const json = res.json.bind(res);
  res.json = (body: unknown) =>
    req.user?.role === "requestor" ? json(redactRequestorMoney(body)) : json(body);
  next();
}

/**
 * EVERY PREFIX THE LAYER MUST LEAD (SC7).
 *
 * ONE list, read by app.ts to mount and by tests/requestorMoneyMount to assert.
 * A second copy would be the bug this whole file exists to prevent: the mount
 * and the check must be the same fact, or they drift and the check keeps
 * passing. (reports.ts kept a private copy of an on-time predicate for the same
 * reason it felt harmless, and the e2e window chooser had a duplicate that put
 * a fixed bug straight back.)
 *
 * ── WHY THE PREFIXES WITH NO REQUESTOR ROUTE ARE HERE ANYWAY ────────────────
 *
 * Measured, today:
 *
 *   /trips        requestor-reachable. The original leak: 150 of a requestor's
 *                 275 own trips carried a non-null incentive_earned.
 *   /consignees   requestor-reachable — GET / has NO role guard (search), and
 *                 POST / is `requestor, admin` (self-add).
 *   /users        requestor-reachable via meRoutes (GET/PATCH /users/me),
 *                 mounted BEFORE the admin-only router on the same prefix.
 *   /trucks       NOT requestor-reachable today: every route is `admin, driver`
 *                 or behind `router.use(requireRole("admin"))`.
 *   /incentives   NOT requestor-reachable today: `/mine` is driver-only.
 *
 * The last two are here on purpose. The protection this file provides is
 * supposed to be STRUCTURAL — "anything added later is covered without anyone
 * remembering" — and that promise is empty on a prefix where the layer is
 * absent, because the day someone adds a requestor-readable truck route the
 * rate card ships with it. Mounting costs one line and a closure; the layer
 * no-ops for every non-requestor role, so nothing else changes.
 *
 * ⚠ NOT A SUBSTITUTE FOR ROLE GUARDS. This strips FIELDS. Whether a requestor
 * may call a route at all is still `requireRole`'s job, and a route that should
 * be admin-only is a bug this cannot see.
 */
export const REQUESTOR_REDACTED_PREFIXES = [
  "/api/v1/trips",
  "/api/v1/consignees",
  "/api/v1/users",
  "/api/v1/trucks",
  "/api/v1/incentives",
] as const;
