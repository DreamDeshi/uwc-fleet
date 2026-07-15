import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
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
} from "../services/api";
import { registerForPushNotificationsAsync } from "../lib/notifications";
import { bootstrapActionForError } from "../lib/sessionGate";
import { saveCachedMe, loadCachedMe, clearCachedMe } from "../lib/sessionCache";
import { Me, AppLanguage, SUPPORTED_LANGUAGES } from "../types";
import i18n from "../i18n";

type AuthStatus = "loading" | "authed" | "guest";

interface AuthContextValue {
  status: AuthStatus;
  user: Me | null;
  login: (phone: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  setLanguage: (lang: AppLanguage) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<Me | null>(null);

  const fetchMe = async () => {
    const res = await api.get<Me>("/users/me");
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

  // Bootstrap: load saved tokens and resolve the session on app launch.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const hasTokens = await loadStoredTokens();
      if (!hasTokens) {
        if (mounted) setStatus("guest");
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
          if (mounted) {
            if (cached) {
              setUser(cached);
              setStatus("authed");
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

  // A failed token refresh (expired/rotated) forces a clean logout. This fires
  // only on a genuine server rejection (doRefresh keeps the session on a network
  // error), so dropping the cached identity here is correct.
  useEffect(() => {
    setAuthFailureHandler(() => {
      clearCachedMe();
      setUser(null);
      setStatus("guest");
    });
  }, []);

  const login = async (phone: string, password: string) => {
    const data = await loginRequest(phone, password);
    await setTokens(data.accessToken, data.refreshToken);
    await fetchMe();
    setStatus("authed");
    syncPushToken();
  };

  const register = async (payload: RegisterPayload) => {
    // Registration does NOT log the user in — accounts start as
    // pending_approval and an admin must activate them first.
    await registerRequest(payload);
  };

  const logout = async () => {
    // Unregister this device first (while we still hold a valid token) so the
    // user stops receiving pushes after logging out.
    try {
      await savePushToken(null);
    } catch {
      /* ignore — proceed with logout regardless */
    }
    await clearTokens();
    await clearCachedMe();
    setUser(null);
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
      value={{ status, user, login, register, logout, refreshMe, setLanguage }}
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
