import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, DRIVER, REQUESTOR } from "./helpers/harness";
import { bookTrip, approveTrip, startTrip, arriveAndDeliver, firstRouteTypeId, userIdByPhone, DRIVERS } from "./helpers/flow";
import { REQUESTOR_HIDDEN_MONEY_FIELDS } from "../src/lib/requestorMoney";

/**
 * Driver pay must not reach a requestor, and must still reach the driver and
 * the admin.
 *
 * Measured on the real API before the fix: a requestor's own `GET /trips`
 * returned 150 trips carrying a non-null `incentive_earned` next to the named
 * driver, plus the truck's whole rate card (TRIP_INCLUDE does `truck: true`).
 * Ownership scoping was already correct — every trip was genuinely theirs — so
 * this is field-level exposure, not cross-tenant, and read-only. It is still
 * HR and commercial data a booking user has no business reading.
 *
 * The half that matters as much as the redaction is the CONTROL: a test that
 * only asserts "requestor sees no money" passes just as happily if the fields
 * vanished for everyone, which would silently break payroll and the driver's
 * earnings screen. Every case below therefore checks the same payload from a
 * privileged role in the same breath.
 */

const MONEY = [...REQUESTOR_HIDDEN_MONEY_FIELDS];

/** Every field name appearing anywhere in a payload, at any depth. */
function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, out);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value)) {
    out.add(k);
    keysDeep(v, out);
  }
  return out;
}

const moneyIn = (payload: unknown) => MONEY.filter((f) => keysDeep(payload).has(f));

describe("requestors never receive driver pay", () => {
  let requestor = "", admin = "", driver = "", driverId = "", rt = "";
  let tripId = "";

  beforeAll(async () => {
    [requestor, admin, driver] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN), loginAs(DRIVER)]);
    driverId = await userIdByPhone(DRIVER.phone);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  beforeEach(async () => {
    await resetDb();
    // An A2 drop, assigned and started: the trip now carries a rate snapshot
    // (entitled_claim_*, zone_points) even before any money is earned, so the
    // leak is present at this point and not only after delivery.
    const t = await bookTrip(requestor, ["A2"], rt);
    await approveTrip(admin, t.id, driverId, DRIVERS.PND.plate);
    await startTrip(driver, t.id);
    tripId = t.id;
  });

  it("GET /trips — stripped for the requestor, intact for driver and admin", async () => {
    const asRequestor = await api().get("/api/v1/trips").set(auth(requestor));
    expect(asRequestor.status).toBe(200);
    expect(asRequestor.body.length).toBeGreaterThan(0); // the trip IS theirs to see
    expect(moneyIn(asRequestor.body)).toEqual([]);

    // CONTROL — the fields still exist for the roles entitled to them, so this
    // suite fails if the redaction is applied too widely.
    const asDriver = await api().get("/api/v1/trips").set(auth(driver));
    const asAdmin = await api().get("/api/v1/trips").set(auth(admin));
    expect(moneyIn(asDriver.body).length).toBeGreaterThan(0);
    expect(moneyIn(asAdmin.body).length).toBeGreaterThan(0);
  });

  it("GET /trips/:id — the rate snapshot and the truck rate card are both gone", async () => {
    const one = await api().get(`/api/v1/trips/${tripId}`).set(auth(requestor));
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(tripId);
    expect(moneyIn(one.body)).toEqual([]);

    // Specifically the nested surfaces, which a top-level-only strip would miss:
    // `truck: true` returns the whole row, and scoring lives on each stop.
    expect(one.body.truck).toBeTruthy();
    expect(one.body.truck.plate_number ?? one.body.truck.plate).toBeTruthy(); // still a usable truck
    expect(moneyIn(one.body.truck)).toEqual([]);
    expect(one.body.stops.length).toBeGreaterThan(0);
    expect(moneyIn(one.body.stops)).toEqual([]);

    const adminOne = await api().get(`/api/v1/trips/${tripId}`).set(auth(admin));
    expect(moneyIn(adminOne.body).length).toBeGreaterThan(0);
    expect(moneyIn(adminOne.body.truck).length).toBeGreaterThan(0);
  });

  it("survives the whole lifecycle — a DELIVERED trip still leaks nothing", async () => {
    const stop = (await prisma.tripStop.findFirstOrThrow({ where: { trip_id: tripId } })).id;
    // arriveAndDeliver satisfies the POD gate by writing pod_photo directly —
    // the shared pattern here, since the real upload route posts to Cloudinary
    // and rejects synthetic bytes as "Invalid image file".
    await arriveAndDeliver(driver, tripId, stop);

    // Money now genuinely EXISTS on this trip — this is the state the original
    // measurement caught (pending_approval, incentive_earned populated).
    const persisted = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(persisted.incentive_earned).not.toBeNull();

    const asRequestor = await api().get(`/api/v1/trips/${tripId}`).set(auth(requestor));
    expect(asRequestor.body.status).toBe("pending_approval"); // they still see progress
    expect(moneyIn(asRequestor.body)).toEqual([]);

    const asAdmin = await api().get(`/api/v1/trips/${tripId}`).set(auth(admin));
    expect(asAdmin.body.incentive_earned).not.toBeNull();
  });

  it("redaction removes ONLY money — the trip is still fully usable to its requestor", async () => {
    const one = (await api().get(`/api/v1/trips/${tripId}`).set(auth(requestor))).body;
    // Everything a requestor legitimately needs must survive the strip.
    for (const field of ["id", "ticket_number", "status", "pickup_datetime", "stops", "cargo_details", "driver", "truck", "route_type"]) {
      expect(one[field], `requestor lost ${field}`).toBeDefined();
    }
    expect(one.driver.name).toBeTruthy();      // who is bringing it — legitimate
    expect(one.stops[0].consignee).toBeTruthy(); // where it is going — legitimate
  });
});
