import { v2 as cloudinary } from "cloudinary";

// Configured from .env (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET).
// These are set on Railway in production. If they're missing the upload helper
// throws a clear error rather than silently producing a broken URL.
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export function isCloudinaryConfigured(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
  );
}

export interface UploadResult {
  /** secure_url as returned by Cloudinary. For `type: "authenticated"` uploads
   *  this is NOT publicly accessible — delivery needs a signed URL. */
  url: string;
  /** Cloudinary public_id — the stable handle used to sign delivery URLs. */
  publicId: string;
  /** Delivery resource type Cloudinary assigned ("image" | "raw" | "video"). For
   *  `resourceType: "auto"` uploads (documents) this is needed to sign correctly. */
  resourceType: string;
  /** Original file format/extension (e.g. "jpg", "png", "pdf"), or undefined for
   *  raw assets — kept so a signed URL preserves the extension. */
  format?: string;
}

/**
 * Upload an in-memory file buffer (from multer) to Cloudinary. `folder` groups
 * assets (e.g. "uwc/pod", "uwc/documents"). `type: "authenticated"` uploads a
 * PRIVATE asset whose public URL 401s — it can only be delivered via a
 * server-signed URL (see lib/podPhotos.ts) — closing the "public + guessable"
 * hole for POD photos. Returns both the url and the public_id so the caller can
 * store the id and sign on read.
 */
/**
 * TEST-ONLY upload stub, for the CI browser suite.
 *
 * The e2e suite uploads for real — resetState pushes a POD photo to close out a
 * stop, and the exception flow posts evidence — but a CI runner has no
 * Cloudinary credentials, and giving it real ones would write junk into the
 * live asset account on every push. With no credentials uploadBuffer rejects,
 * so every one of those paths fails.
 *
 * Enabling this is deliberately hard to do by accident and IMPOSSIBLE in
 * production: the flag must be exactly "true" AND NODE_ENV must not be
 * "production". If it ever did switch on in production, PODs would silently
 * stop being stored — proof of delivery is the evidence a payment dispute turns
 * on — so the environment check is not a nicety.
 */
export function uploadStubEnabled(): boolean {
  return process.env.E2E_STUB_UPLOADS === "true" && process.env.NODE_ENV !== "production";
}

let stubWarned = false;

export function uploadBuffer(
  buffer: Buffer,
  folder: string,
  options: {
    resourceType?: "image" | "auto";
    publicId?: string;
    type?: "upload" | "authenticated";
  } = {}
): Promise<UploadResult> {
  if (uploadStubEnabled()) {
    if (!stubWarned) {
      stubWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "⚠ E2E_STUB_UPLOADS is on — uploads are FAKED and nothing reaches Cloudinary. " +
          "This must never be set outside a test environment."
      );
    }
    const id = options.publicId ?? `stub_${Date.now()}_${Math.round(Math.random() * 1e9)}`;
    return Promise.resolve({
      url: `https://res.cloudinary.stub/${folder}/${options.type ?? "upload"}/${id}`,
      publicId: `${folder}/${id}`,
      resourceType: options.resourceType === "auto" ? "raw" : "image",
      format: "jpg",
    });
  }

  if (!isCloudinaryConfigured()) {
    return Promise.reject(
      new Error("Cloudinary is not configured (missing CLOUDINARY_* environment variables).")
    );
  }

  return new Promise<UploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: options.resourceType ?? "image",
        public_id: options.publicId,
        type: options.type ?? "upload",
        overwrite: true,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary upload returned no result."));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: result.resource_type,
          format: result.format,
        });
      }
    );
    stream.end(buffer);
  });
}

export { cloudinary };
