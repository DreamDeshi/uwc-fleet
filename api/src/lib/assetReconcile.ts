/**
 * Cloudinary ↔ database reconciliation.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The obvious way to clean up assets during a data wipe is to collect the ids
 * off the rows you are about to delete, then delete those files. That is what
 * wipe-trips.ts originally did, and it is structurally unable to finish the job:
 * an asset whose row was deleted by an EARLIER wipe has nothing left pointing
 * at it, so the next run cannot see it. Every wipe that ran without a purge
 * stranded its assets permanently, and each new wipe did the same to the next
 * batch. On 2 Aug 2026 that had accumulated to 511 orphans against a database
 * holding zero trip rows — 145 of them `type: "upload"`, i.e. publicly
 * reachable consignee-premises photos predating the authenticated-URL fix.
 *
 * So the question must be asked the other way round: enumerate what is actually
 * IN the account, ask the database what it still references, and treat the
 * difference as garbage. The folder is the source of truth about what exists;
 * the database is the source of truth about what is needed.
 *
 * ⚠ THE DANGEROUS DIRECTION IS A MISSED REFERENCE, NOT A MISSED ORPHAN. Failing
 * to spot an orphan costs storage. Failing to spot a REFERENCE deletes a live
 * POD — evidence that gates pay and cannot be recovered. Everything below is
 * biased accordingly: every known reference source is read, ids are matched
 * leniently (both exact and extension-stripped), and the caller is expected to
 * refuse to delete when the reference scan looks implausible.
 */
import type { PrismaClient } from "@prisma/client";
import { cloudinary } from "./cloudinary";
import { podPublicIdFromUrl, documentAssetFromUrl } from "./podPhotos";

/** Every folder any upload path in this API writes to. Keep in step with the
 *  `uploadBuffer(..., "uwc/…")` call sites — a folder missing here is invisible
 *  to the census and its orphans accumulate silently. */
export const ASSET_PREFIX = "uwc";

export interface CloudAsset {
  publicId: string;
  /** "upload" (PUBLIC) | "authenticated" | "private" */
  type: string;
  /** "image" | "raw" | "video" */
  resourceType: string;
  folder: string;
  bytes: number;
  createdAt: string;
}

const TYPES = ["upload", "authenticated", "private"] as const;
const RESOURCE_TYPES = ["image", "raw", "video"] as const;

/** Everything under the `uwc/` prefix, across every delivery type. Paginated. */
export async function listAllAssets(): Promise<CloudAsset[]> {
  const out: CloudAsset[] = [];
  for (const type of TYPES) {
    for (const resourceType of RESOURCE_TYPES) {
      let cursor: string | undefined;
      do {
        let page;
        try {
          page = await cloudinary.api.resources({
            type,
            resource_type: resourceType,
            prefix: ASSET_PREFIX,
            max_results: 500,
            next_cursor: cursor,
          });
        } catch {
          // An empty type/resource_type combination 404s on some accounts.
          break;
        }
        for (const r of page.resources ?? []) {
          const id: string = r.public_id;
          out.push({
            publicId: id,
            type,
            resourceType,
            folder: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "(root)",
            bytes: r.bytes ?? 0,
            createdAt: r.created_at ?? "",
          });
        }
        cursor = page.next_cursor;
      } while (cursor);
    }
  }
  return out;
}

/** `foo/bar.pdf` → `foo/bar`. Raw public_ids keep their extension while the
 *  image ones drop it, so both spellings are indexed on each side. */
function stripExt(id: string): string {
  return id.replace(/\.[A-Za-z0-9]+$/, "");
}

export interface ReferenceScan {
  ids: Set<string>;
  /** How many ids each source contributed — for the implausibility check. */
  bySource: Record<string, number>;
  /** Row counts of the tables that can hold a reference. */
  rows: Record<string, number>;
}

/**
 * Every Cloudinary id the database still refers to, from ALL five upload paths.
 *
 * ⚠ `uwc/feedback` is the one that catches people out: feedback is AuditLog-
 * backed with no table of its own, and its image id is embedded in the action
 * TEXT as `[image: <publicId>]`. A reconciler that only walked the trip tables
 * would classify every live feedback attachment as an orphan and delete it.
 */
export async function referencedPublicIds(prisma: PrismaClient): Promise<ReferenceScan> {
  const ids = new Set<string>();
  const bySource: Record<string, number> = {};
  const add = (source: string, id: string | null | undefined) => {
    if (!id) return;
    ids.add(id);
    ids.add(stripExt(id));
    bySource[source] = (bySource[source] ?? 0) + 1;
  };

  const stops = await prisma.tripStop.findMany({
    where: { OR: [{ pod_photo: { not: null } }, { k2_photo: { not: null } }] },
    select: { pod_public_id: true, pod_photo: true, k2_public_id: true, k2_photo: true },
  });
  for (const s of stops) {
    add("TripStop.pod", s.pod_public_id ?? (s.pod_photo ? podPublicIdFromUrl(s.pod_photo) : null));
    add("TripStop.k2", s.k2_public_id ?? (s.k2_photo ? podPublicIdFromUrl(s.k2_photo) : null));
  }

  const docs = await prisma.tripDocument.findMany({
    select: { public_id: true, file_url: true },
  });
  for (const d of docs) {
    add("TripDocument", d.public_id ?? (d.file_url ? documentAssetFromUrl(d.file_url)?.publicId : null));
  }

  const evidence = await prisma.exceptionEvidence.findMany({ select: { public_id: true } });
  for (const e of evidence) add("ExceptionEvidence", e.public_id);

  // Feedback attachments — see the warning above.
  const feedback = await prisma.auditLog.findMany({
    where: { table_name: "Feedback" },
    select: { action: true },
  });
  for (const f of feedback) {
    const m = f.action?.match(/\[image:\s*([^\]]+)\]/);
    if (m) add("Feedback(AuditLog)", m[1].trim());
  }

  return {
    ids,
    bySource,
    rows: {
      TripStop_withAsset: stops.length,
      TripDocument: docs.length,
      ExceptionEvidence: evidence.length,
      Feedback: feedback.length,
    },
  };
}

/** Assets present in Cloudinary that nothing in the database references. */
export function findOrphans(assets: CloudAsset[], scan: ReferenceScan): CloudAsset[] {
  return assets.filter((a) => !scan.ids.has(a.publicId) && !scan.ids.has(stripExt(a.publicId)));
}

/**
 * Refuse to proceed when the reference scan looks broken rather than empty.
 *
 * An empty reference set is legitimate — it is exactly what a freshly wiped
 * database produces. What is NOT legitimate is rows existing that should have
 * produced references while the scan found none: that means a parse or schema
 * change silently defused the safety net, and deleting on that basis would
 * destroy live evidence. Returns a reason string, or null when sane.
 */
export function implausibleScan(scan: ReferenceScan): string | null {
  const rowsThatShouldRefer =
    scan.rows.TripStop_withAsset + scan.rows.TripDocument + scan.rows.ExceptionEvidence;
  if (rowsThatShouldRefer > 0 && scan.ids.size === 0) {
    return `${rowsThatShouldRefer} row(s) hold an asset but the scan resolved 0 ids — reference parsing is broken.`;
  }
  return null;
}

export interface PurgeResult {
  deleted: number;
  failed: { publicId: string; reason: string }[];
}

/** Delete assets in batches, grouped by the (type, resource_type) pair the
 *  Cloudinary API requires them to share. */
export async function purgeAssets(assets: CloudAsset[]): Promise<PurgeResult> {
  const result: PurgeResult = { deleted: 0, failed: [] };
  const groups = new Map<string, CloudAsset[]>();
  for (const a of assets) {
    const key = `${a.type}|${a.resourceType}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(a);
  }
  for (const [key, group] of groups) {
    const [type, resourceType] = key.split("|");
    for (let i = 0; i < group.length; i += 100) {
      const batch = group.slice(i, i + 100);
      try {
        const res = await cloudinary.api.delete_resources(
          batch.map((a) => a.publicId),
          { type, resource_type: resourceType, invalidate: true }
        );
        for (const a of batch) {
          const outcome = res.deleted?.[a.publicId];
          if (outcome === "deleted" || outcome === "not_found") result.deleted += 1;
          else result.failed.push({ publicId: a.publicId, reason: String(outcome ?? "unknown") });
        }
      } catch (e) {
        for (const a of batch) {
          result.failed.push({ publicId: a.publicId, reason: (e as Error).message });
        }
      }
    }
  }
  return result;
}
