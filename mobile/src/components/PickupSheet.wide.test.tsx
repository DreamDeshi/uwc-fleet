import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import fs from "node:fs";
import path from "node:path";

/**
 * The pickup picker has TWO shapes, and the whole point of the wide work is
 * that they are different. These pin the difference so a later change cannot
 * quietly collapse them back into one.
 *
 * ⚠ BOTH SHAPES HAVE NOW BEEN WALKED BY HAND at their own widths, and these
 * assertions exist so a later change cannot collapse them without going red.
 * WIDE at 1440 and NARROW at 390 are both captured under
 * e2e/screenshots/overlay-sweep. On the phone the sheet still opens over its
 * dimmed backdrop, advances calendar -> hour -> minute, and writes the chosen
 * slot back to the form (verified by picking a different day and watching the
 * field change).
 */
// Normalize CRLF→LF: this file's line-search landmarks assume "\n", and a
// Windows checkout (core.autocrlf) can hand back "\r\n" — which makes an
// exact-string indexOf() silently return -1 rather than failing loudly. That
// happened here: "return (\n    <Modal" stopped matching after a rebase
// checked the file out with CRLF, so the "slice to the Modal" span ran to
// end-of-file instead, and picked up the REAL Modal it was meant to exclude.
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), "utf-8").replace(/\r\n/g, "\n");
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the pickup picker keeps two shapes", () => {
  it("INLINE renders no Modal and no backdrop", () => {
    const src = codeOnly(read("./PickupSheet.tsx"));
    // ⚠ NOT the bare substring "if (inline) return" — the confirm button's
    // onPress handler (`if (inline) return setStep("date");`) also matches
    // that, and sits EARLIER in the file inside the shared `body` the Modal
    // branch renders too. indexOf() on the ambiguous string silently grabbed
    // that occurrence instead of the render branch below, so the "slice to
    // the Modal" span covered most of the file — including the real Modal —
    // and this assertion would have failed on the render branch it was
    // written to protect. Anchor on the full, unique statement instead.
    const INLINE_RENDER = "if (inline) return <View style={styles.inlineCard}>";
    expect(src, "the inline render branch must exist").toContain(INLINE_RENDER);
    // The inline branch returns before the Modal, so the wide path cannot dim
    // the page or trap the form behind a backdrop.
    const inlineBranch = src.slice(src.indexOf(INLINE_RENDER), src.indexOf("return (\n    <Modal"));
    expect(inlineBranch.length, "the branches moved").toBeGreaterThan(10);
    expect(inlineBranch).not.toContain("Modal");
    expect(inlineBranch).not.toContain("backdrop");
  });

  it("NARROW still renders the Modal, the backdrop and the slide", () => {
    const src = codeOnly(read("./PickupSheet.tsx"));
    expect(src, "phones keep the sheet").toContain("<Modal visible={visible} transparent animationType=\"slide\"");
    expect(src, "phones keep the dimmed backdrop").toContain("styles.backdrop");
  });

  it("the form mounts the modal ONLY when narrow, and the inline picker only when wide", () => {
    // Both at once would put a sheet and an inline picker on the same screen.
    const src = codeOnly(read("../screens/requestor/BookingFormScreen.tsx"));
    expect(src, "the modal is gated on !wide").toContain("{!wide && (");
    expect(src, "the inline picker is gated on wide").toContain("picker={wide ? pickupPicker : null}");
  });

  it("the header shows a TIME on every step — no empty placeholder", () => {
    const src = codeOnly(read("./PickupSheet.tsx"));
    // It rendered a literal "— : —" on the date step, which reads as a render
    // failure. `slot` always carries an hour and a minute.
    expect(src).not.toContain('"— : —"');
    expect(src).toContain("{formatClock(draft.hour, draft.minute)}");
  });
});
