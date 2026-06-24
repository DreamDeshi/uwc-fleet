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
import { Me } from "../types";
import i18n from "../i18n";

type AuthStatus = "loading" | "authed" | "guest";

interface AuthContextValue {
  status: AuthStatus;
  user: Me | null;
  login: (phone: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  setLanguage: (lang: "en" | "ms") => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<Me | null>(null);

  const fetchMe = async () => {
    const res = await api.get<Me>("/users/me");
    setUser(res.data);
    if (res.data.language_pref === "en" || res.data.language_pref === "ms") {
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
      } catch {
        await clearTokens();
        if (mounted) {
          setUser(null);
          setStatus("guest");
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // A failed token refresh (expired/rotated) forces a clean logout.
  useEffect(() => {
    setAuthFailureHandler(() => {
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

  const setLanguage = async (lang: "en" | "ms") => {
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
