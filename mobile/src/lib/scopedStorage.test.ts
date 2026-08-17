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

  it("logout clears one driver's non-evidence data and never touches the other's", async () => {
    store.map.set(scopedKeyFor("driver-A", "locationQueue"), '["A-point"]');
    store.map.set(scopedKeyFor("driver-A", "gpsConsent"), "accepted");
    store.map.set(scopedKeyFor("driver-A", "bgTrip"), "trip-1");
    store.map.set(scopedKeyFor("driver-B", "podOutbox"), '["B-photo"]');

    await clearUserScope("driver-A");

    expect(store.map.has(scopedKeyFor("driver-A", "locationQueue"))).toBe(false);
    expect(store.map.has(scopedKeyFor("driver-A", "gpsConsent"))).toBe(false);
    expect(store.map.has(scopedKeyFor("driver-A", "bgTrip"))).toBe(false);
    expect(store.map.get(scopedKeyFor("driver-B", "podOutbox"))).toBe('["B-photo"]');
  });

  it("logout KEEPS the driver's unsent PODs — the dialog promised they would be", async () => {
    // Owner ruling 12 Aug 2026. Namespacing already stops B reading them, so
    // deleting bought no isolation and only destroyed delivery evidence — while
    // the confirm says "they will be kept on this phone for you".
    store.map.set(scopedKeyFor("driver-A", "podOutbox"), '["A-unsent-photo"]');
    store.map.set(scopedKeyFor("driver-A", "podOutbox.corrupt.1000"), "raw-bytes");
    store.map.set(scopedKeyFor("driver-A", "locationQueue"), '["A-point"]');

    await clearUserScope("driver-A");

    expect(store.map.get(scopedKeyFor("driver-A", "podOutbox"))).toBe('["A-unsent-photo"]');
    expect(store.map.get(scopedKeyFor("driver-A", "podOutbox.corrupt.1000"))).toBe("raw-bytes");
    // ...and the non-evidence key beside it is still gone.
    expect(store.map.has(scopedKeyFor("driver-A", "locationQueue"))).toBe(false);
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

  it("ages out a SURVIVING outbox by item, so an ex-driver's photos do not sit forever", async () => {
    // The outbox key carries no timestamp — its ITEMS do — so the ceiling is
    // applied to contents. This is the condition attached to letting the outbox
    // survive logout at all.
    const now = 100 * DAY;
    store.map.set(
      scopedKeyFor("driver-A", "podOutbox"),
      JSON.stringify([
        { stopId: "old", queuedAt: new Date(now - 40 * DAY).toISOString() },
        { stopId: "recent", queuedAt: new Date(now - 2 * DAY).toISOString() },
      ])
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const removed = await pruneQuarantine(now);

    const left = JSON.parse(store.map.get(scopedKeyFor("driver-A", "podOutbox"))!);
    expect(left.map((i: { stopId: string }) => i.stopId)).toEqual(["recent"]);
    expect(removed.join(" ")).toContain("podOutbox");
    vi.restoreAllMocks();
  });

  it("removes the outbox key entirely once every item has aged out", async () => {
    const now = 100 * DAY;
    store.map.set(
      scopedKeyFor("driver-A", "podOutbox"),
      JSON.stringify([{ stopId: "old", queuedAt: new Date(now - 90 * DAY).toISOString() }])
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await pruneQuarantine(now);

    expect(store.map.has(scopedKeyFor("driver-A", "podOutbox"))).toBe(false);
    vi.restoreAllMocks();
  });

  it("keeps an UNDATED outbox item rather than guessing it is old", async () => {
    const now = 100 * DAY;
    store.map.set(scopedKeyFor("driver-A", "podOutbox"), JSON.stringify([{ stopId: "nodate" }]));

    await pruneQuarantine(now);

    expect(store.map.has(scopedKeyFor("driver-A", "podOutbox"))).toBe(true);
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

describe("only the storage layer may touch AsyncStorage", () => {
  /**
   * THE INVERTED GUARD.
   *
   * The previous version scanned for `"uwc.*"` string LITERALS. Measured: it
   * passed with both `PREFIX + ".concatenatedKey"` and `` `${PREFIX}.templated` ``
   * added to a source file, and it could never see `admin.tripFilterPresets.v1`
   * or `requestor.bookingTemplates.v1` at all, because neither carries the
   * prefix it looked for. A guard that only recognises one spelling of the
   * mistake is not a guard.
   *
   * So this does not look at keys. It looks at who reaches STORAGE. Nothing
   * about how a key is assembled can get past it, because assembly is not what
   * it inspects.
   *
   * ⚠ THE ALLOWLIST IS THE FAILURE MECHANISM. `uwc.podOutbox.corrupt` was
   * exempted in the old guard on the basis of its SHAPE ("a quarantine prefix")
   * while it held raw POD bytes — a plausible sentence attached to a real leak.
   * Every entry below therefore states WHAT IT HOLDS and why that cannot be
   * per-user. Keep it as close to empty as the app allows.
   */
  const ALLOWED_DIRECT_STORAGE: Record<string, string> = {
    "lib/scopedStorage.ts":
      "IS the storage layer — every per-user key is resolved and written here.",
    "services/api.ts":
      "Holds the session tokens. They must be readable BEFORE the user id is " +
      "known (bootstrap reads them to discover who is signed in), so they cannot " +
      "live under a per-user key. Cleared on logout, step 4.",
    "lib/outdoorMode.ts":
      "Holds ONE boolean — whether this PHONE is in outdoor high-contrast mode. " +
      "Unscoped by owner ruling (17 Aug 2026): 'language follows the person, " +
      "glare follows the place'. A driver handing a handset to the next man in " +
      "the same yard is handing over a setting he probably wants, so it " +
      "describes the device's environment rather than the person holding it. " +
      "No trip, consignee or POD data.",
    "lib/sessionCache.ts":
      "Holds the signed-in user's OWN profile (id, name, role, assigned truck) " +
      "and nothing else — no consignee or trip data. It is what RESOLVES the " +
      "user id for an offline cold start, so it cannot be keyed by it. Cleared " +
      "on logout, step 4.",
  };

  it("no module outside the storage layer imports AsyncStorage", () => {
    const srcDir = path.resolve(__dirname, "..");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;

        const text = fs.readFileSync(full, "utf-8");
        const touchesStorage =
          text.includes("@react-native-async-storage/async-storage") ||
          /AsyncStorage\s*\.\s*(get|set|remove|multi|getAll)/.test(text);
        if (!touchesStorage) continue;

        const rel = path.relative(srcDir, full).split(path.sep).join("/");
        if (!(rel in ALLOWED_DIRECT_STORAGE)) offenders.push(rel);
      }
    };
    walk(srcDir);

    expect(offenders).toEqual([]);
  });

  it("every allowlist entry states what it holds, not what it looks like", () => {
    // A one-word exemption is how the next `podOutbox.corrupt` gets waved
    // through. Force the entry to carry a real sentence.
    for (const [file, reason] of Object.entries(ALLOWED_DIRECT_STORAGE)) {
      expect(reason.length, `${file} needs a real reason`).toBeGreaterThan(60);
      expect(reason, `${file} must say what it HOLDS`).toMatch(/hold|IS the storage layer/i);
    }
  });

  it("runs the migration on the NO-SESSION bootstrap path, or quarantine is dead code", () => {
    // The unit tests above prove migrateLegacyGlobalKeys() quarantines when no
    // user is set. Nothing proved anything ever CALLS it that way.
    //
    // It was wired only into fetchMe and the degraded restore, both of which run
    // AFTER setActiveUser(<someone>) — so `uid` was never null in the app, the
    // quarantine branch was unreachable, and pre-DG-D4 global data would have
    // sat under its old key until the NEXT driver signed in and ADOPTED it.
    // That is the cross-driver leak this change exists to remove, reintroduced
    // by the wiring rather than the logic, with every test green.
    const authContext = fs.readFileSync(
      path.resolve(__dirname, "../context/AuthContext.tsx"),
      "utf-8"
    );
    const start = authContext.indexOf("if (!hasTokens)");
    expect(start, "the no-tokens bootstrap branch moved or was renamed").toBeGreaterThan(-1);
    const branch = authContext.slice(start, authContext.indexOf("return;", start));

    expect(branch, "the no-session path must run the migration").toContain(
      "migrateLegacyGlobalKeys"
    );
  });

  it("keeps the legacy migration list covering every key that was global", () => {
    // The migration is what moves a driver's existing data into their
    // namespace. A key scoped in code but missing here would silently strand
    // whatever the driver had queued before the upgrade.
    expect([...LEGACY_GLOBAL_KEYS]).toEqual([
      "uwc.podOutbox",
      "uwc.locationQueue",
      "uwc.gpsConsent",
      "uwc.exceptionOutbox",
      "uwc.bgTrip",
      "admin.tripFilterPresets.v1",
      "requestor.bookingTemplates.v1",
    ]);
  });
});
