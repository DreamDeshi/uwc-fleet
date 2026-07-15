// POD photo privacy — serve consignee-premises proof-of-delivery photos ONLY as
// signed, unguessable Cloudinary URLs.
//
// The exposure this closes: POD assets used to be public with a deterministic
// public_id (`<ticket>-stop-<n>`), so anyone could enumerate them by ticket
// number — an NDA leak of consignee premises. New POD assets are uploaded
// `type: "authenticated"` (private delivery — the plain URL 401s) and this
// module mints a per-request SIGNED delivery URL from the stored public_id. The
// signature needs the API secret, so the URL can't be forged; it's only ever
// produced inside trip payloads, which are already role-scoped (admin / the
// trip's requestor / the assigned driver).
import { cloudinary } from "./cloudinary";

// Optional expiry: Cloudinary token-based auth (an account add-on). When
// CLOUDINARY_POD_TOKEN_KEY is set we mint time-limited tokens; otherwise we fall
// back to signature-only URLs (unguessable on every plan, no expiry). The core
// fix — no longer public/enumerable — holds either way.
const POD_URL_TTL_SECONDS = Number(process.env.CLOUDINARY_POD_URL_TTL_SECONDS) || 3600;
const POD_TOKEN_KEY = process.env.CLOUDINARY_POD_TOKEN_KEY?.trim() || undefined;

/** A freshly-signed authenticated delivery URL for a POD public_id. */
export function signedPodUrl(publicId: string): string {
  if (POD_TOKEN_KEY) {
    return cloudinary.url(publicId, {
      type: "authenticated",
      resource_type: "image",
      secure: true,
      auth_token: { key: POD_TOKEN_KEY, duration: POD_URL_TTL_SECONDS },
    });
  }
  return cloudinary.url(publicId, {
    type: "authenticated",
    resource_type: "image",
    secure: true,
    sign_url: true,
  });
}

/**
 * Cloudinary public_id (folder included, version + extension stripped) from a
 * stored delivery URL — used by the backfill to move legacy public assets to
 * authenticated. Returns null if the URL isn't a recognizable Cloudinary URL.
 */
export function podPublicIdFromUrl(url: string): string | null {
  const m = url.match(
    /\/(?:image|raw|video)\/(?:upload|authenticated|private)\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)(?:\.[^./]+)?$/
  );
  return m ? m[1] : null;
}

// ── Response serializer ─────────────────────────────────────────────────────
// Applied to every trip payload leaving the trips router. For a stop that has a
// pod_public_id (new, private asset) it replaces pod_photo with a signed URL;
// legacy stops (public URL, no public_id) pass through untouched until the
// backfill secures them. Fail-safe: a stop we somehow miss just shows no image
// (the stored authenticated URL 401s) — never a public leak.

type StopLike = { pod_public_id?: string | null; pod_photo?: string | null } & Record<string, unknown>;
type TripLike = { stops?: unknown } & Record<string, unknown>;

function signStop(stop: StopLike): StopLike {
  if (stop && typeof stop === "object" && stop.pod_public_id) {
    return { ...stop, pod_photo: signedPodUrl(stop.pod_public_id) };
  }
  return stop;
}

function signTrip<T>(trip: T): T {
  const t = trip as TripLike;
  if (t && typeof t === "object" && Array.isArray(t.stops)) {
    return { ...t, stops: (t.stops as StopLike[]).map(signStop) } as T;
  }
  return trip;
}

/**
 * Sign POD URLs in whatever a trips-router handler passes to res.json: a single
 * trip, an array of trips, or a keyset page ({ items: [...] }). Anything without
 * `stops` (errors, plain messages) passes through unchanged.
 */
export function signTripResponse<T>(body: T): T {
  if (Array.isArray(body)) return (body as unknown[]).map(signTrip) as unknown as T;
  const b = body as { items?: unknown } & Record<string, unknown>;
  if (b && typeof b === "object" && Array.isArray(b.items)) {
    return { ...b, items: (b.items as unknown[]).map(signTrip) } as unknown as T;
  }
  return signTrip(body);
}
