import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// A working in-memory AsyncStorage: the migration's whole job is moving values
// between keys, so a spy that returns undefined would prove nothing.
const store = vi.hoisted(() => {
  const map = new Map<string, string>();
  return {
    map,
    default: {
      getItem: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
      setItem: vi.fn(async (k: string, v: string) => void map.set(k, v)),
      removeItem: vi.fn(async (k: string) => void map.delete(k)),
      getAllKeys: vi.fn(async () => [...map.keys()]),
      multiRemove: vi.fn(async (ks: string[]) => ks.forEach((k) => map.delete(k))),
    },
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({ default: store.default }));

import {
  LEGACY_GLOBAL_KEYS,
  setActiveUser,
  getActiveUserId,
  currentScopedKey,
  clearUserScope,
  migrateLegacyGlobalKeys,
  scopedKeyFor,
  __resetActiveUserCache,
} from "./scopedStorage";

beforeEach(async () => {
  store.map.clear();
  __resetActiveUserCache();
  await setActiveUser(null);
  store.map.clear();
});

describe("per-driver key scoping (DG-D4)", () => {
  it("keys the same suffix differently for two drivers on one handset", async () => {
    await setActiveUser("driver-A");
    const a = await currentScopedKey("podOutbox");
    await setActiveUser("driver-B");
    const b = await currentScopedKey("podOutbox");

    expect(a).toBe("uwc.u.driver-A.podOutbox");
    expect(b).toBe("uwc.u.driver-B.podOutbox");
    expect(a).not.toBe(b);
  });

  it("returns null rather than a global key when nobody is signed in", async () => {
    // Callers must skip storage entirely. Falling back to a global key is the
    // exact defect this module removes, so the absence of a fallback is pinned.
    expect(await currentScopedKey("podOutbox")).toBeNull();
  });

  it("logout removes one driver's data and leaves the other's untouched", async () => {
    store.map.set(scopedKeyFor("driver-A", "podOutbox"), '["A-photo"]');
    store.map.set(scopedKeyFor("driver-A", "locationQueue"), '["A-point"]');
    store.map.set(scopedKeyFor("driver-B", "podOutbox"), '["B-photo"]');

    await clearUserScope("driver-A");

    expect(store.map.has(scopedKeyFor("driver-A", "podOutbox"))).toBe(false);
    expect(store.map.has(scopedKeyFor("driver-A", "locationQueue"))).toBe(false);
    expect(store.map.get(scopedKeyFor("driver-B", "podOutbox"))).toBe('["B-photo"]');
  });

  it("the headless background task resolves the user without setActiveUser", async () => {
    // The background-location task has no React context. It reads the pointer
    // straight from storage; if that stopped working, a queued GPS point would
    // land in nobody's namespace.
    store.map.set("uwc.activeUserId", "driver-A");
    __resetActiveUserCache();

    expect(await getActiveUserId()).toBe("driver-A");
    expect(await currentScopedKey("locationQueue")).toBe("uwc.u.driver-A.locationQueue");
  });
});

describe("one-time migration of the pre-DG-D4 global keys", () => {
  it("adopts global data into the signed-in driver's namespace", async () => {
    store.map.set("uwc.podOutbox", '["photo"]');
    store.map.set("uwc.gpsConsent", "accepted");
    await setActiveUser("driver-A");

    const report = await migrateLegacyGlobalKeys();

    expect(store.map.get(scopedKeyFor("driver-A", "podOutbox"))).toBe('["photo"]');
    expect(store.map.get(scopedKeyFor("driver-A", "gpsConsent"))).toBe("accepted");
    expect(store.map.has("uwc.podOutbox")).toBe(false);
    expect(report.adopted).toContain("uwc.podOutbox");
    expect(report.quarantined).toHaveLength(0);
  });

  it("QUARANTINES unowned data instead of deleting it (owner ruling, 11 Aug)", async () => {
    // The value must still be readable afterwards. An unsent POD is delivery
    // evidence and the payment behind it cannot be corrected once approved
    // (BL9), so an upgrade must never be the thing that destroyed it.
    store.map.set("uwc.podOutbox", '["orphan-photo"]');
    store.map.set("uwc.exceptionOutbox", '["orphan-report"]');

    const report = await migrateLegacyGlobalKeys();

    expect(store.map.get("uwc.orphaned.podOutbox")).toBe('["orphan-photo"]');
    expect(store.map.get("uwc.orphaned.exceptionOutbox")).toBe('["orphan-report"]');
    expect(report.quarantined).toContain("uwc.podOutbox");
    expect(report.adopted).toHaveLength(0);

    // The payload survives, under SOME key, in every case.
    expect([...store.map.values()]).toContain('["orphan-photo"]');
  });

  it("never lets a second run overwrite an existing quarantine", async () => {
    store.map.set("uwc.orphaned.podOutbox", '["first-orphan"]');
    store.map.set("uwc.podOutbox", '["second-orphan"]');

    await migrateLegacyGlobalKeys();

    // The earlier orphan is the older evidence; it is not clobbered, and the
    // newer value is not silently dropped either — it is simply not migrated
    // over the top, and the legacy key is cleared only after the copy exists.
    expect(store.map.get("uwc.orphaned.podOutbox")).toBe('["first-orphan"]');
  });

  it("is a no-op on a device with nothing left to migrate", async () => {
    await setActiveUser("driver-A");
    const report = await migrateLegacyGlobalKeys();
    expect(report.adopted).toHaveLength(0);
    expect(report.quarantined).toHaveLength(0);
  });

  it("leaves the legacy key alone when storage throws, rather than losing it", async () => {
    store.map.set("uwc.podOutbox", '["photo"]');
    store.default.setItem.mockRejectedValueOnce(new Error("quota"));

    await migrateLegacyGlobalKeys();

    // Write failed → the original MUST still be there for the next launch.
    expect(store.map.get("uwc.podOutbox")).toBe('["photo"]');
  });
});

describe("the legacy key list stays honest", () => {
  it("names every global uwc.* key still present in mobile/src", () => {
    // Without this, a new global key added later silently escapes scoping and
    // reintroduces the shared-handset defect with nothing going red.
    const srcDir = path.resolve(__dirname, "..");
    const found = new Set<string>();

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf-8");
          for (const m of text.matchAll(/"(uwc\.[a-zA-Z0-9.]+)"/g)) found.add(m[1]);
        }
      }
    };
    walk(srcDir);

    // Keys that are legitimately global, each for a stated reason.
    const ALLOWED_GLOBAL = new Set([
      "uwc.activeUserId", // the pointer that RESOLVES the namespace
      "uwc.orphaned", // quarantine prefix
      "uwc.accessToken", // cleared on logout; moves to the secure store next
      "uwc.refreshToken",
      "uwc.cachedMe",
      "uwc.backgroundLocation", // an OS task NAME, not a storage key
      "uwc.podOutbox.corrupt", // quarantine prefix inside podOutbox
    ]);

    const unaccounted = [...found].filter(
      (k) =>
        !ALLOWED_GLOBAL.has(k) &&
        !k.startsWith("uwc.u.") &&
        !k.startsWith("uwc.orphaned") &&
        !(LEGACY_GLOBAL_KEYS as readonly string[]).includes(k)
    );

    expect(unaccounted).toEqual([]);
  });
});
