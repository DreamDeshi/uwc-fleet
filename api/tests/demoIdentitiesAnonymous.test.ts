import { describe, it, expect } from "vitest";
import identities from "../prisma/demoIdentities.json";

/**
 * THE ANONYMITY RULE, MADE ENFORCEABLE.
 *
 * The demo is the instance a stranger reaches by scanning the poster QR. Its
 * people are labelled "Driver 1..9" and "Requestor 1" on purpose: an invented
 * name like "Tan Wei Ming" is indistinguishable from a real UWC employee to
 * anyone reading the screen, so a demo that is anonymous only to people who
 * know which names are fake is not anonymous.
 *
 * ⚠ WHY A TEST AND NOT A COMMENT. That decision was written down in
 * seed-demo-trips.ts on 6 Aug 2026 and it was still nearly reversed on 20 Aug —
 * "Driver 1" reads as unfinished, so the complaint recurs, and a comment cannot
 * go red. AGENTS.md has the general form of this: a comment that names a
 * condition which would invalidate the design wants an assertion, because
 * predictions do not get read at the moment they matter.
 *
 * If a future change genuinely should put real names on the demo, this test is
 * the thing to delete — deliberately, in the same commit, with the reason. That
 * is the point: reversing the decision has to be an act, not a drift.
 */
describe("demo display names stay anonymous", () => {
  const drivers = Object.entries(identities.drivers);
  const requestors = Object.entries(identities.requestors);

  it("covers every seeded demo account", () => {
    // POSITIVE CONTROL. An empty or renamed section satisfies every "none of
    // them looks like a person" assertion below by having nothing to check.
    expect(drivers.length, "driver list is empty or moved").toBe(9);
    expect(requestors.length, "requestor list is empty or moved").toBeGreaterThanOrEqual(1);
  });

  it("labels every driver by index, never by a name", () => {
    for (const [phone, name] of drivers) {
      expect(name, `${phone} is not an indexed label`).toMatch(/^Driver \d+$/);
    }
  });

  it("labels every requestor by index", () => {
    for (const [phone, name] of requestors) {
      expect(name, `${phone} is not an indexed label`).toMatch(/^Requestor \d+$/);
    }
  });

  it("uses one convention, not three", () => {
    // The defect this file was created for: the list held "Driver 1", "Driver 7"
    // and "Demo Driver P2" at once. Anything carrying an extra word is a second
    // convention, and "P2" was a ZONE code wearing an index's clothes.
    for (const [phone, name] of [...drivers, ...requestors]) {
      expect(name.split(" ").length, `${phone} = "${name}" has an extra word`).toBe(2);
    }
  });

  it("never reuses a label for two accounts", () => {
    // "Demo Driver P2" -> "Driver 2" was the instruction, and it would have
    // collided with +60100000102. Hence Driver 9.
    const names = [...drivers, ...requestors].map(([, n]) => n);
    expect(new Set(names).size, "two accounts share a display name").toBe(names.length);
  });

  it("keeps the phone numbers synthetic", () => {
    // A real staff number on the demo would leak an identity even behind an
    // anonymous label. The seeded demo range is +6010000010x, plus the one
    // extra driver the active-trip seeder needs.
    for (const [phone] of [...drivers, ...requestors]) {
      expect(phone, `${phone} is not in the synthetic demo range`).toMatch(/^\+60(10000010[1-8]|117822000|199990001)$/);
    }
  });
});
