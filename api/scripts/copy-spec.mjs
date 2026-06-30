/**
 * Build helper: copy the authoritative spec extract `docs/uwc-spec.json` next to
 * the compiled output (`dist/uwc-spec.json`) so the deployed API can read it at
 * runtime (the canonical file lives at the repo root, outside the API's build
 * scope). Tolerant by design — if the file isn't in the build context the API
 * falls back to runtime path resolution (see src/lib/uwcSpec.ts), so this must
 * never fail the build. Always exits 0.
 */
import fs from "node:fs";
import path from "node:path";

try {
  const candidates = [
    path.resolve(process.cwd(), "../docs/uwc-spec.json"), // cwd = api/
    path.resolve(process.cwd(), "docs/uwc-spec.json"), // cwd = repo root
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  const distDir = path.resolve(process.cwd(), "dist");

  if (src && fs.existsSync(distDir)) {
    fs.copyFileSync(src, path.join(distDir, "uwc-spec.json"));
    console.log(`copy-spec: copied ${src} → dist/uwc-spec.json`);
  } else {
    console.warn(
      "copy-spec: docs/uwc-spec.json not found in build context; API will resolve it at runtime."
    );
  }
} catch (err) {
  console.warn(`copy-spec: skipped (${err?.message ?? err}); API will resolve the spec at runtime.`);
}
