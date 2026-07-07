/**
 * Keyset (cursor) pagination for GET /trips — QUERY PATH ONLY.
 *
 * The admin board polls the trip list every 20s with the full include, so it
 * must never re-download an ever-growing trial history. The interim fix was a
 * newest-N window (`limit`, cb6bd55); this module is the noted follow-up:
 * true cursor pagination, so the board polls a small live head and pages the
 * older history on demand.
 *
 * Why KEYSET and not offset: an offset page shifts every time a new booking
 * is inserted at the head (page 2 at offset 150 re-shows rows that just got
 * pushed down — duplicates — or skips rows when trips are removed). A keyset
 * cursor pins the page boundary to the (created_at, id) of the last row the
 * client saw. Both columns are immutable after insert and new rows only ever
 * enter at the head, so a page's membership can never shift underneath the
 * client: no overlap, no gaps, regardless of inserts between page fetches.
 *
 * Ordering is (created_at DESC, id DESC). The id tiebreak makes the order
 * total — bulk-created trips can share a created_at millisecond, and without
 * a tiebreak two rows on the boundary could swap across a page edge.
 *
 * The cursor is OPAQUE to clients: base64url of {t: epoch-ms, i: trip id}.
 * created_at is stored as timestamp(3) (millisecond precision), so epoch
 * milliseconds round-trip it exactly. A cursor that fails to decode is a
 * hard 400 (INVALID_CURSOR), never a silent fall-back to page 1 — silently
 * restarting would hand the client duplicate rows.
 *
 * Modes (one endpoint, three callers):
 *  - legacy list  — no cursor/page_size params: plain array, optional `limit`
 *    newest-N cap (absent/invalid = unlimited). Mobile's role-scoped lists
 *    and the admin Dashboard/MobileLite/Reports windows stay on this,
 *    byte-identical to before.
 *  - paged        — `page_size` and/or `cursor` present: {items, next_cursor,
 *    total} envelope. `limit` is ignored in this mode.
 */

import type { Prisma } from "@prisma/client";

/** Hard server cap shared by the legacy `limit` and paged `page_size`. */
export const TRIP_LIST_MAX_TAKE = 500;
/** Page size when the client asks for paged mode without a usable size. */
export const TRIP_PAGE_SIZE_DEFAULT = 100;

/** The decoded page boundary: the (created_at, id) of the last row served. */
export interface TripCursor {
  created_at: Date;
  id: string;
}

// Concrete shape (rather than the wide Prisma input type) so tests can assert
// the exact semantics; structurally assignable to Prisma.TripWhereInput.
export interface TripKeysetWhere {
  OR: [
    { created_at: { lt: Date } },
    { created_at: Date; id: { lt: string } },
  ];
}

/**
 * Stable list order used by BOTH modes. Adding the id tiebreak to the legacy
 * mode only changes the relative order of rows created in the same
 * millisecond — previously unspecified — so existing callers see the same
 * newest-first list, now deterministic.
 */
export const TRIP_LIST_ORDER: readonly [
  { created_at: "desc" },
  { id: "desc" },
] = [{ created_at: "desc" }, { id: "desc" }];

/** "Everything strictly older than the cursor row" under TRIP_LIST_ORDER. */
export function tripKeysetWhere(cursor: TripCursor): TripKeysetWhere {
  return {
    OR: [
      { created_at: { lt: cursor.created_at } },
      { created_at: cursor.created_at, id: { lt: cursor.id } },
    ],
  };
}

export function encodeTripCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ t: row.created_at.getTime(), i: row.id })
  ).toString("base64url");
}

/** null = malformed/tampered (caller must 400, never treat as page 1). */
export function decodeTripCursor(raw: string): TripCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { t, i } = parsed as { t?: unknown; i?: unknown };
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (typeof i !== "string" || i.length === 0) return null;
  return { created_at: new Date(t), id: i };
}

export type TripListQuery =
  | { mode: "legacy"; limit: number | undefined }
  | { mode: "paged"; pageSize: number; cursor: TripCursor | null }
  | { mode: "invalid_cursor" };

/**
 * Decide the list mode from the raw query params (values as express gives
 * them — anything non-string is treated as absent).
 *
 * Paged mode triggers on the PRESENCE of `cursor` or `page_size`; an empty
 * cursor string means "first page" (axios serialises empty params), and a
 * malformed `page_size` falls back to the default size (mirroring the
 * documented lenient `limit` parse) — but a non-empty cursor that fails to
 * decode is `invalid_cursor`, because serving page 1 against a corrupt
 * cursor would duplicate rows on the client.
 */
export function parseTripListQuery(query: {
  limit?: unknown;
  cursor?: unknown;
  page_size?: unknown;
}): TripListQuery {
  const rawCursor = typeof query.cursor === "string" ? query.cursor : "";
  const rawPageSize = typeof query.page_size === "string" ? query.page_size : undefined;

  if (rawCursor === "" && rawPageSize === undefined) {
    // Legacy: optional newest-N window, absent/invalid = unlimited (cb6bd55).
    const rawLimit = typeof query.limit === "string" ? Number(query.limit) : NaN;
    const limit =
      Number.isInteger(rawLimit) && rawLimit >= 1
        ? Math.min(rawLimit, TRIP_LIST_MAX_TAKE)
        : undefined;
    return { mode: "legacy", limit };
  }

  const parsedSize = rawPageSize === undefined ? NaN : Number(rawPageSize);
  const pageSize =
    Number.isInteger(parsedSize) && parsedSize >= 1
      ? Math.min(parsedSize, TRIP_LIST_MAX_TAKE)
      : TRIP_PAGE_SIZE_DEFAULT;

  if (rawCursor === "") return { mode: "paged", pageSize, cursor: null };
  const cursor = decodeTripCursor(rawCursor);
  if (cursor === null) return { mode: "invalid_cursor" };
  return { mode: "paged", pageSize, cursor };
}

/**
 * Turn a `pageSize + 1` fetch into one page: the extra row (if present) only
 * proves another page exists — it is dropped from the payload and the cursor
 * points at the last row actually served.
 */
export function buildTripPage<T extends { created_at: Date; id: string }>(
  rows: T[],
  pageSize: number
): { items: T[]; next_cursor: string | null } {
  if (rows.length <= pageSize) return { items: rows, next_cursor: null };
  const items = rows.slice(0, pageSize);
  return { items, next_cursor: encodeTripCursor(items[items.length - 1]) };
}

// Compile-time proof the concrete shapes stay valid Prisma inputs.
const _whereAssignable: Prisma.TripWhereInput = {} as TripKeysetWhere;
void _whereAssignable;
const _orderAssignable: Prisma.TripOrderByWithRelationInput[] = [
  ...TRIP_LIST_ORDER,
];
void _orderAssignable;
