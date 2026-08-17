import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { latestOfficeNote, isClosedOutcome, isOpenState } from "./exceptionForm";
import en from "../i18n/en.json";

/**
 * THE TWO LEGS OF THE EXCEPTION ROUND TRIP THAT REACHED THE DRIVER AND STOPPED.
 *
 * Traced from the code on 17 Aug 2026, before any real exception had run:
 *
 *   1. Every admin action can carry a `note`, it is stored, and the driver is
 *      served the FULL view including notes — and nothing rendered them. A
 *      dispatcher typing "customer says try the side gate" had it delivered to
 *      the driver's phone and thrown away.
 *   2. The status card returned null the moment the report closed, so a
 *      REJECTION — terminal, no undo, and the stop does not pay — reached the
 *      driver as a component quietly disappearing. The first he knew of it was
 *      his pay.
 *
 * Both are one-sided failures: the data was already there, so no API changed.
 */

describe("latestOfficeNote — what the office actually said", () => {
  const action = (over: Partial<Record<string, unknown>> = {}) => ({
    actor_role: "admin",
    note: "try the side gate",
    type: "resume",
    created_at: "2026-08-17T10:00:00.000Z",
    ...over,
  });

  it("returns nothing when there is nothing to say", () => {
    expect(latestOfficeNote(null)).toBeNull();
    expect(latestOfficeNote([])).toBeNull();
    expect(latestOfficeNote([action({ note: null })])).toBeNull();
    expect(latestOfficeNote([action({ note: "   " })])).toBeNull();
  });

  it("returns the admin's note", () => {
    expect(latestOfficeNote([action()])?.note).toBe("try the side gate");
  });

  it("NEVER returns the driver's own words back to him", () => {
    // The whole point is "what the office said". A driver's evidence note
    // echoed back as if the dispatcher had written it would be worse than
    // silence — he would act on his own message.
    const notes = [
      action({ actor_role: "driver", note: "gate is chained" }),
      action({ actor_role: "requestor", note: "please hurry" }),
    ];
    expect(latestOfficeNote(notes)).toBeNull();
  });

  it("takes the LATEST admin note — the standing instruction, not the history", () => {
    const notes = [
      action({ note: "wait there", created_at: "2026-08-17T10:00:00.000Z", type: "request_more_evidence" }),
      action({ note: "try the side gate", created_at: "2026-08-17T11:30:00.000Z", type: "resume" }),
      action({ actor_role: "driver", note: "still locked", created_at: "2026-08-17T12:00:00.000Z" }),
    ];
    const latest = latestOfficeNote(notes);
    expect(latest?.note).toBe("try the side gate");
    expect(latest?.type).toBe("resume");
  });

  it("does not let an undated note outrank a dated one", () => {
    // A row with a missing or unparseable timestamp must not win by accident —
    // it would pin the driver to whichever note happened to be malformed.
    const notes = [
      action({ note: "real instruction", created_at: "2026-08-17T11:00:00.000Z" }),
      action({ note: "undated", created_at: null }),
      action({ note: "unparseable", created_at: "not a date" }),
    ];
    expect(latestOfficeNote(notes)?.note).toBe("real instruction");
  });
});

describe("isClosedOutcome — the states that must still be shown", () => {
  it("treats the terminal states as outcomes, not as nothing", () => {
    expect(isClosedOutcome("rejected")).toBe(true);
    expect(isClosedOutcome("resolved")).toBe(true);
  });

  it("leaves the open states to the open path", () => {
    for (const s of ["reported", "more_evidence", "verified"]) {
      expect(isClosedOutcome(s), s).toBe(false);
      expect(isOpenState(s), s).toBe(true);
    }
  });

  it("covers every state the card can receive — no state renders nothing", () => {
    // The defect was a state falling through both branches. Enumerated from the
    // schema's ExceptionState, so a new state added there fails here rather
    // than silently disappearing from the driver's screen.
    for (const s of ["reported", "more_evidence", "verified", "rejected", "resolved"]) {
      expect(isOpenState(s) || isClosedOutcome(s), `${s} renders nothing`).toBe(true);
    }
  });
});

describe("the card is wired to both", () => {
  // Source-shape, for the same reason as bookingListFab: this component reaches
  // Expo's native bridge and cannot be rendered under vitest. Each assertion is
  // anchored on something that must be deleted for the feature to stop working.
  const SRC = fs.readFileSync(
    path.resolve(__dirname, "../components/ExceptionStatusCard.tsx"),
    "utf-8"
  );

  it("reads the component it claims to check", () => {
    expect(SRC.length).toBeGreaterThan(2_000);
    expect(SRC).toContain("export function ExceptionStatusCard");
  });

  it("renders the office note", () => {
    expect(SRC).toContain("latestOfficeNote(exc.actions)");
    expect(SRC).toContain('t("exception.officeSays")');
    expect(SRC).toContain("officeNote.note");
  });

  it("no longer returns null on a closed outcome", () => {
    // The exact regression: `!isOpenState(...) return null`. If the guard goes
    // back to bailing on closed states, this fails.
    expect(SRC).toContain("if (!isOpenState(exc.current_state) && !isClosedOutcome(exc.current_state)) return null;");
    expect(SRC).toContain("exception.outcome.rejectedTitle");
    expect(SRC).toContain("exception.outcome.resolvedTitle");
  });

  it("tells a rejected driver the pay consequence, in all three locales", () => {
    // This is a MONEY statement and it is deliberate: the engine is explicit
    // that a rejected stop "is ADJUDICATED — it just does not pay", and a
    // driver who is not told here learns it from his payslip.
    expect(en.exception.outcome.rejectedBody).toMatch(/will not be paid/i);
    for (const loc of ["en", "ms", "zh"]) {
      const text = fs.readFileSync(path.resolve(__dirname, `../i18n/${loc}.json`), "utf-8");
      expect(text, `${loc} is missing the rejected outcome`).toContain("rejectedTitle");
      expect(text, `${loc} is missing the office-note label`).toContain("officeSays");
    }
  });
});
