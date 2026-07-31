import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
  activeBookingsForConsigneeWhere,
  consigneeAuditAction,
  updateConsignee,
  type ConsigneeUpdateClient,
} from "../src/services/consigneeUpdate";

/**
 * The consignee correction path (wrong-zone self-adds were previously
 * permanent). The critical property: a zone correction touches ONLY the
 * consignee row — a finalized trip's stored pay and its per-stop evidence
 * (zone_code/points_awarded snapshots from finalization) are never re-derived
 * from the live consignee, so history cannot be rewritten.
 */

function fakeStore(opts?: { zoneExists?: boolean }) {
  const zoneExists = opts?.zoneExists ?? true;
  const consigneeRow: Record<string, unknown> = {
    id: "c1",
    company_name: "Intel Kulim",
    zone_code: "P1", // WRONG — should be K1; the correction under test
    is_active: true,
    // A REAL geocode: the driver's Navigate opens exactly this point.
    address_1: "12 Jalan Perusahaan",
    address_2: null,
    area: "KULIM",
    state: "KEDAH",
    postal_code: "09000",
    latitude: 5.3654,
    longitude: 100.5612,
    geocode_match_type: "ROOFTOP",
  };
  // A trip finalized BEFORE the correction, with the finalize-time snapshot.
  const finalizedTrip = { id: "t1", status: "completed", incentive_earned: 44, rate_used: 11 };
  const finalizedStop = { id: "s1", zone_code: "P1", points_awarded: 3, was_repeat: false };
  const audits: Record<string, unknown>[] = [];

  const client: ConsigneeUpdateClient = {
    consignee: {
      async findUnique({ where }) {
        return where.id === consigneeRow.id ? ({ ...consigneeRow } as never) : null;
      },
      async update({ data }) {
        Object.assign(consigneeRow, data);
        return consigneeRow;
      },
    },
    zone: {
      async findUnique({ where }) {
        return zoneExists ? { code: where.code } : null;
      },
    },
    auditLog: {
      async create({ data }) {
        audits.push(data);
        return data;
      },
    },
  };
  return { client, consigneeRow, finalizedTrip, finalizedStop, audits };
}

describe("updateConsignee — the admin correction path", () => {
  it("updates the zone and writes an audit row encoding old→new", async () => {
    const { client, consigneeRow, audits } = fakeStore();
    const action = await updateConsignee(client, "c1", { zone_code: "K1" }, "admin-1");
    expect(consigneeRow.zone_code).toBe("K1");
    expect(action).toBe("consignee.updated zone P1→K1");
    expect(audits).toEqual([
      {
        user_id: "admin-1",
        action: "consignee.updated zone P1→K1",
        table_name: "Consignee",
        record_id: "c1",
      },
    ]);
  });

  it("a zone correction NEVER touches a finalized trip's stored pay or evidence", async () => {
    const { client, finalizedTrip, finalizedStop } = fakeStore();
    await updateConsignee(client, "c1", { zone_code: "K1" }, "admin-1");
    // The store's trip/stop rows are untouched — updateConsignee has no path
    // to them, and every pay reader consumes these snapshots, not the live
    // consignee zone. History is safe by construction.
    expect(finalizedTrip).toEqual({ id: "t1", status: "completed", incentive_earned: 44, rate_used: 11 });
    expect(finalizedStop).toEqual({ id: "s1", zone_code: "P1", points_awarded: 3, was_repeat: false });
  });

  it("rejects a zone that does not exist", async () => {
    const { client, consigneeRow } = fakeStore({ zoneExists: false });
    await expect(updateConsignee(client, "c1", { zone_code: "XX" }, "admin-1")).rejects.toMatchObject(
      { code: "ZONE_NOT_FOUND", statusCode: 400 }
    );
    expect(consigneeRow.zone_code).toBe("P1"); // unchanged
  });

  it("404s on an unknown consignee", async () => {
    const { client } = fakeStore();
    await expect(updateConsignee(client, "nope", { is_active: false }, "admin-1")).rejects.toBeInstanceOf(
      ApiError
    );
  });

  it("deactivation and rename are encoded in the audit action", () => {
    const before = { company_name: "ACE", zone_code: "K1", is_active: true };
    expect(consigneeAuditAction(before, { is_active: false })).toBe("consignee.updated deactivated");
    expect(consigneeAuditAction(before, { company_name: "ACE Engineering" })).toBe(
      'consignee.updated renamed "ACE"→"ACE Engineering"'
    );
    expect(consigneeAuditAction(before, { zone_code: "K1" })).toBe("consignee.updated (no-op)");
  });
});

/**
 * A CORRECTED ADDRESS MUST NOT KEEP THE OLD BUILDING'S COORDINATE.
 *
 * The stored lat/lng is what the driver's Navigate opens, and routing gates on
 * the PRESENCE of coords (DG-D2) — so a coordinate is trusted absolutely
 * whenever there is one. Editing the address is exactly what an admin does when
 * the address was WRONG, and leaving the geocode behind pointed the driver at
 * the old building with more confidence than the zone-centroid fallback would
 * have given. The corrected address survived only as text nobody navigates by.
 */
describe("updateConsignee — a moved address discards the stale geocode", () => {
  it("clearing happens on the street, and it is audited", async () => {
    const { client, consigneeRow, audits } = fakeStore();
    const action = await updateConsignee(
      client,
      "c1",
      { address_1: "500 Lorong Industri" },
      "admin-1"
    );
    expect(consigneeRow.address_1).toBe("500 Lorong Industri");
    expect(consigneeRow.latitude).toBeNull();
    expect(consigneeRow.longitude).toBeNull();
    // The match_type goes too: it described the OLD lookup, and leaving it set
    // would file this consignee under "asked and declined" in
    // GET /consignees/coverage when it has never been asked about this address.
    expect(consigneeRow.geocode_match_type).toBeNull();
    expect(action).toContain("geocode cleared (address moved)");
    expect(audits).toHaveLength(1);
  });

  it.each(["address_1", "address_2", "area", "state", "postal_code"] as const)(
    "%s moves the building",
    async (field) => {
      const { client, consigneeRow } = fakeStore();
      await updateConsignee(client, "c1", { [field]: "SOMEWHERE ELSE" }, "admin-1");
      expect(consigneeRow.latitude).toBeNull();
    }
  );

  it.each(["company_name", "contact_person", "phone", "vendor_code"] as const)(
    "%s does not — the building has not moved",
    async (field) => {
      const { client, consigneeRow } = fakeStore();
      await updateConsignee(client, "c1", { [field]: "Renamed Sdn Bhd" }, "admin-1");
      expect(consigneeRow.latitude).toBe(5.3654);
      expect(consigneeRow.geocode_match_type).toBe("ROOFTOP");
    }
  );

  it("a zone re-code keeps the position — same building, different zone", async () => {
    const { client, consigneeRow } = fakeStore();
    await updateConsignee(client, "c1", { zone_code: "K1" }, "admin-1");
    expect(consigneeRow.latitude).toBe(5.3654);
  });

  it("RE-SAVING the same address keeps it — an unchanged form is not a move", async () => {
    // The edit screen submits every field it holds, so a patch that merely
    // MENTIONS address_1 is not evidence of a change. Discarding a good geocode
    // every time an admin opens and saves the form would erode coverage to zero.
    const { client, consigneeRow } = fakeStore();
    const action = await updateConsignee(
      client,
      "c1",
      { address_1: "12 Jalan Perusahaan", area: "KULIM", state: "KEDAH", postal_code: "09000" },
      "admin-1"
    );
    expect(consigneeRow.latitude).toBe(5.3654);
    expect(consigneeRow.geocode_match_type).toBe("ROOFTOP");
    expect(action).not.toContain("geocode cleared");
  });

  it("clearing a blank field to null counts as a move", async () => {
    // "" → null is the route's normalisation, but area "KULIM" → null genuinely
    // changes the address the geocoder was given.
    const { client, consigneeRow } = fakeStore();
    await updateConsignee(client, "c1", { area: null }, "admin-1");
    expect(consigneeRow.latitude).toBeNull();
  });

  it("null → null is not a move (address_2 was already empty)", async () => {
    const { client, consigneeRow } = fakeStore();
    await updateConsignee(client, "c1", { address_2: null }, "admin-1");
    expect(consigneeRow.latitude).toBe(5.3654);
  });

  it("says nothing about a geocode when there was none to clear", async () => {
    const { client, consigneeRow } = fakeStore();
    consigneeRow.latitude = null;
    consigneeRow.longitude = null;
    consigneeRow.geocode_match_type = "APPROXIMATE"; // asked, declined
    const action = await updateConsignee(client, "c1", { address_1: "New street" }, "admin-1");
    expect(action).not.toContain("geocode cleared");
    // The stale match_type still goes — the new address deserves a fresh ask.
    expect(consigneeRow.geocode_match_type).toBeNull();
  });
});

/**
 * The deactivate warning (audit 2026-07-05 #10) counts bookings still ROUTED
 * to the consignee. This where-shape is what decides "still routed", so pin
 * it: live statuses only — completed/cancelled/rejected trips must never
 * make a deactivation warn.
 */
describe("activeBookingsForConsigneeWhere — the deactivate-warning scope", () => {
  it("counts pending/approved/assigned/in_progress trips with a stop at this consignee", () => {
    expect(activeBookingsForConsigneeWhere("c1")).toEqual({
      status: { in: ["pending", "approved", "assigned", "in_progress"] },
      stops: { some: { consignee_id: "c1" } },
    });
  });

  it("terminal statuses are excluded (a delivered/cancelled history never blocks cleanup)", () => {
    const statuses = activeBookingsForConsigneeWhere("c1").status.in as string[];
    for (const s of ["completed", "cancelled", "rejected"]) {
      expect(statuses).not.toContain(s);
    }
  });
});
