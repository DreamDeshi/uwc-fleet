import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
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
  /**
   * FAIL-CLOSED COVERAGE.
   *
   * Every other case here derives its oracle from REQUESTOR_HIDDEN_MONEY_FIELDS,
   * which makes them tautologies over my own constant: they prove "the names I
   * chose to strip are stripped". Reverting the middleware turns them red — but
   * ADDING a money column leaves them green forever, so the interplant_* names
   * listed "so that merge cannot silently re-open this" were enforced by nothing
   * except someone remembering.
   *
   * This case inverts the direction: every scalar a requestor receives must
   * appear on a hand-written allow-list, so an unclassified column fails until a
   * human decides.
   *
   * Classification comes from the Prisma DMMF, NOT from `typeof`. The first cut
   * skipped anything where `typeof value === "object"`, meaning to skip
   * relations — but `typeof [] === "object"` and `typeof {json} === "object"`,
   * so it also skipped every array and Json column. It shipped green with a live
   * counter-example already in the payload: `truck.priority_zones` (String[]) is
   * sent to requestors and was on nobody's list. A Decimal[] rate matrix or a
   * Json breakdown — exactly what the interplant branch might add — would have
   * sailed straight through the guard written to catch it. The DMMF knows
   * `priority_zones` is `kind: "scalar", isList: true`; `typeof` cannot.
   */
  it("fail-closed: every scalar a requestor receives is explicitly allowed", async () => {
    const scalarsOf = (model: string): Set<string> => {
      const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model);
      if (!m) throw new Error(`No such model in the schema: ${model}`);
      return new Set(m.fields.filter((f) => f.kind === "scalar" || f.kind === "enum").map((f) => f.name));
    };

    // Hand-written, one entry per real column, so widening it is a conscious act
    // visible in review. The stale-entry assertion below forbids speculative
    // names: a list padded with columns nobody has designed is a blank cheque,
    // and would have pre-allowed `pod_approved_at` while we deliberately hid the
    // real approval timestamp `incentive_approved_at`.
    const ALLOWED: Record<string, Set<string>> = {
      Trip: new Set([
        "id", "ticket_number", "requestor_id", "driver_id", "truck_plate",
        "route_type_id", "status", "pickup_datetime", "is_external",
        "rejection_reason", "pending_alert_sent", "auto_dispatch_failed",
        "auto_dispatch_note", "auto_dispatch_paused", "client_request_id",
        "open_exception_id", "created_at",
      ]),
      Truck: new Set([
        "plate", "type", "max_pallets", "priority_zones",
        "operating_hours_start", "operating_hours_end",
        "insurance_expiry", "permit_expiry", "road_tax_expiry",
        "is_available", "retired_at",
      ]),
      TripStop: new Set([
        "id", "trip_id", "sequence", "consignee_id", "status",
        "arrived_at", "delivered_at", "pod_photo", "pod_public_id",
        "pod_uploaded_at", "pod_captured_client_at", "do_uploaded",
        "k2_photo", "k2_public_id", "k2_form_ack", "zone_code",
      ]),
      Consignee: new Set([
        "id", "company_name", "vendor_code", "contact_person", "phone",
        "address_1", "address_2", "area", "state", "postal_code", "zone_code",
        "is_active", "created_by", "latitude", "longitude", "geocode_match_type",
      ]),
      CargoDetail: new Set([
        "id", "trip_id", "pallet_type", "quantity", "cartons",
        "width_ft", "length_ft", "custom_size", "estimated_pallets", "remark",
      ]),
      TripDocument: new Set([
        "id", "trip_id", "type", "file_url", "public_id", "resource_type",
        "format", "uploaded_at",
      ]),
      RouteType: new Set(["id", "name"]),
      TripStatusHistory: new Set(["id", "trip_id", "event", "stop_id", "actor_id", "note", "created_at"]),
    };

    // The first cut swept 3 of the 9 models a requestor actually receives.
    const one = (await api().get(`/api/v1/trips/${tripId}`).set(auth(requestor))).body;
    const SURFACES: { model: string; value: unknown }[] = [
      { model: "Trip", value: one },
      { model: "Truck", value: one.truck },
      { model: "TripStop", value: one.stops?.[0] },
      { model: "Consignee", value: one.stops?.[0]?.consignee },
      { model: "CargoDetail", value: one.cargo_details?.[0] },
      { model: "TripDocument", value: one.documents?.[0] },
      { model: "RouteType", value: one.route_type },
      { model: "TripStatusHistory", value: one.status_history?.[0] },
    ];

    const unexpected: string[] = [];
    for (const { model, value } of SURFACES) {
      if (!value || typeof value !== "object") continue;
      const scalars = scalarsOf(model);
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!scalars.has(key)) continue; // a relation — it has its own entry above
        if (!ALLOWED[model].has(key)) unexpected.push(`${model}.${key}`);
      }
    }
    expect(
      unexpected,
      [
        "",
        "A requestor is receiving field(s) nobody has classified:",
        ...unexpected.map((f) => `  ${f}`),
        "",
        "If it is money or rate data, add it to REQUESTOR_HIDDEN_MONEY_FIELDS.",
        "If a requestor legitimately needs it, add it to ALLOWED in this test.",
        "",
      ].join("\n")
    ).toEqual([]);

    // No blank cheques: every allow-list entry must be a column that exists.
    const stale: string[] = [];
    for (const [model, fields] of Object.entries(ALLOWED)) {
      const scalars = scalarsOf(model);
      for (const f of fields) if (!scalars.has(f)) stale.push(`${model}.${f}`);
    }
    expect(
      stale,
      [
        "",
        "ALLOWED names column(s) that do not exist in the schema:",
        ...stale.map((f) => `  ${f}`),
        "",
        "Speculative entries pre-approve fields nobody has designed. Remove them.",
        "",
      ].join("\n")
    ).toEqual([]);
  });

});
