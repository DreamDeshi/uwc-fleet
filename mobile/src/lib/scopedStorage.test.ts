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
  pruneQuarantine,
  MAX_ORPHAN_ENTRIES,
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

    const report = await migrateLegacyGlobalKeys(5000);

    expect(store.map.get("uwc.orphaned.podOutbox.5000")).toBe('["orphan-photo"]');
    expect(store.map.get("uwc.orphaned.exceptionOutbox.5000")).toBe('["orphan-report"]');
    expect(report.quarantined).toContain("uwc.podOutbox");
    expect(report.adopted).toHaveLength(0);

    // The payload survives, under SOME key, in every case.
    expect([...store.map.values()]).toContain('["orphan-photo"]');
  });

  it("keeps BOTH orphans when a second one arrives — neither is clobbered", async () => {
    // Regression: the first version skipped the write when the destination was
    // taken but still removed the legacy key, DELETING the second orphan.
    store.map.set("uwc.orphaned.podOutbox.1000", '["first-orphan"]');
    store.map.set("uwc.podOutbox", '["second-orphan"]');

    await migrateLegacyGlobalKeys(2000);

    const values = [...store.map.values()];
    expect(values).toContain('["first-orphan"]');
    expect(values).toContain('["second-orphan"]');
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

describe("the quarantine ceiling (DG-O10 — nothing else ever clears it)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("drops entries past the age cap and NAMES them", async () => {
    const now = 100 * DAY;
    store.map.set(`uwc.orphaned.podOutbox.${now - 31 * DAY}`, '["stale-photo"]');
    store.map.set(`uwc.orphaned.podOutbox.${now - 2 * DAY}`, '["recent-photo"]');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const dropped = await pruneQuarantine(now);

    expect(dropped).toEqual([`uwc.orphaned.podOutbox.${now - 31 * DAY}`]);
    expect([...store.map.values()]).toContain('["recent-photo"]');
    expect([...store.map.values()]).not.toContain('["stale-photo"]');
    // Silent expiry is indistinguishable from a quarantine that never held
    // anything — the whole point of quarantining was to be able to say so.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("uwc.orphaned.podOutbox");
    warn.mockRestore();
  });

  it("caps the count, dropping oldest first", async () => {
    const now = 100 * DAY;
    for (let i = 0; i < MAX_ORPHAN_ENTRIES + 3; i++) {
      store.map.set(`uwc.orphaned.podOutbox.${now - i * 1000}`, `["item-${i}"]`);
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const dropped = await pruneQuarantine(now);

    expect(dropped).toHaveLength(3);
    expect(store.map.size).toBe(MAX_ORPHAN_ENTRIES);
    // Oldest go first: the three highest `i` values are the oldest stamps.
    expect([...store.map.values()]).toContain('["item-0"]');
    expect([...store.map.values()]).not.toContain(`["item-${MAX_ORPHAN_ENTRIES + 2}"]`);
    vi.restoreAllMocks();
  });

  it("leaves a quarantine inside both limits completely alone", async () => {
    const now = 100 * DAY;
    store.map.set(`uwc.orphaned.podOutbox.${now - 1000}`, '["keep"]');
    expect(await pruneQuarantine(now)).toEqual([]);
    expect(store.map.get(`uwc.orphaned.podOutbox.${now - 1000}`)).toBe('["keep"]');
  });

  it("never touches a live per-user key", async () => {
    const now = 100 * DAY;
    store.map.set(scopedKeyFor("driver-A", "podOutbox"), '["live"]');
    store.map.set(`uwc.orphaned.podOutbox.${now - 90 * DAY}`, '["ancient"]');
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await pruneQuarantine(now);

    expect(store.map.get(scopedKeyFor("driver-A", "podOutbox"))).toBe('["live"]');
    vi.restoreAllMocks();
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
