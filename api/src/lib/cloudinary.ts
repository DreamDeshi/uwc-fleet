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
}

/**
 * Upload an in-memory file buffer (from multer) to Cloudinary. `folder` groups
 * assets (e.g. "uwc/pod", "uwc/documents"). `type: "authenticated"` uploads a
 * PRIVATE asset whose public URL 401s — it can only be delivered via a
 * server-signed URL (see lib/podPhotos.ts) — closing the "public + guessable"
 * hole for POD photos. Returns both the url and the public_id so the caller can
 * store the id and sign on read.
 */
export function uploadBuffer(
  buffer: Buffer,
  folder: string,
  options: {
    resourceType?: "image" | "auto";
    publicId?: string;
    type?: "upload" | "authenticated";
  } = {}
): Promise<UploadResult> {
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
        resolve({ url: result.secure_url, publicId: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

export { cloudinary };
