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

/**
 * Upload an in-memory file buffer (from multer) to Cloudinary and return the
 * secure HTTPS URL. `folder` groups assets in the Cloudinary media library
 * (e.g. "uwc/pod", "uwc/documents").
 */
export function uploadBuffer(
  buffer: Buffer,
  folder: string,
  options: { resourceType?: "image" | "auto"; publicId?: string } = {}
): Promise<string> {
  if (!isCloudinaryConfigured()) {
    return Promise.reject(
      new Error("Cloudinary is not configured (missing CLOUDINARY_* environment variables).")
    );
  }

  return new Promise<string>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: options.resourceType ?? "image",
        public_id: options.publicId,
        overwrite: true,
      },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error("Cloudinary upload returned no result."));
          return;
        }
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

export { cloudinary };
