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
import { uploadStubEnabled } from "./uploadStub";

// Optional expiry via Cloudinary token-based auth (an account add-on). When
// CLOUDINARY_POD_TOKEN_KEY is set we mint time-limited tokens; otherwise
// signature-only URLs (unguessable on every plan, no expiry). The core fix —
// no longer public/enumerable — holds either way.
const POD_URL_TTL_SECONDS = Number(process.env.CLOUDINARY_POD_URL_TTL_SECONDS) || 3600;
const POD_TOKEN_KEY = process.env.CLOUDINARY_POD_TOKEN_KEY?.trim() || undefined;

/**
 * Formats Cloudinary may safely re-encode. An ALLOWLIST, not a pdf-denylist:
 * an unknown or absent format must fall through to "leave it alone", because
 * the failure mode of guessing wrong is silent and destructive (see below).
 */
const OPTIMISABLE_FORMATS = new Set([
  "jpg", "jpeg", "png", "webp", "heic", "heif", "avif", "bmp", "tif", "tiff", "gif",
]);

/**
 * How much delivery optimisation an asset may take.
 *
 *   "full"    q_auto + f_auto — Cloudinary picks quality AND container. Only for
 *             assets whose URL nobody parses (POD / K2 photos).
 *   "quality" q_auto only. The URL keeps its extension.
 *   "none"    untouched.
 *
 * ⚠ WHY DOCUMENTS NEVER GET "full", AND IT IS NOT THE REASON YOU EXPECT.
 * Two independent traps sit on that path:
 *
 *  1. A PDF uploaded with `resource_type: "auto"` lands as resource_type
 *     **image**, format **pdf** — so a gate written on resource_type would sail
 *     straight past it. f_auto on a PDF renders PAGE ONE as a raster image and
 *     silently discards the rest. A multi-page customs document would arrive
 *     looking complete and be missing pages, with nothing in any log.
 *  2. Even for genuine images, the requestor's paperwork row decides
 *     image-vs-PDF by regexing the file EXTENSION off the delivery URL
 *     (screens/requestor/BookingDetailScreen.tsx). f_auto removes the extension,
 *     so every image document would stop rendering as a thumbnail.
 *
 * Gate on FORMAT, never on resource_type, and never remove an extension something
 * else is reading.
 */
export type Optimisation = "full" | "quality" | "none";

function optimisationParams(mode: Optimisation, format: string | undefined, resourceType: string) {
  if (mode === "none" || resourceType === "raw") return {};
  if (mode === "full") return { quality: "auto", fetch_format: "auto" };
  // "quality": only when we positively recognise a raster format.
  if (!format || !OPTIMISABLE_FORMATS.has(format.toLowerCase())) return {};
  return { quality: "auto" };
}

/**
 * A freshly-signed authenticated delivery URL for any private asset. `format`
 * preserves the file extension for image/video assets (the DO/invoice row in the
 * client detects image-vs-PDF from the URL); raw public_ids already carry it.
 *
 * `optimise` defaults to "none" so a new caller cannot acquire a transformation
 * by accident — see the Optimisation notes above for why that default matters.
 */
export function signedAssetUrl(
  publicId: string,
  opts: { resourceType?: string; format?: string; optimise?: Optimisation } = {}
): string {
  // Stubbed uploads produce stubbed ids, and signing one needs a configured
  // Cloudinary — so without this every trip payload carrying a stubbed asset
  // 500s on READ, not on upload. CI showed exactly that: the POD upload failed
  // and then GET /trips failed for the whole suite. Same guard as the upload
  // side: impossible in production (see uploadStubEnabled).
  if (uploadStubEnabled()) {
    const q = opts.format ? `.${opts.format}` : "";
    return `https://res.cloudinary.stub/signed/${publicId}${q}?s--stub--`;
  }
  const resource_type = opts.resourceType || "image";
  const base: Record<string, unknown> = { type: "authenticated", resource_type, secure: true };
  if (opts.format && resource_type !== "raw") base.format = opts.format;
  Object.assign(base, optimisationParams(opts.optimise ?? "none", opts.format, resource_type));
  if (POD_TOKEN_KEY) {
    return cloudinary.url(publicId, { ...base, auth_token: { key: POD_TOKEN_KEY, duration: POD_URL_TTL_SECONDS } });
  }
  return cloudinary.url(publicId, { ...base, sign_url: true });
}

/**
 * A POD photo is always a raster camera image, and that is now enforced rather
 * than assumed: `lib/upload.ts` rejects anything but an image on the POD route,
 * because the owner's ruling is that a POD is proof something happened LIVE at
 * the delivery point. Nothing parses a POD delivery URL, so it takes the full
 * q_auto + f_auto treatment — the highest-volume asset class getting the largest
 * per-view saving.
 *
 * ⚠ DO NOT REUSE THIS FOR K2. See signedK2Url.
 */
export function signedPodUrl(publicId: string): string {
  return signedAssetUrl(publicId, { resourceType: "image", optimise: "full" });
}

/**
 * The Borang K2 customs document — NOT optimised, and the difference from
 * signedPodUrl is load-bearing.
 *
 * ⚠ K2 MAY BE A PDF. Customs paperwork arrives as one, and a Borang K2 can run
 * to several pages. `f_auto` on a PDF renders PAGE ONE and silently discards the
 * rest — so the document would look complete to the admin validating it, while
 * being incomplete. That admin's approval is what releases pay (Mr. Teh R1 Q6:
 * "we need admin to final validate and approve, only they can get pay"), which
 * makes a silently-truncated K2 a money problem, not a display one.
 *
 * K2 shares POD's storage columns (`k2_photo`/`k2_public_id`) and has NO format
 * column, so there is nothing to gate an allowlist on — and "optimise on a
 * guess" is exactly what must not happen here. `"none"` costs K2 its q_auto,
 * which is worth nothing at K2 volume, and is correct whatever type the file is.
 *
 * ⚠ If K2 ever gains a `format` column, this may become "quality" — never
 * "full", regardless.
 */
export function signedK2Url(publicId: string): string {
  return signedAssetUrl(publicId, { resourceType: "image", optimise: "none" });
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
// signed one AND REMOVES THE public_id; legacy rows (public URL, no public_id)
// pass through untouched until the backfill secures them. Fail-safe: a missed
// asset just shows no image (the stored authenticated URL 401s) — never a
// public leak.
//
// Dropping the identifier is the point of the second half. The whole reason
// this module exists is that asset ids were published and, for PODs, were
// deterministic (`<ticket>-stop-<n>`) and therefore enumerable by ticket. The
// signing pipeline stopped the URLs being guessable but kept handing out the id
// itself, to every role, on every trip read — the exact string the work was
// meant to withhold. No client reads it (verified across mobile/src); the
// signed URL is the only usable artefact. serializeException in
// lib/exceptionEvidence.ts already had this right: it builds an explicit object
// and never includes public_id.

type StopLike = { pod_public_id?: string | null; pod_photo?: string | null; k2_public_id?: string | null; k2_photo?: string | null } & Record<string, unknown>;
type DocLike = { public_id?: string | null; resource_type?: string | null; format?: string | null; file_url?: string | null } & Record<string, unknown>;
type TripLike = { stops?: unknown; documents?: unknown } & Record<string, unknown>;

function signStop(stop: StopLike): StopLike {
  if (!stop || typeof stop !== "object") return stop;
  if (!stop.pod_public_id && !stop.k2_public_id) return stop;
  // POD photo and the K2 (Borang K2) document are both private authenticated
  // assets — serve each as a freshly-signed URL when its public_id is stored,
  // then DROP the identifier. It is the stored asset id this module exists to
  // stop publishing (POD ids were once deterministic, `<ticket>-stop-<n>`, and
  // enumerable by ticket), no client reads it, and the signed URL it produces
  // is the only thing a client can use.
  const { pod_public_id, k2_public_id, ...rest } = stop;
  const out: StopLike = { ...rest };
  if (pod_public_id) out.pod_photo = signedPodUrl(pod_public_id);
  // ⚠ signedK2Url, NOT signedPodUrl — a K2 may be a multi-page PDF and must not
  // be format-converted. The two looked interchangeable until PDFs were allowed.
  if (k2_public_id) out.k2_photo = signedK2Url(k2_public_id);
  return out;
}

function signDocument(doc: DocLike): DocLike {
  if (doc && typeof doc === "object" && doc.public_id) {
    // Same rule as signStop: mint the signed URL, then drop the identifier.
    const { public_id, ...rest } = doc;
    return {
      ...rest,
      // "quality" only — a document may be a PDF, and its extension is load-bearing
      // for the requestor's paperwork row. See the Optimisation notes above.
      file_url: signedAssetUrl(public_id as string, {
        resourceType: doc.resource_type ?? undefined,
        format: doc.format ?? undefined,
        optimise: "quality",
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
