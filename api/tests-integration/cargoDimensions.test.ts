import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { api, auth, prisma, resetDb, loginAs, ADMIN, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, ensureConsigneeInZone, futurePickupIso, autoDispatch, type CargoLine } from "./helpers/flow";

// Q10 (Mr. Teh R1 2026-07-24) cargo behaviour, end-to-end through Postgres. This
// touches ordinary booking UI + the manual-dispatch routing ONLY — no incentive,
// rate or payment logic changes.

let requestor = "", admin = "", rt = "";

/** RAW booking (so 400 cases can be asserted). One stop in P1. */
async function bookRaw(cargo: CargoLine[]) {
  const c = await ensureConsigneeInZone("P1");
  return api().post("/api/v1/trips").set(auth(requestor)).send({
    route_type_id: rt,
    pickup_datetime: futurePickupIso(),
    stops: [{ consignee_id: c.id, sequence: 1 }],
    cargo_details: cargo,
  });
}
async function book(cargo: CargoLine[]) {
  const res = await bookRaw(cargo);
  expect(res.status, res.text).toBe(201);
  return res.body as { id: string; cargo_details: Array<Record<string, unknown>> };
}
const cargoOf = (tripId: string) => prisma.cargoDetail.findMany({ where: { trip_id: tripId }, orderBy: { pallet_type: "asc" } });

describe("Q10 — Box / Crate / Rack / structured Custom cargo", () => {
  beforeAll(async () => {
    [requestor, admin] = await Promise.all([loginAs(REQUESTOR), loginAs(ADMIN)]);
    rt = await firstRouteTypeId(requestor);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  beforeEach(async () => { await resetDb(); });

  it("Box: count only, no dimensions — an estimate can NOT let it auto-dispatch", async () => {
    // Dimensions are rejected for a box.
    expect((await bookRaw([{ pallet_type: "box", quantity: 3, width_ft: 2, length_ft: 2 }])).status).toBe(400);

    // Box with an estimate still routes to MANUAL assignment (never auto-dispatch).
    const trip = await book([{ pallet_type: "box", quantity: 5, estimated_pallets: 2 } as CargoLine]);
    const res = await autoDispatch(admin, trip.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NO_TRUCK_AVAILABLE");
    const after = (await prisma.trip.findUnique({ where: { id: trip.id } }))!;
    expect(after.status).toBe("pending");
    expect(after.truck_plate).toBeNull();
    expect(after.auto_dispatch_failed).toBe(true);
  });

  it("Crate/Rack: structured dimensions stored + canonical W × L ft; always manual", async () => {
    const trip = await book([
      { pallet_type: "crate", quantity: 1, width_ft: 4, length_ft: 3 },
      { pallet_type: "rack", quantity: 2, width_ft: 5, length_ft: 5 },
    ]);
    const rows = await cargoOf(trip.id);
    const crate = rows.find((r) => r.pallet_type === "crate")!;
    const rack = rows.find((r) => r.pallet_type === "rack")!;
    expect(crate.width_ft).toBe(4);
    expect(crate.length_ft).toBe(3);
    expect(crate.custom_size).toBe("4 × 3 ft");
    expect(rack.custom_size).toBe("5 × 5 ft");
    // Always manual.
    expect((await autoDispatch(admin, trip.id)).status).toBe(409);
  });

  it("Custom: structured width × length required + validated; free-text rejected on a NEW booking", async () => {
    // Malformed dimensions rejected.
    expect((await bookRaw([{ pallet_type: "custom", quantity: 1, width_ft: 0, length_ft: 3 }])).status).toBe(400);
    expect((await bookRaw([{ pallet_type: "custom", quantity: 1, width_ft: -2, length_ft: 3 }])).status).toBe(400);
    expect((await bookRaw([{ pallet_type: "custom", quantity: 1, width_ft: 4 }])).status).toBe(400); // half dims
    expect((await bookRaw([{ pallet_type: "custom", quantity: 1, custom_size: "big" }])).status).toBe(400); // free-text
    // Structured custom is accepted + canonicalised.
    const trip = await book([{ pallet_type: "custom", quantity: 1, width_ft: 6.5, length_ft: 4 }]);
    const [row] = await cargoOf(trip.id);
    expect(row.width_ft).toBe(6.5);
    expect(row.custom_size).toBe("6.5 × 4 ft");
  });

  it("edit round-trip: changing crate dimensions updates the stored + canonical values", async () => {
    const trip = await book([{ pallet_type: "crate", quantity: 1, width_ft: 4, length_ft: 3 }]);
    const c = (await ensureConsigneeInZone("P1"));
    const res = await api().patch(`/api/v1/trips/${trip.id}`).set(auth(requestor)).send({
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: c.id, sequence: 1 }],
      cargo_details: [{ pallet_type: "crate", quantity: 2, width_ft: 5, length_ft: 5 }],
    });
    expect(res.status, res.text).toBe(200);
    const [row] = await cargoOf(trip.id);
    expect(row.quantity).toBe(2);
    expect(row.width_ft).toBe(5);
    expect(row.custom_size).toBe("5 × 5 ft");
  });

  it("legacy free-text custom cargo survives an unrelated edit (pickup only) — not deleted or rewritten", async () => {
    // Seed a LEGACY custom line directly (free-text size, no structured dims).
    const c = await ensureConsigneeInZone("P1");
    const t = await prisma.trip.create({
      data: {
        ticket_number: `TKT-LEGACY-${Date.now()}`,
        requestor_id: (await prisma.user.findUnique({ where: { phone: REQUESTOR.phone } }))!.id,
        route_type_id: rt,
        pickup_datetime: new Date(futurePickupIso()),
        status: "pending",
        stops: { create: [{ consignee_id: c.id, sequence: 1 }] },
        cargo_details: { create: [{ pallet_type: "custom", quantity: 1, custom_size: "irregular steel frame" }] },
      },
    });
    // Unrelated edit: omit cargo_details entirely (change nothing about cargo).
    const res = await api().patch(`/api/v1/trips/${t.id}`).set(auth(requestor)).send({
      route_type_id: rt,
      pickup_datetime: futurePickupIso(),
      stops: [{ consignee_id: c.id, sequence: 1 }],
    });
    expect(res.status, res.text).toBe(200);
    const [row] = await cargoOf(t.id);
    expect(row.custom_size).toBe("irregular steel frame"); // preserved verbatim
    expect(row.width_ft).toBeNull();
  });

  it("mixed payload preserves every line: standard pallet + Box + Crate + structured Custom", async () => {
    const trip = await book([
      { pallet_type: "4×4", quantity: 2 },
      { pallet_type: "box", quantity: 4 },
      { pallet_type: "crate", quantity: 1, width_ft: 4, length_ft: 3 },
      { pallet_type: "custom", quantity: 1, width_ft: 7, length_ft: 2 },
    ]);
    const rows = await cargoOf(trip.id);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.pallet_type === "4×4")!.quantity).toBe(2);
    expect(rows.find((r) => r.pallet_type === "box")!.width_ft).toBeNull();
    expect(rows.find((r) => r.pallet_type === "crate")!.custom_size).toBe("4 × 3 ft");
    expect(rows.find((r) => r.pallet_type === "custom")!.custom_size).toBe("7 × 2 ft");
  });

  it("still rejects a NEW deprecated 1×1 / 1×2 booking", async () => {
    expect((await bookRaw([{ pallet_type: "1×1", quantity: 1 }])).status).toBe(400);
    expect((await bookRaw([{ pallet_type: "1×2", quantity: 1 }])).status).toBe(400);
  });
});
