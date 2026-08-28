/**
 * THE trip payload shape — one definition, used by routes/trips and by
 * services/dispatchEngine.
 *
 * These two were duplicated literals that happened to match. They must not
 * merely match, they must be the SAME type: an auto-dispatch result is returned
 * to the client in place of the route's payload, so TypeScript has to see them
 * as one shape or the assignment fails ("two different types with this name
 * exist"). Extracted when the stop include grew `exceptions` and the copies
 * drifted for the first time.
 *
 * `exceptions` is on stops so a CLIENT can tell a SETTLED stop (reached, admin
 * verified + resumed, paid under R3 Q11(a) — nothing left for the driver to do)
 * from an outstanding one. Every "next stop" picker in the driver app tests
 * `status !== "delivered"`, which without this keeps pointing at a stop the
 * admin has already closed and paid. Minimal select: exactly the three fields
 * the settled predicate reads (services/undeliveredPay).
 */
export const TRIP_INCLUDE = {
  requestor: { select: { id: true, name: true, phone: true } },
  driver: { select: { id: true, name: true, phone: true } },
  truck: true,
  route_type: true,
  stops: {
    include: {
      consignee: true,
      exceptions: {
        select: {
          current_state: true,
          resolution: true,
          actions: { where: { type: "verify" as const }, select: { type: true }, take: 1 },
        },
      },
    },
    orderBy: { sequence: "asc" as const },
  },
  // Item 3 multi-pickup: minimal select on the nested plant (name only, same
  // as the requestor's own destination consignee names elsewhere) so every
  // screen that already renders cargo_details can show which plant a line
  // was picked up from without a second lookup.
  cargo_details: { include: { pickup_consignee: { select: { id: true, company_name: true } } } },
  documents: { orderBy: { uploaded_at: "desc" as const } },
};
