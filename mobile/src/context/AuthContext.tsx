import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { AppState } from "react-native";
import { queryClient } from "../lib/queryClient";
import {
  api,
  clearTokens,
  loadStoredTokens,
  loginRequest,
  registerRequest,
  RegisterPayload,
  savePushToken,
  setAuthFailureHandler,
  setTokens,
  currentAccessToken,
  currentRefreshToken,
} from "../services/api";
import { registerForPushNotificationsAsync } from "../lib/notifications";
import { bootstrapActionForError } from "../lib/sessionGate";
import { saveCachedMe, loadCachedMe, clearCachedMe } from "../lib/sessionCache";
import {
  clearUserScope,
  getActiveUserId,
  migrateLegacyGlobalKeys,
  setActiveUser,
} from "../lib/scopedStorage";
import { confirmLogoutWithUnsent } from "../lib/confirmLogout";
import { flushPodOutbox, getPodOutbox } from "../lib/podOutbox";
import { realApi as realPodOutboxApi } from "../hooks/usePodOutbox";
import { Me, AppLanguage, SUPPORTED_LANGUAGES } from "../types";
import i18n from "../i18n";
import { biometricUnlockEnabled } from "../lib/featureFlags";
import {
  biometricAvailable,
  clearEnrolment,
  enrolDevice,
  enrolledUserId,
  unlockRefreshToken,
} from "../lib/biometricEnrolment";
import {
  passwordLoginClearsEnrolment,
  shouldClearEnrolment,
  unlockDecision,
  type UnlockFailure,
} from "../lib/biometricUnlock";
import NetInfo from "@react-native-community/netinfo";

/**
 * `locked` is the biometric gate: tokens exist and this device is enrolled, so
 * the app is NOT signed in until a fingerprint has been presented. It sits
 * between loading and authed rather than inside guest, because the session is
 * real — it is the person holding the phone that has not been established.
 */
type AuthStatus = "loading" | "authed" | "guest" | "locked";

interface AuthContextValue {
  status: AuthStatus;
  user: Me | null;
  /** True while running on the cached identity (bootstrap fetch failed);
   *  the self-heal effect is retrying. Drives the reconnecting banner. */
  degraded: boolean;
  login: (phone: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  setLanguage: (lang: AppLanguage) => Promise<void>;
  /** Biometric unlock — see lib/biometricUnlock for the rules these obey. */
  biometric: {
    /** Is this device enrolled for the signed-in user? */
    enrolled: boolean;
    /** Can this build/device offer it at all (flag + native modules + hardware)? */
    offerable: boolean;
    enrol: () => Promise<boolean>;
    disable: () => Promise<void>;
    /** Run the gate. Resolves to null on success, or why it failed. */
    unlock: () => Promise<UnlockFailure | null>;
    /** Leave the gate for the password screen (keeps the enrolment). */
    usePassword: () => Promise<void>;
  };
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<Me | null>(null);
  // True when the session came from the CACHED identity (bootstrap fetchMe
  // failed with a connectivity error). The re-validation effect below heals it.
  const [degraded, setDegraded] = useState(false);
  // Enrolment state, read once at bootstrap and kept in sync by enrol/disable.
  const [bioEnrolled, setBioEnrolled] = useState(false);
  const [bioOfferable, setBioOfferable] = useState(false);

  const fetchMe = async () => {
    const res = await api.get<Me>("/users/me");
    // Point storage at this driver BEFORE anything reads a queue — an unset
    // pointer makes every scoped read a miss, which a driver would see as an
    // emptied outbox — then adopt anything left under the old global keys into
    // this namespace. Both must complete before `setUser` lets a screen mount
    // and read.
    await setActiveUser(res.data.id);
    await migrateLegacyGlobalKeys();
    setUser(res.data);
    // Cache the confirmed identity so a later offline cold start can still route
    // into the app (see the bootstrap effect + lib/sessionCache).
    saveCachedMe(res.data);
    if ((SUPPORTED_LANGUAGES as readonly string[]).includes(res.data.language_pref)) {
      i18n.changeLanguage(res.data.language_pref);
    }
    return res.data;
  };

  // Register this device for push and save the token to the API. Best-effort —
  // a denied permission or missing token must never break the session.
  const syncPushToken = async () => {
    try {
      const token = await registerForPushNotificationsAsync();
      if (token) await savePushToken(token);
    } catch {
      /* ignore — notifications are non-critical */
    }
  };

  // Can this build even OFFER the toggle? Flag + native modules + hardware with
  // an OS enrolment. Checked once; none of it changes while the app is open.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!biometricUnlockEnabled()) return;
      const ok = await biometricAvailable();
      if (alive) setBioOfferable(ok);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Bootstrap: load saved tokens and resolve the session on app launch.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const hasTokens = await loadStoredTokens();
      if (!hasTokens) {
        // NO SESSION AT ALL — so nothing on this device can be attributed to
        // anyone, and this is the ONLY moment the quarantine branch is
        // reachable. Without this call, pre-DG-D4 global data would sit under
        // its old key until the NEXT driver signed in, and then be adopted into
        // THEIR namespace — the cross-driver leak this whole change exists to
        // remove, reintroduced by the wiring rather than by the logic.
        //
        // It runs only on the no-tokens path on purpose: when tokens DO exist
        // we are about to learn who the owner is, and quarantining first would
        // strand a driver's own queue in `uwc.orphaned.*` instead of adopting it.
        await migrateLegacyGlobalKeys();
        if (mounted) setStatus("guest");
        return;
      }
      // ── THE BIOMETRIC GATE ─────────────────────────────────────────────
      // Tokens exist. If this device is enrolled, nobody gets in on those
      // tokens until the OS says who is holding the phone. This runs BEFORE
      // fetchMe on purpose: fetching the identity first would render the app's
      // own data behind the lock screen, and a lock you can read past is
      // decoration.
      //
      // Everything here fails OPEN — a missing module, absent hardware, a
      // storage error — because a device that cannot ask for a fingerprint must
      // still be able to work. The lock is a convenience over the password, not
      // a second factor.
      if (await gateIsArmed()) {
        if (mounted) {
          setBioEnrolled(true);
          setStatus("locked");
        }
        return;
      }

      try {
        await fetchMe();
        if (mounted) setStatus("authed");
        syncPushToken();
      } catch (err) {
        // Distinguish "can't reach the server" from "the server rejected us".
        // A network error on a COLD offline start must NOT log the driver out —
        // keep the valid token, restore the last confirmed identity so the app
        // routes to their trip, and re-validate once signal returns. Only a
        // genuine auth failure (an HTTP response, e.g. an expired 401) clears
        // the session — real auth expiry is untouched.
        if (bootstrapActionForError(err) === "keep") {
          const cached = await loadCachedMe();
          // The DEGRADED path routes on the cached identity, so it must point
          // storage too — otherwise an offline cold start reads nobody's queue
          // and the driver's outbox looks empty at exactly the moment it is
          // most likely to be full.
          if (cached) {
            await setActiveUser(cached.id);
            await migrateLegacyGlobalKeys();
          }
          if (mounted) {
            if (cached) {
              setUser(cached);
              setStatus("authed");
              setDegraded(true);
            } else {
              // No cached identity to route with — can't enter the app, but keep
              // the tokens (don't wipe) so the next online launch just works.
              setStatus("guest");
            }
          }
        } else {
          await clearTokens();
          await clearCachedMe();
          if (mounted) {
            setUser(null);
            setStatus("guest");
          }
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Self-heal for the degraded (cached-identity) session. The old code entered
  // authed from cache and then NOTHING ever re-validated — the comment above
  // promised "re-validate once signal returns" but no listener existed, so a
  // transient cold-start transport failure (the native cold-reopen bug,
  // 27 Jul 2026) froze the whole app: every tab errored once and stayed
  // errored. Now: retry /users/me immediately, on every foreground, and every
  // 20 s until it succeeds — then refetch every query so the frozen error
  // states unfreeze without the user doing anything. A real auth rejection
  // during these retries still flows through the interceptor's refresh →
  // auth-failure path (clean logout), unchanged.
  useEffect(() => {
    if (!degraded) return;
    let cancelled = false;
    const attempt = async () => {
      try {
        await fetchMe();
        if (cancelled) return;
        setDegraded(false);
        queryClient.invalidateQueries();
        syncPushToken();
      } catch {
        /* still unreachable — the interval/foreground listener tries again */
      }
    };
    const interval = setInterval(attempt, 20_000);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") attempt();
    });
    attempt();
    return () => {
      cancelled = true;
      clearInterval(interval);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [degraded]);

  // A failed token refresh (expired/rotated) forces a clean logout. This fires
  // only on a genuine server rejection (doRefresh keeps the session on a network
  // error), so dropping the cached identity here is correct.
  useEffect(() => {
    setAuthFailureHandler(() => {
      clearCachedMe();
      setUser(null);
      setDegraded(false);
      setStatus("guest");
    });
  }, []);

  /**
   * Is the biometric gate armed for this launch?
   *
   * All four have to hold: the flag, a build that HAS the native modules,
   * hardware with an OS enrolment, and an enrolment of ours. Any of them
   * missing means the app opens as it always did.
   */
  const gateIsArmed = async (): Promise<boolean> => {
    if (!biometricUnlockEnabled()) return false;
    try {
      if (!(await biometricAvailable())) return false;
      return (await enrolledUserId()) !== null;
    } catch {
      return false; // fail OPEN — never lock someone out by accident
    }
  };

  /** Enrol this device for the signed-in user. Prompts immediately. */
  const enrolBiometric = async (): Promise<boolean> => {
    const refresh = currentRefreshToken();
    if (!user || !refresh) return false;
    const ok = await enrolDevice({ userId: user.id, refreshToken: refresh });
    setBioEnrolled(ok);
    return ok;
  };

  const disableBiometric = async (): Promise<void> => {
    await clearEnrolment();
    setBioEnrolled(false);
  };

  /**
   * The unlock itself, exactly as ruled:
   *   ONLINE                        → prompt, then let the SERVER decide.
   *   OFFLINE + unexpired access    → enter, validated at the first request.
   *   OFFLINE + expired access      → refuse.
   * Only a SERVER rejection un-enrols the device.
   */
  const unlock = async (): Promise<UnlockFailure | null> => {
    if (!(await biometricAvailable())) return fail("unavailable");

    const refresh = await unlockRefreshToken();
    if (!refresh) return "biometric_failed"; // cancelled, or no stored credential

    const online = (await NetInfo.fetch().catch(() => null))?.isConnected !== false;
    const decision = unlockDecision({ online, accessToken: currentAccessToken() });

    if (decision.action === "refuse") return "offline_expired";

    if (decision.action === "enter") {
      // Offline: run on what is already stored, like today's resume. The first
      // request that reaches the server is what actually validates this.
      const cached = await loadCachedMe();
      if (!cached) return "offline_expired"; // nothing to route with
      await setActiveUser(cached.id);
      setUser(cached);
      setDegraded(true);
      setStatus("authed");
      return null;
    }

    // Online: the fingerprint bought us a refresh token, nothing more.
    try {
      const { data } = await api.post("/auth/refresh", { refreshToken: refresh });
      await setTokens(data.accessToken, data.refreshToken);
      await fetchMe();
      setDegraded(false);
      setStatus("authed");
      syncPushToken();
      return null;
    } catch {
      // The server refused the stored credential — in practice this driver
      // signed in on another phone (refresh tokens rotate) or was disabled.
      return fail("session_rejected");
    }
  };

  /** Record a failure and, only where the rule says so, un-enrol the device. */
  const fail = (reason: UnlockFailure): UnlockFailure => {
    if (shouldClearEnrolment(reason)) {
      void clearEnrolment();
      setBioEnrolled(false);
    }
    return reason;
  };

  /** Leave the lock screen for the password form, KEEPING the enrolment. */
  const usePassword = async (): Promise<void> => {
    await clearTokens();
    setUser(null);
    setStatus("guest");
  };

  const login = async (phone: string, password: string) => {
    const data = await loginRequest(phone, password);
    await setTokens(data.accessToken, data.refreshToken);
    const me = await fetchMe();

    // ⚠ THE SHARED-HANDSET RULE (DG-D4's reasoning at a new door). Drivers pass
    // phones around. If THIS device is enrolled for someone else and that
    // someone else is not who just signed in, their session must stop being one
    // thumb away from whoever is now holding it.
    try {
      const enrolledFor = await enrolledUserId();
      const meId = me?.id ?? null;
      if (meId && passwordLoginClearsEnrolment(enrolledFor, meId)) {
        await clearEnrolment();
        setBioEnrolled(false);
      } else {
        setBioEnrolled(enrolledFor !== null && enrolledFor === meId);
      }
    } catch {
      /* enrolment bookkeeping must never block a successful sign-in */
    }

    setDegraded(false);
    setStatus("authed");
    syncPushToken();
  };

  const register = async (payload: RegisterPayload) => {
    // Registration does NOT log the user in — accounts start as
    // pending_approval and an admin must activate them first.
    await registerRequest(payload);
  };

  /**
   * LOGOUT IS AN ORDERED SEQUENCE, AND THE ORDER IS THE FEATURE.
   *
   * Drivers share handsets, so this runs several times a day and is the moment
   * unsent delivery evidence is most likely to be lost. Each step must complete
   * before the next begins — none of this may become concurrent, and the
   * ordering must not be left implied by where the awaits happen to sit.
   *
   *   1. unregister push      — needs a live token
   *   2. FLUSH the POD outbox — needs a live token
   *   3. CONFIRM with the driver if anything is still unsent
   *   4. clear tokens
   *   5. clear this user's scoped keys
   *
   * ⚠ STEP 4 MUST NOT MOVE ABOVE STEP 2. Clearing tokens first makes every
   * logout flush 401 BY CONSTRUCTION — a non-network error, which is exactly
   * the case that spends the POD retry budget (DG-D5). The budget guard would
   * then be the only thing standing between a handover and deleted evidence,
   * and a guard should never be load-bearing alone.
   *
   * ⚠ STEP 5 MUST NOT MOVE ABOVE STEP 3. The confirm exists to let the driver
   * decide; deleting first and asking after is the outcome it prevents.
   *
   * Logout is NEVER refused. A driver at a dead-signal loading bay who must
   * hand the phone over now is the situation this whole path exists for — the
   * flush is best-effort, the confirm is informed consent, and the handover
   * always wins.
   */
  const logout = async (): Promise<void> => {
    const userId = user?.id ?? (await getActiveUserId());

    // 1. Unregister this device while the token is still valid, so the driver
    //    stops receiving pushes for a session they have left.
    try {
      await savePushToken(null);
    } catch {
      /* ignore — proceed with logout regardless */
    }

    // 2. Best-effort flush of anything unsent, still holding a valid token.
    //    consumeFailureBudget:false — a failed handover must not push a POD
    //    closer to permanent deletion (DG-D5).
    let unsent = 0;
    try {
      await flushPodOutbox(realPodOutboxApi, { consumeFailureBudget: false });
      unsent = (await getPodOutbox()).length;
    } catch {
      unsent = await getPodOutbox()
        .then((items) => items.length)
        .catch(() => 0);
    }

    // 3. Anything left is unsent delivery evidence. Name the count and require
    //    an explicit tap — but never block the handover.
    if (unsent > 0) {
      const proceed = await confirmLogoutWithUnsent(unsent);
      if (!proceed) return;
    }

    // 4. Only now does the session end.
    await clearTokens();
    await clearCachedMe();

    // 5. And only then is this driver's data removed from a shared handset.
    if (userId) await clearUserScope(userId);
    await setActiveUser(null);

    setUser(null);
    setDegraded(false);
    setStatus("guest");
  };

  const refreshMe = async () => {
    try {
      await fetchMe();
    } catch {
      /* ignore — interceptor handles auth failures */
    }
  };

  const setLanguage = async (lang: AppLanguage) => {
    await i18n.changeLanguage(lang);
    setUser((u) => (u ? { ...u, language_pref: lang } : u));
    try {
      await api.patch("/users/me", { language_pref: lang });
    } catch {
      /* non-blocking: the UI language already changed locally */
    }
  };

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        degraded,
        login,
        register,
        logout,
        refreshMe,
        setLanguage,
        biometric: {
          enrolled: bioEnrolled,
          offerable: bioOfferable,
          enrol: enrolBiometric,
          disable: disableBiometric,
          unlock,
          usePassword,
        },
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
