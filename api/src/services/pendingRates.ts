import { mytDateKey } from "./incentiveEngine";

/**
 * Next-day rate cutoff (client rule, Mr. Teh 3 Jul 2026): "running trips keep
 * the old rate; a new rate takes effect the NEXT day, not immediately."
 *
 * A rate edit (admin rate editor or reset-to-spec) never touches the Truck's
 * live claim columns directly — it is staged in the pending_* columns with
 * pending_rates_effective = tomorrow (MYT). Two consumers make it real:
 *   1. effectiveTruckRates() — the money path. Both assignment snapshots
 *      (manual approve + auto-dispatch) and the legacy finalization fallback
 *      read the rates THROUGH this merge, so an assignment on/after the
 *      effective day pays the new rate even before the sweep has folded it.
 *   2. The maturation sweep (startRateMaturation) — display freshness. Folds
 *      matured pending values into the base columns and clears the staging
 *      fields, so every read surface (GET /trucks, dispatch panel, mobile)
 *      shows the live rate without needing the merge.
 *
 * The decision pieces are pure (no DB, no Date.now()) for unit tests; only
 * the sweep talks to Prisma, through a minimal client interface.
 */

// Prisma Decimal (or a plain number in tests) — anything Number() can read.
type DecimalLike = number | { toString(): string };

/** The rate fields governed by the cutoff (max_pallets is capacity, NOT a rate — it stays immediate). */
export interface PendingRateFields {
  pending_claim_weekday: DecimalLike | null;
  pending_claim_offpeak: DecimalLike | null;
  pending_deduction_points: number | null;
  pending_rates_effective: string | null; // MYT "YYYY-MM-DD"
}

export interface LiveRateFields {
  entitled_claim_weekday: DecimalLike;
  entitled_claim_offpeak: DecimalLike;
  daily_deduction_points: number;
}

/** The MYT day AFTER the instant `now` — the earliest day a rate edit may take effect. MYT has no DST, so +24h is exact. */
export function nextMytDayKey(now: Date): string {
  return mytDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
}

/** True once the staged rates' effective MYT day has arrived at instant `at`. String compare works because both are "YYYY-MM-DD". */
export function pendingMatured(
  truck: Pick<PendingRateFields, "pending_rates_effective">,
  at: Date
): boolean {
  return (
    truck.pending_rates_effective !== null &&
    truck.pending_rates_effective <= mytDateKey(at)
  );
}

/**
 * The truck's rates EFFECTIVE at instant `at`: the staged pending values once
 * their day has arrived, else the live base values. This is what assignment
 * snapshots must read — an edit made today is invisible to today's
 * assignments and binding from tomorrow 00:00 MYT, sweep or no sweep.
 */
export function effectiveTruckRates<T extends LiveRateFields & Partial<PendingRateFields>>(
  truck: T,
  at: Date
): LiveRateFields {
  const staged = {
    pending_claim_weekday: truck.pending_claim_weekday ?? null,
    pending_claim_offpeak: truck.pending_claim_offpeak ?? null,
    pending_deduction_points: truck.pending_deduction_points ?? null,
    pending_rates_effective: truck.pending_rates_effective ?? null,
  };
  if (!pendingMatured(staged, at)) {
    return {
      entitled_claim_weekday: truck.entitled_claim_weekday,
      entitled_claim_offpeak: truck.entitled_claim_offpeak,
      daily_deduction_points: truck.daily_deduction_points,
    };
  }
  // A pending edit stores every rate field it changes; a null pending field
  // means "unchanged" and keeps the base value.
  return {
    entitled_claim_weekday: staged.pending_claim_weekday ?? truck.entitled_claim_weekday,
    entitled_claim_offpeak: staged.pending_claim_offpeak ?? truck.entitled_claim_offpeak,
    daily_deduction_points: staged.pending_deduction_points ?? truck.daily_deduction_points,
  };
}

// ── Maturation sweep ──────────────────────────────────────────────────────

// Minimal slice of the Prisma client the sweep needs (testable without a DB).
export interface RateMaturationClient {
  truck: {
    findMany(args: {
      where: { pending_rates_effective: { not: null; lte: string } };
    }): Promise<
      ({ plate: string } & LiveRateFields & PendingRateFields)[]
    >;
    update(args: {
      where: { plate: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * Fold every truck's matured pending rates into the base columns and clear
 * the staging fields. No audit row here — AuditLog rows require a real user,
 * and the traceable action is the STAGING edit, whose audit row (written by
 * the admin who made it) already records the effective date. Returns the
 * plates folded (for logging/tests).
 */
export async function applyMaturedPendingRates(
  client: RateMaturationClient,
  now: Date
): Promise<string[]> {
  const matured = await client.truck.findMany({
    where: { pending_rates_effective: { not: null, lte: mytDateKey(now) } },
  });

  for (const t of matured) {
    const effective = effectiveTruckRates(t, now);
    await client.truck.update({
      where: { plate: t.plate },
      data: {
        entitled_claim_weekday: effective.entitled_claim_weekday,
        entitled_claim_offpeak: effective.entitled_claim_offpeak,
        daily_deduction_points: effective.daily_deduction_points,
        pending_claim_weekday: null,
        pending_claim_offpeak: null,
        pending_deduction_points: null,
        pending_rates_effective: null,
      },
    });
  }

  return matured.map((t) => t.plate);
}

/**
 * Start the background maturation sweep: run once on boot (a restart just
 * after midnight must not miss the fold), then once a minute. The
 * effectiveTruckRates merge in the assignment path keeps the money exact in
 * the window before a tick; this sweep only keeps the DISPLAYED base columns
 * fresh. Called once from index.ts.
 */
export function startRateMaturation(client: RateMaturationClient): void {
  const run = () =>
    applyMaturedPendingRates(client, new Date())
      .then((plates) => {
        if (plates.length > 0) {
          console.log(`Pending rates took effect for: ${plates.join(", ")}`);
        }
      })
      .catch((err) => console.error("Rate maturation sweep failed:", err));
  run();
  setInterval(run, 60 * 1000);
}
