/**
 * Loader for the authoritative spec extract `docs/uwc-spec.json` — the SAME file
 * `prisma/seed.ts` reads, so "reset to spec" and a fresh seed can never diverge.
 *
 * The file lives at the repo root (`docs/uwc-spec.json`), outside the API's
 * `src`/`dist`, so we resolve it at runtime across the layouts the API actually
 * runs in (compiled `dist/lib`, dev `src/lib` via tsx, and a build-time copy
 * dropped next to `dist`). `UWC_SPEC_PATH` overrides everything for ops/tests.
 */
import fs from "fs";
import path from "path";
import { ApiError } from "./apiError";

// Shape of a truck entry in docs/uwc-spec.json (the rate fields use the spec's
// own column names; seed.ts maps them to the DB columns the same way).
export interface SpecTruck {
  plate: string;
  type: string;
  max_pallets: number;
  weekday_rate: number;
  offpeak_rate: number;
  daily_deduction: number;
  priority_zones: string[];
}

interface UwcSpec {
  trucks: SpecTruck[];
}

/** First existing candidate path to docs/uwc-spec.json, or null if none. */
function resolveSpecPath(): string | null {
  const candidates = [
    process.env.UWC_SPEC_PATH,
    // build-time copy dropped beside dist (scripts/copy-spec.mjs) — dist/lib → dist
    path.resolve(__dirname, "../uwc-spec.json"),
    // repo-root/docs from compiled dist/lib OR dev src/lib (both 3 levels deep)
    path.resolve(__dirname, "../../../docs/uwc-spec.json"),
    // cwd-relative fallbacks (cwd = repo root, or cwd = api/)
    path.resolve(process.cwd(), "docs/uwc-spec.json"),
    path.resolve(process.cwd(), "../docs/uwc-spec.json"),
  ].filter((p): p is string => Boolean(p));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Read the authoritative truck list from docs/uwc-spec.json. Throws a 500
 * ApiError (caught by the route) if the file can't be located or is malformed —
 * never crashes the process.
 */
export function loadSpecTrucks(): SpecTruck[] {
  const specPath = resolveSpecPath();
  if (!specPath) {
    throw new ApiError(
      500,
      "SPEC_NOT_FOUND",
      "Could not locate docs/uwc-spec.json (set UWC_SPEC_PATH to override)."
    );
  }
  let spec: UwcSpec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as UwcSpec;
  } catch {
    throw new ApiError(500, "SPEC_INVALID", "docs/uwc-spec.json could not be parsed.");
  }
  if (!Array.isArray(spec.trucks)) {
    throw new ApiError(500, "SPEC_INVALID", "docs/uwc-spec.json has no trucks array.");
  }
  return spec.trucks;
}
