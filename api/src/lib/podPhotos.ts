// Trip-asset privacy — serve private (authenticated) Cloudinary assets ONLY as
// signed, unguessable URLs. Covers two asset classes on a trip:
//   • POD photos      (TripStop.pod_public_id)      — consignee-premises photos
//   • trip documents  (TripDocument.public_id)      — requestor DO / invoice
//
// Both were uploaded `type: "upload"` (public); POD ids were even deterministic
// (`<ticket>-stop-<n>`) so enumerable by ticket — an NDA leak. New uploads are
// `type: "authenticated"` (private — the plain URL 401s) and this module mints a
// per-request SIGNED delivery URL from the stored public_id. The signature needs
// the API secret, so URLs can't be forged; they're only ever produced inside
// trip payloads, already role-scoped (admin / owner-requestor / assigned-driver).
import { cloudinary } from "./cloudinary";

// Optional expiry via Cloudinary token-based auth (an account add-on). When
// CLOUDINARY_POD_TOKEN_KEY is set we mint time-limited tokens; otherwise
// signature-only URLs (unguessable on every plan, no expiry). The core fix —
// no longer public/enumerable — holds either way.
const POD_URL_TTL_SECONDS = Number(process.env.CLOUDINARY_POD_URL_TTL_SECONDS) || 3600;
const POD_TOKEN_KEY = process.env.CLOUDINARY_POD_TOKEN_KEY?.trim() || undefined;

/**
 * A freshly-signed authenticated delivery URL for any private asset. `format`
 * preserves the file extension for image/video assets (the DO/invoice row in the
 * client detects image-vs-PDF from the URL); raw public_ids already carry it.
 */
export function signedAssetUrl(
  publicId: string,
  opts: { resourceType?: string; format?: string } = {}
): string {
  const resource_type = opts.resourceType || "image";
  const base: Record<string, unknown> = { type: "authenticated", resource_type, secure: true };
  if (opts.format && resource_type !== "raw") base.format = opts.format;
  if (POD_TOKEN_KEY) {
    return cloudinary.url(publicId, { ...base, auth_token: { key: POD_TOKEN_KEY, duration: POD_URL_TTL_SECONDS } });
  }
  return cloudinary.url(publicId, { ...base, sign_url: true });
}

/** POD photos are always images. */
export function signedPodUrl(publicId: string): string {
  return signedAssetUrl(publicId, { resourceType: "image" });
}

/**
 * Cloudinary public_id (folder included, version + extension stripped) from a
 * POD delivery URL — used by the POD backfill. Returns null if unrecognized.
 */
export function podPublicIdFromUrl(url: string): string | null {
  const m = url.match(
    /\/(?:image|raw|video)\/(?:upload|authenticated|private)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(?:\.[^./]+)?$/
  );
  return m ? m[1] : null;
}

/**
 * Parse a document delivery URL into the fields needed to re-sign / migrate it.
 * Handles image/video (extension stripped into `format`) and raw (public_id
 * KEEPS its extension, as Cloudinary requires). Returns null if unrecognized.
 */
export function documentAssetFromUrl(
  url: string
): { publicId: string; resourceType: string; format?: string } | null {
  const m = url.match(
    /\/(image|raw|video)\/(?:upload|authenticated|private)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+)$/
  );
  if (!m) return null;
  const resourceType = m[1];
  const rest = m[2];
  const ext = rest.match(/\.([a-zA-Z0-9]+)$/);
  const format = ext?.[1];
  // Raw public_ids include the extension; image/video ones don't.
  const publicId = resourceType === "raw" || !ext ? rest : rest.slice(0, -ext[0].length);
  return { publicId, resourceType, format };
}

// ── Response serializer ─────────────────────────────────────────────────────
// Applied to every trip payload leaving the trips router. For a stop/document
// that has a stored public_id (new, private asset) it replaces the URL with a
// signed one; legacy rows (public URL, no public_id) pass through untouched
// until the backfill secures them. Fail-safe: a missed asset just shows no
// image (the stored authenticated URL 401s) — never a public leak.

type StopLike = { pod_public_id?: string | null; pod_photo?: string | null } & Record<string, unknown>;
type DocLike = { public_id?: string | null; resource_type?: string | null; format?: string | null; file_url?: string | null } & Record<string, unknown>;
type TripLike = { stops?: unknown; documents?: unknown } & Record<string, unknown>;

function signStop(stop: StopLike): StopLike {
  if (stop && typeof stop === "object" && stop.pod_public_id) {
    return { ...stop, pod_photo: signedPodUrl(stop.pod_public_id) };
  }
  return stop;
}

function signDocument(doc: DocLike): DocLike {
  if (doc && typeof doc === "object" && doc.public_id) {
    return {
      ...doc,
      file_url: signedAssetUrl(doc.public_id, {
        resourceType: doc.resource_type ?? undefined,
        format: doc.format ?? undefined,
      }),
    };
  }
  return doc;
}

function signTrip<T>(trip: T): T {
  const t = trip as TripLike;
  if (!t || typeof t !== "object") return trip;
  let out: TripLike = t;
  if (Array.isArray(t.stops)) out = { ...out, stops: (t.stops as StopLike[]).map(signStop) };
  if (Array.isArray(t.documents)) out = { ...out, documents: (t.documents as DocLike[]).map(signDocument) };
  return out === t ? trip : (out as T);
}

/**
 * Sign asset URLs in whatever a trips-router handler passes to res.json: a single
 * trip, an array of trips, or a keyset page ({ items: [...] }). Anything without
 * `stops`/`documents` (errors, plain messages) passes through unchanged.
 */
export function signTripResponse<T>(body: T): T {
  if (Array.isArray(body)) return (body as unknown[]).map(signTrip) as unknown as T;
  const b = body as { items?: unknown } & Record<string, unknown>;
  if (b && typeof b === "object" && Array.isArray(b.items)) {
    return { ...b, items: (b.items as unknown[]).map(signTrip) } as unknown as T;
  }
  return signTrip(body);
}
