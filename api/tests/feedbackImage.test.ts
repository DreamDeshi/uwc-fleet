import { describe, it, expect } from "vitest";
import { parseFeedbackAction } from "../src/routes/feedback";

// Feedback rows are AuditLog rows (the Prisma schema is frozen), so an attached
// screenshot's Cloudinary public id rides in the same free-text `action` field
// behind a marker. This is the round-trip that keeps that honest.
describe("parseFeedbackAction", () => {
  it("a row filed before screenshots existed is unchanged", () => {
    expect(parseFeedbackAction("The map is blank")).toEqual({
      message: "The map is blank",
      imageId: null,
    });
  });

  it("keeps the screen tag with the message when there is no image", () => {
    const action = "The map is blank\n[screen: driver-profile]";
    expect(parseFeedbackAction(action)).toEqual({ message: action, imageId: null });
  });

  it("splits the image id off the end", () => {
    const { message, imageId } = parseFeedbackAction(
      "The map is blank\n[screen: driver-profile]\n[image: uwc/feedback/abc123]"
    );
    expect(message).toBe("The map is blank\n[screen: driver-profile]");
    expect(imageId).toBe("uwc/feedback/abc123");
  });

  it("works with an image but no screen tag", () => {
    expect(parseFeedbackAction("Broken\n[image: uwc/feedback/x]")).toEqual({
      message: "Broken",
      imageId: "uwc/feedback/x",
    });
  });

  it("text that LOOKS like a marker cannot spoof one", () => {
    // The real marker is written last and the pattern is anchored to the end of
    // the string, so a user typing a marker mid-message is just message text.
    const action = "I saw [image: not-a-real-id] in the logs\n[screen: admin]";
    expect(parseFeedbackAction(action)).toEqual({ message: action, imageId: null });
  });

  it("a user-typed marker at the very end yields no asset to sign", () => {
    // Worst case it parses as an id — but it is a made-up public id, so
    // signedAssetUrl produces a URL Cloudinary has no asset for. It cannot
    // reach another user's private asset, because the id space is ours and the
    // upload folder is fixed.
    const { imageId } = parseFeedbackAction("hi\n[image: uwc/feedback/whatever]");
    expect(imageId).toBe("uwc/feedback/whatever");
  });

  it("a message containing newlines survives intact", () => {
    const { message, imageId } = parseFeedbackAction(
      "line one\nline two\n[image: uwc/feedback/z]"
    );
    expect(message).toBe("line one\nline two");
    expect(imageId).toBe("uwc/feedback/z");
  });
});
