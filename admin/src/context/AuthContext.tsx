import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getAccessToken, loginRequest, setAuthFailureHandler, setTokens } from "@/services/api";
import type { AuthUser } from "@/types";

type Status = "loading" | "authed" | "guest";

interface AuthState {
  status: Status;
  user: AuthUser | null;
  login: (phone: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);

  // Bootstrap: if a token is stored, fetch the profile to confirm it's valid
  // and that this account is an admin.
  useEffect(() => {
    setAuthFailureHandler(() => {
      setUser(null);
      setStatus("guest");
    });

    let cancelled = false;
    (async () => {
      if (!getAccessToken()) {
        setStatus("guest");
        return;
      }
      try {
        const me = await api.get("/users/me");
        if (cancelled) return;
        if (me.data.role !== "admin") {
          setTokens(null, null);
          setStatus("guest");
          return;
        }
        setUser({ id: me.data.id, phone: me.data.phone, name: me.data.name, role: me.data.role });
        setStatus("authed");
      } catch {
        if (!cancelled) {
          setTokens(null, null);
          setStatus("guest");
        }
      }
    })();

    return () => {
      cancelled = true;
      setAuthFailureHandler(null);
    };
  }, []);

  async function login(phone: string, password: string) {
    const res = await loginRequest(phone, password);
    if (res.user.role !== "admin") {
      throw new Error("This dashboard is for fleet administrators only.");
    }
    setTokens(res.accessToken, res.refreshToken);
    setUser(res.user);
    setStatus("authed");
  }

  function logout() {
    setTokens(null, null);
    setUser(null);
    setStatus("guest");
  }

  const value = useMemo(() => ({ status, user, login, logout }), [status, user]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
