import { Platform } from "react-native";

/**
 * BIOMETRIC ENROLMENT — what is stored, where, and who it belongs to.
 *
 * ⚠ THE NATIVE MODULES ARE LOADED LAZILY, ON PURPOSE, AND THIS IS A RELEASE
 * CONSTRAINT RATHER THAN A STYLE CHOICE.
 *
 * `expo-local-authentication` and `expo-secure-store` are NATIVE modules. An OTA
 * published on the current fixed `runtimeVersion` is served to APKs that do not
 * contain them, and a STATIC import of an absent native module THROWS AT REQUIRE
 * TIME — before any feature flag is read. A dark feature would brick the app on
 * launch. So every touch of these modules goes through `nativeModules()` below,
 * which resolves them inside a try/catch at CALL time and reports "unavailable"
 * instead of exploding.
 *
 * That makes the code safe to merge, but it does NOT make it safe to publish:
 * see AGENTS.md — this must ride with the next rebuild, not an OTA.
 *
 * ── WHAT IS STORED ───────────────────────────────────────────────────────────
 *
 * ONLY the refresh token, in SecureStore with `requireAuthentication`, so the OS
 * keystore itself gates the read. Never the access token (short-lived, and
 * useless to protect), never the password.
 *
 * ── ONE ENROLMENT PER DEVICE (DG-D4's rule at a new door) ────────────────────
 *
 * Drivers share handsets. If driver A enrols and driver B then signs in with a
 * password, A's session must stop being one thumb away from whoever is holding
 * the phone — so a password login by a DIFFERENT user clears the enrolment
 * outright. This is the same reasoning as the per-driver storage namespacing:
 * the danger is never the current user, it is the previous one.
 */

/** Which user this device is enrolled for. Unscoped BY DESIGN — see below. */
const ENROLLED_USER_KEY = "uwc.bio.enrolledUserId";
/** The SecureStore entry holding that user's refresh token. */
const REFRESH_ITEM = "uwc.bio.refreshToken";

export interface BiometricModules {
  auth: typeof import("expo-local-authentication");
  store: typeof import("expo-secure-store");
}

/**
 * Resolve the native modules, or null when they are not in this binary.
 *
 * ⚠ `require` inside try/catch rather than a top-level import — see the header.
 * Hermes has no dynamic `import()`, so this is the available shape.
 */
export function nativeModules(): BiometricModules | null {
  if (Platform.OS === "web") return null; // web degrades to password-only
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const auth = require("expo-local-authentication") as BiometricModules["auth"];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const store = require("expo-secure-store") as BiometricModules["store"];
    return auth && store ? { auth, store } : null;
  } catch {
    return null; // an APK built before these modules existed
  }
}

/** Can this device offer biometric unlock AT ALL? Hardware + an OS enrolment. */
export async function biometricAvailable(): Promise<boolean> {
  const mods = nativeModules();
  if (!mods) return false;
  try {
    return (await mods.auth.hasHardwareAsync()) && (await mods.auth.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** The user id this device is enrolled for, or null. */
export async function enrolledUserId(
  getItem: (k: string) => Promise<string | null>
): Promise<string | null> {
  try {
    return await getItem(ENROLLED_USER_KEY);
  } catch {
    return null;
  }
}

/**
 * Enrol THIS device for THIS user.
 *
 * The caller must already have authenticated the person — enrolment prompts the
 * biometric immediately, so the device proves it can recognise whoever is
 * enrolling rather than merely proving the hardware exists.
 */
export async function enrolDevice(params: {
  userId: string;
  refreshToken: string;
  setItem: (k: string, v: string) => Promise<void>;
}): Promise<boolean> {
  const mods = nativeModules();
  if (!mods) return false;
  try {
    const ok = await mods.auth.authenticateAsync({ promptMessage: "Confirm it is you" });
    if (!ok.success) return false;
    await mods.store.setItemAsync(REFRESH_ITEM, params.refreshToken, {
      requireAuthentication: true,
      keychainAccessible: mods.store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await params.setItem(ENROLLED_USER_KEY, params.userId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Forget this device's enrolment, and the credential with it.
 *
 * Called on: explicit opt-out, a password login by a DIFFERENT user, and a
 * server rejection at unlock. Never on a cancelled prompt or a dead network.
 */
export async function clearEnrolment(removeItem: (k: string) => Promise<void>): Promise<void> {
  const mods = nativeModules();
  try {
    await mods?.store.deleteItemAsync(REFRESH_ITEM, { requireAuthentication: true });
  } catch {
    // The keystore entry may already be gone, or unreadable without a prompt.
    // Losing the POINTER below is what actually un-enrols the device.
  }
  try {
    await removeItem(ENROLLED_USER_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * Prompt, then hand back the stored refresh token.
 *
 * Returns null when the prompt fails OR the credential has gone — the caller
 * cannot tell those apart from here, and must not: both mean "no unlock", and
 * only the SERVER's answer is allowed to un-enrol the device.
 */
export async function unlockRefreshToken(): Promise<string | null> {
  const mods = nativeModules();
  if (!mods) return null;
  try {
    const ok = await mods.auth.authenticateAsync({ promptMessage: "Unlock UWC Fleet" });
    if (!ok.success) return null;
    return await mods.store.getItemAsync(REFRESH_ITEM, { requireAuthentication: true });
  } catch {
    return null;
  }
}

// The shared-handset PREDICATE lives in ./biometricUnlock, which imports no
// React Native. This module touches Platform and the native modules, so vitest
// cannot collect it — the same pure/impure split as payBreakdown vs the screens.
