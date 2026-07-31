/**
 * Stop ORDER on a multi-stop booking — the one place it is decided.
 *
 * `sequence` looks like a display detail. It is not. Three things read it and
 * each assumes it is a clean 1..N with no ties:
 *
 *   - services/dispatchEngine `primaryZone` takes stops[0] from an
 *     `orderBy: { sequence: "asc" }` read and calls it THE zone of the order.
 *     That zone drives filterA1A2Eligible, which locks a Taiping/Ipoh run to
 *     PND 1888 — and which truck runs the trip sets the rate per point
 *     (PND 11/13 vs PRH 9/9 vs PPE 10/12). A tie makes that pick whichever row
 *     Postgres happened to return first.
 *   - The POD upload derives its Cloudinary asset id from the sequence:
 *     `${ticket_number}-stop-${sequence}`. Two stops sharing a sequence share
 *     an asset id, so the second driver's proof-of-delivery SILENTLY
 *     OVERWRITES the first — on the photo that gates delivery and settles
 *     approval disputes.
 *   - tripTimeline and every stop rail sort by it.
 *
 * The API accepted whatever a client sent: `sequence` was
 * `z.number().int().min(1).optional()` with no cross-stop check, so
 * `[{c1,seq:1},{c2,seq:1}]` and `[{c1,seq:9},{c2,seq:3}]` were both stored
 * verbatim. The requestor app has never sent a sequence at all (it relies on
 * array order), which is why nothing has gone wrong yet — but the contract is
 * the API, not one client.
 *
 * NORMALISE rather than reject. A 400 would break any client that is sending
 * something reasonable today, and there is nothing to gain by refusing: the
 * client's INTENT is an order, and an order is exactly what this recovers. The
 * result is always contiguous, unique and 1-based, whatever came in.
 */

export interface IncomingStop {
  consignee_id: string;
  sequence?: number | null;
}

export interface OrderedStop {
  consignee_id: string;
  sequence: number;
}

/**
 * Put the stops in the order the client asked for, then renumber 1..N.
 *
 * A missing sequence falls back to the stop's ARRAY POSITION, which is the
 * behaviour every existing caller relied on (`s.sequence ?? idx + 1`) and what
 * the requestor app depends on. Ties keep array order — `Array.prototype.sort`
 * is stable — so a client that half-fills sequences gets a defined answer
 * rather than a database-dependent one.
 */
export function normalizeStopSequences<T extends IncomingStop>(
  stops: T[]
): (T & OrderedStop)[] {
  return stops
    .map((s, idx) => ({ stop: s, key: s.sequence ?? idx + 1 }))
    .sort((a, b) => a.key - b.key)
    .map(({ stop }, i) => ({ ...stop, sequence: i + 1 }));
}
