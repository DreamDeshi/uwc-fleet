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

/**
 * The TWO quarantine families, both of which hold delivery photos and neither
 * of which anything else ever clears.
 *
 *   uwc.orphaned.<suffix>.<epoch>            data whose owner was unknown
 *   uwc.u.<uid>.podOutbox.corrupt.<epoch>    unparseable POD outbox bytes
 *
 * The second was previously exempted from scoping "because it is a quarantine
 * prefix" — a judgement about its SHAPE. What it actually holds is a driver's
 * raw POD queue, so it is scoped like everything else and capped like the
 * other quarantine.
 *
 * Capped SEPARATELY so a flood of one cannot evict the other's evidence.
 */
const QUARANTINE_FAMILIES = [
  { name: "orphaned", match: (k: string) => k.startsWith(`${ORPHAN_PREFIX}.`) },
  { name: "podOutbox.corrupt", match: (k: string) => k.includes(".podOutbox.corrupt.") },
  // DG-D6: a queued POD whose trip the server says is GONE. Registered here and
  // not merely written with a quarantine-shaped key — an unregistered family is
  // never pruned, and "keep a driver's delivery photos forever on a shared
  // handset" is the liability this ceiling exists to prevent. Capped separately
  // so a run of stale trips cannot evict the corrupt-bytes evidence.
  { name: "podOutbox.orphaned", match: (k: string) => k.includes(".podOutbox.orphaned.") },
] as const;

/** Trailing `.<epochMs>` on a quarantine key, or null if this is not one. */
function quarantineStamp(key: string): number | null {
  if (!QUARANTINE_FAMILIES.some((f) => f.match(key))) return null;
  const stamp = Number(key.slice(key.lastIndexOf(".") + 1));
  return Number.isFinite(stamp) ? stamp : null;
}

// ── The ONLY AsyncStorage surface the app may use ────────────────────────
//
// Every other module goes through these, which is what makes the call-site
// guard in scopedStorage.test.ts enforceable: it does not have to understand
// how a key was BUILT (a literal, a concatenation, a template — the previous
// literal-scanning guard was blind to the last two), only which files reach
// storage at all.

/**
 * Read a per-user value. Null when nobody is signed in — never a global read.
 *
 * ⚠ A STORAGE FAILURE PROPAGATES. It must not be collapsed into null: podOutbox
 * distinguishes "storage threw, so we do not know what is stored and nobody may
 * write" from "nothing is stored". Swallowing the error here would let the next
 * enqueue write a one-item array over a day of queued deliveries — the exact
 * defect the comment in readOutboxOutcome was written about.
 */
export async function scopedGetItem(suffix: string): Promise<string | null> {
  const key = await currentScopedKey(suffix);
  if (!key) return null;
  return await AsyncStorage.getItem(key);
}

/**
 * Write a per-user value. Errors PROPAGATE so a caller never reports "saved"
 * when nothing was.
 *
 * ⚠ Throws when nobody is signed in, rather than no-op'ing. A silent no-op is
 * the same lie in a different costume: the driver is told the delivery was
 * queued and nothing was written.
 */
export async function scopedSetItem(suffix: string, value: string): Promise<void> {
  const key = await currentScopedKey(suffix);
  if (!key) throw new Error(`scopedStorage: refusing to write "${suffix}" with no active user`);
  await AsyncStorage.setItem(key, value);
}

/** Remove a per-user value. No-op when nobody is signed in. */
export async function scopedRemoveItem(suffix: string): Promise<void> {
  const key = await currentScopedKey(suffix);
  if (!key) return;
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    /* best effort */
  }
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
  // Not `uwc.*`, and scoped for the same reason. Saved booking templates
  // leaking between requestors on a shared office machine is the same defect as
  // a POD leaking between drivers, just cheaper — and a scan that only looked
  // for the `uwc.` prefix could never have seen either of these.
  "admin.tripFilterPresets.v1",
  "requestor.bookingTemplates.v1",
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
 * EVIDENCE — the only per-user data that SURVIVES its owner's logout.
 *
 * Owner ruling 12 Aug 2026, reversing the original "clear them all on logout":
 * once keys are namespaced, clearing A's outbox buys NO isolation, because B
 * cannot read A's namespace either way. It only destroys delivery evidence —
 * and the logout dialog tells the driver the opposite ("they will be kept on
 * this phone for you"), so the code was contradicting its own copy.
 *
 * A queued POD therefore survives, namespaced, and flushes on A's next sign-in.
 * Everything else IS cleared: the GPS queue, the consent answer and the
 * background-trip pointer are not evidence and have no reason to outlive a
 * handover.
 *
 * Not kept forever — `pruneQuarantine` applies the same 30-day / 20-entry
 * ceiling, so an ex-driver's photos do not sit on a shared handset indefinitely.
 */
function isEvidenceKey(key: string): boolean {
  return /\.podOutbox(\.corrupt\.\d+)?$/.test(key);
}

/**
 * Drop this user's data on logout — EXCEPT unsent delivery evidence.
 *
 * Runs AFTER the flush and the confirm, so whatever is left is exactly what the
 * driver was told would be kept.
 */
export async function clearUserScope(userId: string): Promise<void> {
  const keys = (await userScopedKeys(userId)).filter((k) => !isEvidenceKey(k));
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
    keys = (await AsyncStorage.getAllKeys()).filter((k) => quarantineStamp(k) !== null);
  } catch {
    return [];
  }

  const cutoff = now - MAX_ORPHAN_AGE_DAYS * 24 * 60 * 60 * 1000;
  const doomed: string[] = [];

  // Each family is capped on its own, so a burst of corrupt-outbox writes
  // cannot evict orphaned evidence, or the other way round.
  for (const family of QUARANTINE_FAMILIES) {
    const dated = keys
      .filter((k) => family.match(k))
      .map((key) => ({ key, stamp: quarantineStamp(key)! }))
      .sort((a, b) => a.stamp - b.stamp); // oldest first

    const tooOld = dated.filter((d) => d.stamp < cutoff);
    const survivors = dated.filter((d) => d.stamp >= cutoff);
    const overflow = survivors.slice(0, Math.max(0, survivors.length - MAX_ORPHAN_ENTRIES));
    doomed.push(...[...tooOld, ...overflow].map((d) => d.key));
  }

  // A SURVIVING OUTBOX gets the same ceiling. Its key carries no timestamp —
  // the items do (`queuedAt`) — so it is pruned by CONTENT rather than by key,
  // and the key is removed once it holds nothing. Without this, an ex-driver's
  // photos would sit on a shared handset forever, which is the thing letting
  // the outbox survive logout would otherwise create.
  const report: string[] = [];
  let outboxKeys: string[] = [];
  try {
    outboxKeys = (await AsyncStorage.getAllKeys()).filter((k) => /\.podOutbox$/.test(k));
  } catch {
    outboxKeys = [];
  }
  for (const key of outboxKeys) {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) continue;
      const items = JSON.parse(raw) as Array<{ queuedAt?: string }>;
      if (!Array.isArray(items)) continue;

      const fresh = items
        .filter((i) => {
          const t = Date.parse(String(i?.queuedAt ?? ""));
          return Number.isFinite(t) ? t >= cutoff : true; // undated → keep, never guess
        })
        .slice(-MAX_ORPHAN_ENTRIES); // newest wins, same as the outbox's own cap

      if (fresh.length === items.length) continue;
      // Reported, NOT added to `doomed`: the key itself is rewritten in place
      // (or removed when empty), so handing it to multiRemove below would delete
      // an outbox that still holds live evidence.
      report.push(`${key} (${items.length - fresh.length} of ${items.length} items)`);
      if (fresh.length === 0) await AsyncStorage.removeItem(key);
      else await AsyncStorage.setItem(key, JSON.stringify(fresh));
    } catch {
      /* unreadable/corrupt — leave it; podOutbox quarantines that path itself */
    }
  }

  if (doomed.length > 0) {
    try {
      await AsyncStorage.multiRemove(doomed);
      report.push(...doomed);
    } catch {
      /* leave them; the next launch tries again */
    }
  }

  if (report.length === 0) return [];

  console.warn(
    `[scopedStorage] retention ceiling removed ${report.length} entr` +
      `${report.length === 1 ? "y" : "ies"} ` +
      `(older than ${MAX_ORPHAN_AGE_DAYS}d, or beyond ${MAX_ORPHAN_ENTRIES} kept): ` +
      report.join(", ")
  );
  return report;
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
