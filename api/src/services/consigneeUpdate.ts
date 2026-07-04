import { ApiError } from "../lib/apiError";

/**
 * Admin consignee correction (audit finding: a requestor could self-add a
 * consignee with a wrong zone and NOTHING could fix it — every future booking
 * then mis-dispatches and mispays, compounding forever).
 *
 * Scope: zone_code, company_name, is_active. The change affects FUTURE
 * bookings only — pay is protected twice over: assignment snapshots each
 * stop's zone_points AND zone_code (rate + identity lock, so an in-flight
 * trip scores and records the zone it was DISPATCHED under), and
 * finalization persists the scored zone_code + points_awarded per stop, so
 * no reader ever re-derives historic pay from the live consignee row. See
 * the unit tests proving a zone correction leaves both a finalized trip and
 * an in-flight trip's scoring untouched.
 *
 * Factored like tripAssignment/tripCompletion: a minimal client slice so the
 * behaviour is unit-testable without a database.
 */

export interface ConsigneePatch {
  company_name?: string;
  zone_code?: string;
  is_active?: boolean;
}

export interface ConsigneeUpdateClient {
  consignee: {
    findUnique(args: { where: { id: string } }): Promise<{
      id: string;
      company_name: string;
      zone_code: string;
      is_active: boolean;
    } | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  zone: {
    findUnique(args: { where: { code: string } }): Promise<{ code: string } | null>;
  };
  auditLog: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Human-readable audit action encoding the old → new values — AuditLog has no
 * free-text column, so the diff lives behind a stable "consignee.updated"
 * prefix (same convention as "rate.updated points 3→4").
 */
export function consigneeAuditAction(
  before: { company_name: string; zone_code: string; is_active: boolean },
  patch: ConsigneePatch
): string {
  const parts: string[] = [];
  if (patch.zone_code !== undefined && patch.zone_code !== before.zone_code) {
    parts.push(`zone ${before.zone_code}→${patch.zone_code}`);
  }
  if (patch.company_name !== undefined && patch.company_name !== before.company_name) {
    parts.push(`renamed "${before.company_name}"→"${patch.company_name}"`);
  }
  if (patch.is_active !== undefined && patch.is_active !== before.is_active) {
    parts.push(patch.is_active ? "reactivated" : "deactivated");
  }
  return parts.length > 0 ? `consignee.updated ${parts.join(", ")}` : "consignee.updated (no-op)";
}

/**
 * Validate + apply an admin consignee patch and write the audit row. Throws
 * the canonical ApiErrors; returns the audit action written (for the route's
 * response/debugging and for tests).
 */
export async function updateConsignee(
  client: ConsigneeUpdateClient,
  id: string,
  patch: ConsigneePatch,
  actorId: string
): Promise<string> {
  const existing = await client.consignee.findUnique({ where: { id } });
  if (!existing) {
    throw new ApiError(404, "CONSIGNEE_NOT_FOUND", "Consignee not found.");
  }
  if (patch.zone_code !== undefined && patch.zone_code !== existing.zone_code) {
    const zone = await client.zone.findUnique({ where: { code: patch.zone_code } });
    if (!zone) {
      throw new ApiError(400, "ZONE_NOT_FOUND", "That delivery zone does not exist.");
    }
  }

  await client.consignee.update({ where: { id }, data: { ...patch } });

  const action = consigneeAuditAction(existing, patch);
  await client.auditLog.create({
    data: { user_id: actorId, action, table_name: "Consignee", record_id: id },
  });
  return action;
}
