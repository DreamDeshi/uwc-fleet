import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * DG-D4 — per-driver storage keys.
 *
 * UWC drivers SHARE HANDSETS. Every durable key in this app was global
 * (`uwc.podOutbox`, `uwc.locationQueue`, …) and `logout()` cleared only the
 * tokens and the cached identity, so driver A's unsent PODs, queued GPS,
 * unsent exception reports and background-trip state all carried straight into
 * driver B's session on the same phone.
 *
 * That is a defect on its own. It becomes a much worse one under biometric
 * login: a fingerprint that unlocks a GLOBALLY-keyed refresh token opens
 * whichever session the phone happens to be holding — so driver B's thumb could
 * open driver A's account. This module is the prerequisite, and it lands before
 * any biometric code.
 *
 * THE SCHEME
 *
 *   uwc.u.<userId>.<suffix>     per-user, cleared on that user's logout
 *   uwc.orphaned.<suffix>       quarantined data whose owner is unknown
 *   uwc.activeUserId            the pointer, deliberately UNSCOPED (see below)
 *
 * `uwc.activeUserId` cannot itself be namespaced — it is what resolves the
 * namespace. It is also the only way the HEADLESS background-location task can
 * find the right queue: that task runs with no React context and no access to
 * AuthContext, so it reads this pointer directly. Logout clears it.
 */

/** Unscoped pointer to whoever is logged in. Cleared on logout. */
const ACTIVE_USER_KEY = "uwc.activeUserId";

/** Prefix for data whose owner could not be established. */
const ORPHAN_PREFIX = "uwc.orphaned";

/**
 * THE QUARANTINE CEILING.
 *
 * Nothing else in this system clears `uwc.orphaned.*` — DG-O10 records that
 * there is no retention policy anywhere — and an orphaned POD outbox holds
 * base64 photos (~700KB each on the web build) sitting on a SHARED handset.
 * "Never delete" without a ceiling is how a privacy liability and a storage
 * blowout get built on purpose.
 *
 * So: keep evidence long enough to be useful in a dispute, then let it go, and
 * SAY WHAT WENT. Age is the primary limit because relevance decays with time;
 * the count cap is the backstop for a device that somehow accumulates many.
 */
export const MAX_ORPHAN_AGE_DAYS = 30;
export const MAX_ORPHAN_ENTRIES = 20;

/** `uwc.orphaned.<suffix>.<epochMs>` — timestamped so entries never collide. */
function orphanKey(suffix: string, now: number): string {
  return `${ORPHAN_PREFIX}.${suffix}.${now}`;
}

/** Epoch stamp from an orphan key, or null if it is not one. */
function orphanStamp(key: string): number | null {
  if (!key.startsWith(`${ORPHAN_PREFIX}.`)) return null;
  const stamp = Number(key.slice(key.lastIndexOf(".") + 1));
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * The keys that were global before this change. Order is irrelevant; the list
 * is exhaustive and is asserted against `mobile/src` by a test, so a NEW global
 * key cannot be added without either scoping it or declaring it here.
 *
 * `uwc.accessToken` / `uwc.refreshToken` / `uwc.cachedMe` are deliberately NOT
 * in this list: logout already clears them, and the token keys move behind the
 * secure store in the biometric commit that follows.
 */
export const LEGACY_GLOBAL_KEYS = [
  "uwc.podOutbox",
  "uwc.locationQueue",
  "uwc.gpsConsent",
  "uwc.exceptionOutbox",
  "uwc.bgTrip",
] as const;

/** Suffix used inside a user's namespace, derived from the legacy key name. */
export function suffixOf(legacyKey: string): string {
  return legacyKey.replace(/^uwc\./, "");
}

/** `uwc.u.<userId>.<suffix>` — the key an owned value lives under. */
export function scopedKeyFor(userId: string, suffix: string): string {
  return `uwc.u.${userId}.${suffix}`;
}

let activeUserId: string | null = null;

/**
 * Point storage at a user. Called on login and on session restore, BEFORE any
 * screen reads a queue — an unset pointer makes every scoped read a miss, which
 * would look to a driver like an emptied outbox.
 */
export async function setActiveUser(userId: string | null): Promise<void> {
  activeUserId = userId;
  try {
    if (userId) await AsyncStorage.setItem(ACTIVE_USER_KEY, userId);
    else await AsyncStorage.removeItem(ACTIVE_USER_KEY);
  } catch {
    /* best effort — the in-memory value still serves this session */
  }
}

/**
 * Who storage is currently pointed at. Reads through to AsyncStorage so the
 * headless background task — which never ran `setActiveUser` — resolves too.
 */
export async function getActiveUserId(): Promise<string | null> {
  if (activeUserId) return activeUserId;
  try {
    activeUserId = await AsyncStorage.getItem(ACTIVE_USER_KEY);
  } catch {
    activeUserId = null;
  }
  return activeUserId;
}

/** Test seam only. */
export function __resetActiveUserCache(): void {
  activeUserId = null;
}

/**
 * Resolve a suffix to the key it should be read/written under RIGHT NOW.
 *
 * Returns null when nobody is logged in. Callers must treat null as "do not
 * touch storage" rather than falling back to a global key — falling back is the
 * bug this module exists to remove.
 */
export async function currentScopedKey(suffix: string): Promise<string | null> {
  const uid = await getActiveUserId();
  return uid ? scopedKeyFor(uid, suffix) : null;
}

/** Every key belonging to one user, for logout. */
export async function userScopedKeys(userId: string): Promise<string[]> {
  try {
    const all = await AsyncStorage.getAllKeys();
    return all.filter((k) => k.startsWith(`uwc.u.${userId}.`));
  } catch {
    return [];
  }
}

/**
 * Drop everything belonging to one user. Called on logout, AFTER the caller has
 * dealt with anything unsent — this function does not ask, it removes.
 */
export async function clearUserScope(userId: string): Promise<void> {
  const keys = await userScopedKeys(userId);
  if (keys.length === 0) return;
  try {
    await AsyncStorage.multiRemove(keys);
  } catch {
    /* best effort — a failed clear is not worth blocking logout over */
  }
}

export interface MigrationReport {
  /** Legacy keys adopted into the signed-in user's namespace. */
  adopted: string[];
  /** Legacy keys moved to `uwc.orphaned.*` because the owner was unknown. */
  quarantined: string[];
  /** Quarantined keys removed by the ceiling. Never silent — see pruneQuarantine. */
  expired: string[];
}

/**
 * Enforce the quarantine ceiling: drop anything past MAX_ORPHAN_AGE_DAYS, then
 * the oldest beyond MAX_ORPHAN_ENTRIES.
 *
 * Returns what it removed, and warns. A quarantine that empties itself silently
 * is indistinguishable from one that never held anything, which is precisely the
 * situation "quarantine rather than delete" was meant to avoid.
 */
export async function pruneQuarantine(now: number = Date.now()): Promise<string[]> {
  let keys: string[];
  try {
    keys = (await AsyncStorage.getAllKeys()).filter((k) => orphanStamp(k) !== null);
  } catch {
    return [];
  }

  const cutoff = now - MAX_ORPHAN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const dated = keys
    .map((key) => ({ key, stamp: orphanStamp(key)! }))
    .sort((a, b) => a.stamp - b.stamp); // oldest first

  const tooOld = dated.filter((d) => d.stamp < cutoff);
  const survivors = dated.filter((d) => d.stamp >= cutoff);
  const overflow = survivors.slice(0, Math.max(0, survivors.length - MAX_ORPHAN_ENTRIES));

  const doomed = [...tooOld, ...overflow].map((d) => d.key);
  if (doomed.length === 0) return [];

  try {
    await AsyncStorage.multiRemove(doomed);
  } catch {
    return [];
  }

  console.warn(
    `[scopedStorage] quarantine ceiling removed ${doomed.length} orphaned entr` +
      `${doomed.length === 1 ? "y" : "ies"} ` +
      `(older than ${MAX_ORPHAN_AGE_DAYS}d, or beyond ${MAX_ORPHAN_ENTRIES} kept): ` +
      doomed.join(", ")
  );
  return doomed;
}

/**
 * One-time migration of the pre-DG-D4 global keys.
 *
 * ⚠ NOTHING IS DELETED HERE, EVER — owner ruling 11 Aug 2026.
 *
 * If a session is active, the data provably belongs to that user, so it is
 * ADOPTED into their namespace. If not, the owner is unknown and the data is
 * QUARANTINED under `uwc.orphaned.<suffix>` and left there.
 *
 * Adopting on the NEXT login instead would be precisely the cross-driver bug:
 * on a shared handset the next person to log in is usually not the person whose
 * data it is. Deleting would be worse — an unsent POD is delivery evidence, and
 * the payment behind it cannot be corrected once approved (BL9). Quarantine
 * costs a few kilobytes and keeps the file if a dispute lands next month.
 *
 * The app already has this instinct: `podOutbox.quarantineCorrupt()` preserves
 * unparseable bytes under `uwc.podOutbox.corrupt` rather than overwriting them.
 * Same rule, wider scope.
 */
export async function migrateLegacyGlobalKeys(
  now: number = Date.now()
): Promise<MigrationReport> {
  const report: MigrationReport = { adopted: [], quarantined: [], expired: [] };
  const uid = await getActiveUserId();

  for (const legacyKey of LEGACY_GLOBAL_KEYS) {
    let value: string | null = null;
    try {
      value = await AsyncStorage.getItem(legacyKey);
    } catch {
      // Storage threw — we do not know whether a value is there, so we must not
      // remove anything. Leave it and retry on a later launch.
      continue;
    }
    if (value === null) continue;

    const suffix = suffixOf(legacyKey);
    // A user's namespace holds ONE live value per suffix (it is live data).
    // Quarantine is timestamped instead: two orphans must never collide, and an
    // earlier version of this function skipped the write when the destination
    // was taken and STILL removed the legacy key — deleting the second orphan
    // outright, which is the one thing this path promises never to do.
    const destination = uid ? scopedKeyFor(uid, suffix) : orphanKey(suffix, now);

    try {
      // Write the copy BEFORE removing the original. A crash between the two
      // duplicates the data, which is recoverable; the other order loses it.
      const existing = await AsyncStorage.getItem(destination);
      if (existing === null) {
        await AsyncStorage.setItem(destination, value);
      } else if (!uid) {
        // Same-millisecond collision on the orphan key. Rather than drop the
        // value, leave the legacy key untouched for the next launch.
        continue;
      }
      await AsyncStorage.removeItem(legacyKey);
      (uid ? report.adopted : report.quarantined).push(legacyKey);
    } catch {
      /* leave the legacy key in place and try again next launch */
    }
  }

  report.expired = await pruneQuarantine(now);
  return report;
}
