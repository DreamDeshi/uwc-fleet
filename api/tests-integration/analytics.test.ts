import { beforeAll, describe, expect, it } from "vitest";
import { api, auth, loginAs, prisma, REQUESTOR, resetDb } from "./helpers/harness";
import { bookTrip, firstRouteTypeId, userIdByPhone } from "./helpers/flow";

/**
 * GET /analytics/mine — the requestor's Insights screen.
 *
 * This route had NO test of any kind (unit or integration) until now, which is
 * how it broke silently: when item 9 added `pending_approval`, the
 * status_breakdown switch had no arm for it, so such a trip was counted in NO
 * bucket — while a comment above the switch asserted the five buckets "always
 * sum to the requestor's total trips".
 *
 * The sum is load-bearing, not decorative: the mobile AnalyticsScreen derives
 * its OWN total by adding these five, so an uncounted status shrinks the
 * denominator and a requestor whose only trips awaited approval saw the "No
 * data yet" empty state despite having trips.
 */
describe("GET /analytics/mine — status_breakdown sum contract", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("counts a pending_approval trip as completed, and the buckets sum to the real total", async () => {
    const token = await loginAs(REQUESTOR);
    const routeTypeId = await firstRouteTypeId(token);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const trip = await bookTrip(token, ["P1"], routeTypeId);
      ids.push(trip.id);
    }
    // One of each shape that matters: approved-and-paid, delivered-awaiting-
    // approval, and still-pending.
    await prisma.trip.update({ where: { id: ids[0] }, data: { status: "completed" } });
    await prisma.trip.update({ where: { id: ids[1] }, data: { status: "pending_approval" } });

    const res = await api().get("/api/v1/analytics/mine").set(auth(token));
    expect(res.status).toBe(200);

    const sb = res.body.status_breakdown;
    // pending_approval folds into completed — the goods arrived; only the
    // driver's incentive is outstanding, which is not the requestor's concern.
    expect(sb.completed).toBe(2);
    expect(sb.pending).toBe(1);

    // THE CONTRACT: what the client sums must equal the requestor's real trips.
    const clientDerivedTotal =
      sb.completed + sb.pending + sb.assigned + sb.in_progress + sb.cancelled;
    const requestorId = await userIdByPhone(REQUESTOR.phone);
    const actual = await prisma.trip.count({ where: { requestor_id: requestorId } });
    expect(clientDerivedTotal).toBe(actual);
  });

  it("is admin-forbidden — /mine is the requestor's own data", async () => {
    const { ADMIN } = await import("./helpers/harness");
    const adminToken = await loginAs(ADMIN);
    const res = await api().get("/api/v1/analytics/mine").set(auth(adminToken));
    expect(res.status).toBe(403);
  });
});
