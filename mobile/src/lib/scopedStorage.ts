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

/** Prefix for data whose owner could not be established. Never auto-deleted. */
const ORPHAN_PREFIX = "uwc.orphaned";

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
export async function migrateLegacyGlobalKeys(): Promise<MigrationReport> {
  const report: MigrationReport = { adopted: [], quarantined: [] };
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
    const destination = uid ? scopedKeyFor(uid, suffix) : `${ORPHAN_PREFIX}.${suffix}`;

    try {
      // Write the copy BEFORE removing the original. A crash between the two
      // duplicates the data, which is recoverable; the other order loses it.
      const existing = await AsyncStorage.getItem(destination);
      if (existing === null) {
        await AsyncStorage.setItem(destination, value);
      }
      await AsyncStorage.removeItem(legacyKey);
      (uid ? report.adopted : report.quarantined).push(legacyKey);
    } catch {
      /* leave the legacy key in place and try again next launch */
    }
  }

  return report;
}
