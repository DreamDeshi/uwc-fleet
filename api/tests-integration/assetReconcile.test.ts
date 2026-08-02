import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma, resetDb, loginAs, REQUESTOR } from "./helpers/harness";
import { firstRouteTypeId, bookTrip, userIdByPhone, DRIVERS } from "./helpers/flow";
import {
  referencedPublicIds,
  findOrphans,
  implausibleScan,
  type CloudAsset,
  type ReferenceScan,
} from "../src/lib/assetReconcile";

/**
 * ASSET RECONCILIATION — proof it works when there is something to PROTECT.
 *
 * The reconciler decides what to delete from Cloudinary by subtracting the ids
 * the database still references from everything in the account. Until now it
 * had only ever run against an EMPTY database, where "keep nothing, delete
 * everything" is trivially correct and tells you nothing. The failure that
 * matters is the opposite one: a reference source the scan does not know how to
 * read, whose live assets are therefore classified as garbage and destroyed.
 *
 * ⚠ A MISSED ORPHAN COSTS STORAGE. A MISSED REFERENCE DESTROYS A POD — the
 * evidence that gates a driver's pay, unrecoverable once deleted. So every test
 * below seeds a REAL row through a real booking and asserts the asset SURVIVES
 * classification; the orphan assertions are the cheap half.
 *
 * All five upload paths in the API are covered, including the one that nearly
 * broke it: feedback is AuditLog-backed with no table of its own and hides its
 * id inside the action TEXT.
 */

const REF = {
  pod: "uwc/pod/RECON-TKT-stop-1",
  podLegacy: "uwc/pod/RECON-TKT-stop-2",
  k2: "uwc/k2/RECON-TKT-stop-1-k2",
  doc: "uwc/documents/RECON-doc-image",
  docRaw: "uwc/documents/RECON-doc-raw.pdf",
  docExtInDb: "uwc/documents/RECON-doc-ext.jpg",
  evidence: "uwc/exceptions/RECON-evidence",
  feedback: "uwc/feedback/RECON-feedback",
};

/** Assets that genuinely belong to nobody — the only things safe to delete. */
const ORPHANS = [
  "uwc/pod/ORPHAN-from-an-earlier-wipe",
  "uwc/k2/ORPHAN-k2",
  "uwc/feedback/ORPHAN-feedback",
];

const asset = (publicId: string, over: Partial<CloudAsset> = {}): CloudAsset => ({
  publicId,
  type: "authenticated",
  resourceType: "image",
  folder: publicId.slice(0, publicId.lastIndexOf("/")),
  bytes: 1000,
  createdAt: "2026-07-20T00:00:00Z",
  ...over,
});

/** Seed one real trip and hang an asset off every reference path there is. */
async function seedEveryReferencePath() {
  const requestor = await loginAs(REQUESTOR);
  const rt = await firstRouteTypeId(requestor);
  const trip = await bookTrip(requestor, ["P1", "P2"], rt);
  const stops = [...trip.stops].sort((a, b) => a.sequence - b.sequence);
  const driverId = await userIdByPhone(DRIVERS.PND.phone);

  // 1 + 2. POD and K2 on a stop, stored the modern way (public_id present).
  await prisma.tripStop.update({
    where: { id: stops[0].id },
    data: {
      pod_photo: `https://res.cloudinary.com/c/image/authenticated/${REF.pod}`,
      pod_public_id: REF.pod,
      k2_photo: `https://res.cloudinary.com/c/image/authenticated/${REF.k2}`,
      k2_public_id: REF.k2,
    },
  });

  // A LEGACY stop: URL only, no public_id. These predate the privacy work and
  // are exactly the rows a naive scan drops — the id has to be parsed back out
  // of the URL or a live POD is deleted.
  await prisma.tripStop.update({
    where: { id: stops[1].id },
    data: {
      pod_photo: `https://res.cloudinary.com/c/image/authenticated/v1234/${REF.podLegacy}.jpg`,
      pod_public_id: null,
    },
  });

  // 3. Requestor paperwork: a modern image, a RAW pdf (whose public_id keeps
  // its extension), a legacy URL-only row, and one where the DB stores an
  // extension the census will not — the lenient-match case.
  await prisma.tripDocument.createMany({
    data: [
      { trip_id: trip.id, type: "do_photo", file_url: "https://x/y", public_id: REF.doc, resource_type: "image" },
      { trip_id: trip.id, type: "other", file_url: "https://x/y", public_id: REF.docRaw, resource_type: "raw" },
      { trip_id: trip.id, type: "other", file_url: "https://x/y", public_id: REF.docExtInDb, resource_type: "image" },
      {
        trip_id: trip.id,
        type: "k2_form",
        file_url: "https://res.cloudinary.com/c/image/authenticated/v99/uwc/documents/RECON-doc-legacy.png",
      },
    ],
  });

  // 4. Exception evidence.
  const exc = await prisma.tripException.create({
    data: {
      trip_id: trip.id,
      client_occurrence_id: "recon-occurrence-1",
      category: "documentation",
      reason: "reconciliation fixture",
      reported_by: driverId,
    },
  });
  await prisma.exceptionEvidence.create({
    data: {
      exception_id: exc.id,
      client_evidence_id: "recon-evidence-1",
      url: "https://x/y",
      public_id: REF.evidence,
      uploaded_by: driverId,
    },
  });

  // 5. ⚠ FEEDBACK — the one with no table of its own. Same shape routes/feedback
  // writes: the id is embedded in the action TEXT, marker last.
  await prisma.auditLog.create({
    data: {
      user_id: driverId,
      action: `App is slow\n[screen: Home]\n[image: ${REF.feedback}]`,
      table_name: "Feedback",
      record_id: "bug",
    },
  });

  return { tripId: trip.id, driverId };
}

describe("Cloudinary reconciliation against a populated database", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("finds a reference from every one of the five upload paths", async () => {
    await seedEveryReferencePath();
    const scan = await referencedPublicIds(prisma);

    // Each source must contribute — a source silently returning nothing is the
    // exact shape of the bug this file exists to catch.
    expect(scan.bySource["TripStop.pod"]).toBeGreaterThan(0);
    expect(scan.bySource["TripStop.k2"]).toBeGreaterThan(0);
    expect(scan.bySource["TripDocument"]).toBeGreaterThan(0);
    expect(scan.bySource["ExceptionEvidence"]).toBeGreaterThan(0);
    expect(scan.bySource["Feedback(AuditLog)"]).toBeGreaterThan(0);
  });

  it("KEEPS every referenced asset and deletes only the genuine orphans", async () => {
    await seedEveryReferencePath();
    const scan = await referencedPublicIds(prisma);

    const census = [
      ...Object.values(REF).map((id) => asset(id)),
      asset("uwc/documents/RECON-doc-legacy.png"),
      // The lenient-match case from the other side: the census has NO extension
      // while the DB stored one.
      asset("uwc/documents/RECON-doc-ext"),
      ...ORPHANS.map((id) => asset(id)),
    ];

    const orphans = findOrphans(census, scan);
    const orphanIds = orphans.map((o) => o.publicId).sort();

    expect(orphanIds).toEqual([...ORPHANS].sort());
    // Stated the other way round too, because this is the assertion whose
    // failure destroys evidence rather than merely wasting disk.
    for (const referenced of Object.values(REF)) {
      expect(orphanIds, `${referenced} was classified as an orphan`).not.toContain(referenced);
    }
  });

  it("recovers the id of a LEGACY row that has a URL but no public_id", async () => {
    await seedEveryReferencePath();
    const scan = await referencedPublicIds(prisma);
    // Both the POD and the document legacy shapes.
    expect(findOrphans([asset(REF.podLegacy)], scan)).toHaveLength(0);
    expect(findOrphans([asset("uwc/documents/RECON-doc-legacy.png")], scan)).toHaveLength(0);
  });

  // ⚠ THE REGRESSION GUARD, AND IT WAS PROVEN BY BREAKING IT. Disabling the
  // Feedback branch in referencedPublicIds turns THREE tests in this file red —
  // this one, the five-sources one, and, most importantly, the orphan
  // classification, whose delete list grows from 3 to 4 as the live feedback
  // asset falls into it. That is the exact production failure: an attachment
  // nobody can recover, deleted because the scan could not see its id.
  it("keeps a feedback attachment whose id exists ONLY inside AuditLog text", async () => {
    await seedEveryReferencePath();
    const scan = await referencedPublicIds(prisma);

    expect(scan.ids.has(REF.feedback)).toBe(true);
    const orphans = findOrphans([asset(REF.feedback), asset("uwc/feedback/ORPHAN-feedback")], scan);
    expect(orphans.map((o) => o.publicId)).toEqual(["uwc/feedback/ORPHAN-feedback"]);
  });

  it("does not mistake ordinary audit rows for feedback attachments", async () => {
    await seedEveryReferencePath();
    // A non-Feedback audit row mentioning something bracket-shaped must not
    // contribute a reference, or real orphans stop being collectable.
    const driverId = await userIdByPhone(DRIVERS.PND.phone);
    await prisma.auditLog.create({
      data: { user_id: driverId, action: "[image: uwc/pod/NOT-A-REAL-REFERENCE]", table_name: "Trip", record_id: "x" },
    });
    const scan = await referencedPublicIds(prisma);
    expect(scan.ids.has("uwc/pod/NOT-A-REAL-REFERENCE")).toBe(false);
  });

  it("treats an empty database as legitimately having no references", async () => {
    // The wiped-DB case: nothing referenced, nothing plausible-looking missing.
    const scan = await referencedPublicIds(prisma);
    expect(scan.ids.size).toBe(0);
    expect(implausibleScan(scan)).toBeNull();
    expect(findOrphans([asset(ORPHANS[0])], scan)).toHaveLength(1);
  });

  // ⚠ FAIL CLOSED. If rows that should carry references resolve to none, the
  // parser is broken and EVERY live asset would look like garbage. That must
  // stop the run, not delete the account.
  it("refuses to classify when rows exist but no ids resolved", async () => {
    const broken: ReferenceScan = {
      ids: new Set(),
      bySource: {},
      rows: { TripStop_withAsset: 3, TripDocument: 1, ExceptionEvidence: 0, Feedback: 0 },
    };
    expect(implausibleScan(broken)).toMatch(/reference parsing is broken/);
  });

  it("does not fire the fail-closed check on a genuinely empty database", async () => {
    const empty: ReferenceScan = {
      ids: new Set(),
      bySource: {},
      rows: { TripStop_withAsset: 0, TripDocument: 0, ExceptionEvidence: 0, Feedback: 0 },
    };
    expect(implausibleScan(empty)).toBeNull();
  });
});
