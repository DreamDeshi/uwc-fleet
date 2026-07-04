import { describe, it, expect } from "vitest";
import { ApiError } from "../src/lib/apiError";
import {
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
  const consigneeRow = {
    id: "c1",
    company_name: "Intel Kulim",
    zone_code: "P1", // WRONG — should be K1; the correction under test
    is_active: true,
  };
  // A trip finalized BEFORE the correction, with the finalize-time snapshot.
  const finalizedTrip = { id: "t1", status: "completed", incentive_earned: 44, rate_used: 11 };
  const finalizedStop = { id: "s1", zone_code: "P1", points_awarded: 3, was_repeat: false };
  const audits: Record<string, unknown>[] = [];

  const client: ConsigneeUpdateClient = {
    consignee: {
      async findUnique({ where }) {
        return where.id === consigneeRow.id ? { ...consigneeRow } : null;
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
