// Exception-evidence privacy + serialization. Failure/exception photos are a
// WHOLLY SEPARATE store from POD: their own Cloudinary folder, their own signed
// delivery URLs, and their own model (ExceptionEvidence). A failure photo can
// therefore never satisfy the delivery/POD gate (which reads TripStop.pod_photo).
import { signedAssetUrl } from "./podPhotos";

/** Cloudinary folder for authenticated exception-evidence uploads. */
export const EXCEPTION_EVIDENCE_FOLDER = "uwc/exceptions";

/** A freshly-signed, unguessable delivery URL for one evidence asset (image). */
export function signExceptionEvidenceUrl(publicId: string): string {
  return signedAssetUrl(publicId, { resourceType: "image" });
}

// ── Serializers ─────────────────────────────────────────────────────────────
// Two views of an exception aggregate:
//   • full     — admin / assigned-driver: actions, evidence (signed URLs), GPS.
//   • redacted — requestor (read-only): category + coarse status + timestamps
//                ONLY. No evidence media, no notes, no GPS, no actor identities,
//                no free-text reason — the requestor sees THAT there is/was an
//                exception and roughly where it stands, nothing operationally
//                sensitive.

export type ExceptionAudience = "full" | "redacted";

interface EvidenceRow {
  id: string;
  kind: string;
  public_id: string;
  created_at: Date;
  captured_client_at: Date | null;
  action_id: string | null;
}
interface ActionRow {
  id: string;
  type: string;
  resolution: string | null;
  actor_id: string;
  actor_role: string;
  note: string | null;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  client_at: Date | null;
  created_at: Date;
}
export interface ExceptionAggregate {
  id: string;
  trip_id: string;
  trip_stop_id: string | null;
  category: string;
  reason: string;
  reported_by: string;
  reported_at: Date;
  client_reported_at: Date | null;
  current_state: string;
  resolution: string | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  version: number;
  created_at: Date;
  actions?: ActionRow[];
  evidence?: EvidenceRow[];
}

/** Coarse, requestor-safe status. Internal review nuance is not exposed. */
function publicStatus(closedAt: Date | null): "open" | "resolved" {
  return closedAt ? "resolved" : "open";
}

export function serializeException(exc: ExceptionAggregate, audience: ExceptionAudience) {
  if (audience === "redacted") {
    return {
      id: exc.id,
      trip_id: exc.trip_id,
      category: exc.category,
      status: publicStatus(exc.closed_at),
      reported_at: exc.reported_at,
      resolved_at: exc.resolved_at,
    };
  }
  return {
    id: exc.id,
    trip_id: exc.trip_id,
    trip_stop_id: exc.trip_stop_id,
    category: exc.category,
    reason: exc.reason,
    reported_by: exc.reported_by,
    reported_at: exc.reported_at,
    client_reported_at: exc.client_reported_at,
    current_state: exc.current_state,
    resolution: exc.resolution,
    resolved_at: exc.resolved_at,
    closed_at: exc.closed_at,
    is_open: exc.closed_at === null,
    version: exc.version,
    created_at: exc.created_at,
    actions: (exc.actions ?? []).map((a) => ({
      id: a.id,
      type: a.type,
      resolution: a.resolution,
      actor_id: a.actor_id,
      actor_role: a.actor_role,
      note: a.note,
      lat: a.lat,
      lng: a.lng,
      accuracy_m: a.accuracy_m,
      client_at: a.client_at,
      created_at: a.created_at,
    })),
    evidence: (exc.evidence ?? []).map((e) => ({
      id: e.id,
      kind: e.kind,
      action_id: e.action_id,
      // Signed on every read — the stored authenticated URL 401s without it.
      url: signExceptionEvidenceUrl(e.public_id),
      created_at: e.created_at,
      captured_client_at: e.captured_client_at,
    })),
  };
}
