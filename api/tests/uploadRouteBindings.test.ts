import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHICH ALLOWLIST IS BOUND TO WHICH ROUTE.
 *
 * ⚠ uploadMimetypes.test.ts proves the RULE works. It cannot notice the rule
 * being applied to the wrong door — and that is the mistake this pairing invites,
 * because the two constants differ by one entry and sit one import apart. Swap
 * them and every other test in the repo still passes:
 *
 *   DOCUMENT_MIMETYPES onto the POD route → a PDF becomes a valid POD, and POD
 *     delivery URLs carry f_auto, so the "page one only" bug this PR exists to
 *     fix returns on the artefact that gates pay.
 *   IMAGE_MIMETYPES onto the K2 route → customs PDFs refused, and a driver at a
 *     Bayan Lepas stop cannot satisfy the delivery gate at all.
 *
 * Both are silent. Neither is a type error. So the binding is asserted here, in
 * the source, the same way tests/asyncRouteBridging guards its own convention.
 */

const ROUTES = join(__dirname, "..", "src", "routes");

function source(file: string): string {
  return readFileSync(join(ROUTES, file), "utf8");
}

/** The allowlist named in the assertMimetype call nearest AFTER `marker`. */
function allowlistFor(src: string, marker: string): string | null {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const call = src.slice(at).match(/assertMimetype\(\s*req\.file\s*,\s*([A-Z_]+)/);
  return call ? call[1] : null;
}

describe("live-proof routes are bound to the IMAGE allowlist", () => {
  it("POD accepts images only", () => {
    const src = source("trips.ts");
    expect(allowlistFor(src, '"/:id/stops/:stopId/pod"')).toBe("IMAGE_MIMETYPES");
  });

  it("exception report AND add-evidence both accept images only", () => {
    const src = source("exceptions.ts");
    const found = [...src.matchAll(/assertMimetype\(\s*req\.file\s*,\s*([A-Z_]+)/g)].map((m) => m[1]);
    // Two upload sites; a rule applied to one of them is not a rule.
    expect(found).toHaveLength(2);
    expect(found).toEqual(["IMAGE_MIMETYPES", "IMAGE_MIMETYPES"]);
  });
});

describe("paperwork routes are bound to the DOCUMENT allowlist", () => {
  it("K2 accepts a PDF — a customs form genuinely is one", () => {
    const src = source("trips.ts");
    expect(allowlistFor(src, '"/:id/stops/:stopId/k2"')).toBe("DOCUMENT_MIMETYPES");
  });

  it("trip documents accept a PDF", () => {
    const src = source("trips.ts");
    expect(allowlistFor(src, '"/:id/documents"')).toBe("DOCUMENT_MIMETYPES");
  });

  it("feedback accepts a PDF", () => {
    expect(allowlistFor(source("feedback.ts"), "router.post(")).toBe("DOCUMENT_MIMETYPES");
  });
});

describe("every upload route is guarded at all", () => {
  it("no route calls upload.single without also asserting a mimetype", () => {
    // Non-vacuity AND completeness: a new upload route that forgets the check
    // would otherwise inherit multer's "anything up to 10MB" default silently.
    const unguarded: string[] = [];
    let uploads = 0;

    for (const file of ["trips.ts", "exceptions.ts", "feedback.ts"]) {
      const src = source(file);
      const starts = [...src.matchAll(/upload\.single\(/g)].map((m) => m.index as number);
      starts.forEach((start, i) => {
        uploads++;
        // A route body runs to the next upload.single registration.
        const slice = src.slice(start, starts[i + 1] ?? src.length);
        if (!/assertMimetype\(/.test(slice)) {
          unguarded.push(`${file}:${src.slice(0, start).split(/\r?\n/).length}`);
        }
      });
    }

    // SIX, not five: exceptions.ts has TWO upload endpoints (report, and
    // add-evidence). Writing 5 here is the same miscount that lets a rule be
    // applied to one of a pair and called done.
    expect(uploads, "the scan found no upload routes — it has stopped testing anything").toBe(6);
    expect(unguarded, `upload routes with no mimetype check: ${unguarded.join(", ")}`).toEqual([]);
  });
});

describe("K2 is not uploaded with resource_type auto", () => {
  it("the K2 upload does not pass resourceType", () => {
    // "auto" lets an undecodable file store as `raw` instead of failing, which
    // opens the pay gate over an asset the signed /image/ URL can never render.
    // K2 stores no resource_type column, so it cannot sign its way out.
    const src = source("trips.ts");
    const at = src.indexOf('uploadBuffer(req.file.buffer, "uwc/k2"');
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 400);
    expect(call).not.toContain('resourceType: "auto"');
  });
});
