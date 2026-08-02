import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The storage edges in this project are normally left untested (see
 * podOutbox.test.ts) — plain-node vitest, no react-native mocks. This one earns
 * an exception: it is the module standing between a driver's POD photo and
 * silent deletion by the OS, and the evidence it protects is what gates his pay.
 *
 * The fake filesystem below is deliberately tiny: it models existence, copying,
 * deletion and listing, which is the entire surface persistPodPhoto/sweep use.
 */

const h = vi.hoisted(() => ({
  platform: { OS: "android" as string },
  // uri -> "file" | "dir". A Map is enough to answer every question asked.
  entries: new Map<string, "file" | "dir">(),
  failCopy: { value: false },
}));

vi.mock("react-native", () => ({ Platform: h.platform }));

vi.mock("expo-file-system", () => {
  // Join without normalising: trim only the slashes at the seam, so the
  // `file:///` triple slash of an absolute URI survives intact.
  const join = (...parts: unknown[]) =>
    parts
      .map((p) => (typeof p === "string" ? p : (p as { uri: string }).uri))
      .map((s, i) => (i === 0 ? s.replace(/\/+$/, "") : s.replace(/^\/+|\/+$/g, "")))
      .join("/");

  class Directory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return h.entries.get(this.uri) === "dir";
    }
    create() {
      h.entries.set(this.uri, "dir");
    }
    list() {
      const prefix = `${this.uri}/`;
      return [...h.entries.entries()]
        .filter(([uri, kind]) => kind === "file" && uri.startsWith(prefix))
        .map(([uri]) => new File(uri));
    }
  }

  class File {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return h.entries.get(this.uri) === "file";
    }
    get extension() {
      const m = this.uri.match(/\.[a-z0-9]+$/i);
      return m ? m[0] : "";
    }
    copy(dest: File) {
      if (h.failCopy.value) throw new Error("no space left on device");
      h.entries.set(dest.uri, "file");
    }
    delete() {
      h.entries.delete(this.uri);
    }
  }

  return { Directory, File, Paths: { document: new Directory("file:///doc") } };
});

const { persistPodPhoto, sweepPodPhotos, POD_PHOTO_DIR } = await import("./podPhotoStore");

const CACHE_PHOTO = "file:///cache/ImagePicker/abc123.jpg";
const DOC_DIR = `file:///doc/${POD_PHOTO_DIR}`;
const NOW = 1_785_000_000_000;

beforeEach(() => {
  h.entries.clear();
  h.platform.OS = "android";
  h.failCopy.value = false;
  h.entries.set(CACHE_PHOTO, "file");
});

describe("persisting a queued POD photo", () => {
  it("copies a cache capture into the document directory", () => {
    const uri = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    expect(uri).toBe(`${DOC_DIR}/stop-1-${NOW}.jpg`);
    expect(h.entries.get(uri)).toBe("file");
    // ⚠ The point of the whole module: the returned URI is NOT the cache one,
    // because that is the path Android is free to reclaim.
    expect(uri).not.toBe(CACHE_PHOTO);
  });

  it("creates the directory on first use", () => {
    expect(h.entries.has(DOC_DIR)).toBe(false);
    persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    expect(h.entries.get(DOC_DIR)).toBe("dir");
  });

  it("gives a RETAKE its own file rather than racing the old one", () => {
    const first = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    const second = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW + 5000);
    expect(second).not.toBe(first);
    expect(h.entries.get(first)).toBe("file"); // superseded; the sweep collects it
    expect(h.entries.get(second)).toBe("file");
  });

  // ⚠ FAIL OPEN. Returning the original cache URI is no worse than the
  // behaviour being replaced. Throwing would refuse to queue the delivery and
  // lose it outright — storage housekeeping must never cost a driver his stop.
  it("returns the original URI when the copy fails", () => {
    h.failCopy.value = true;
    expect(persistPodPhoto(CACHE_PHOTO, "stop-1", NOW)).toBe(CACHE_PHOTO);
  });

  it("returns the original URI when the source is already gone", () => {
    h.entries.delete(CACHE_PHOTO);
    expect(persistPodPhoto(CACHE_PHOTO, "stop-1", NOW)).toBe(CACHE_PHOTO);
  });

  it("leaves a web data: URI alone — already durable across reloads", () => {
    h.platform.OS = "web";
    const data = "data:image/jpeg;base64,AAAA";
    expect(persistPodPhoto(data, "stop-1", NOW)).toBe(data);
  });

  it("leaves a non-file URI alone even on native", () => {
    expect(persistPodPhoto("https://example.com/x.jpg", "stop-1", NOW)).toBe(
      "https://example.com/x.jpg"
    );
  });
});

describe("sweeping photos the outbox no longer references", () => {
  it("deletes an orphan and keeps what is still queued", () => {
    const keep = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    const orphan = persistPodPhoto(CACHE_PHOTO, "stop-2", NOW);

    sweepPodPhotos([keep]);

    expect(h.entries.get(keep)).toBe("file");
    expect(h.entries.has(orphan)).toBe(false);
  });

  it("collects the superseded file after a retake", () => {
    const first = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    const second = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW + 5000);
    sweepPodPhotos([second]);
    expect(h.entries.has(first)).toBe(false);
    expect(h.entries.get(second)).toBe("file");
  });

  it("empties the directory when nothing is queued", () => {
    persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    sweepPodPhotos([]);
    expect([...h.entries.keys()].filter((k) => k.startsWith(`${DOC_DIR}/`))).toEqual([]);
  });

  it("never touches the original cache file", () => {
    const kept = persistPodPhoto(CACHE_PHOTO, "stop-1", NOW);
    sweepPodPhotos([kept]);
    // The sweep is scoped to its own directory; the picker's cache entry is not
    // ours to delete and may still be referenced by the screen.
    expect(h.entries.get(CACHE_PHOTO)).toBe("file");
  });

  it("does nothing when the directory has never been created", () => {
    expect(() => sweepPodPhotos([])).not.toThrow();
  });

  it("is a no-op on web", () => {
    h.platform.OS = "web";
    h.entries.set(`${DOC_DIR}/stop-1-1.jpg`, "file");
    sweepPodPhotos([]);
    expect(h.entries.has(`${DOC_DIR}/stop-1-1.jpg`)).toBe(true);
  });
});
