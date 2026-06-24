import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { ApiErrorShape, LoginResponse } from "@/types";

// VITE_API_URL wins when set; otherwise production builds target the deployed
// Railway API and dev builds hit the local server. Baked in at build time.
const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ??
  (import.meta.env.PROD ? "https://uwc-api-production.up.railway.app" : "http://localhost:3000");

const ACCESS_KEY = "uwc.admin.accessToken";
const REFRESH_KEY = "uwc.admin.refreshToken";

let accessToken: string | null = localStorage.getItem(ACCESS_KEY);
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);

export function getAccessToken() {
  return accessToken;
}

export function setTokens(access: string | null, refresh: string | null) {
  accessToken = access;
  refreshToken = refresh;
  if (access) localStorage.setItem(ACCESS_KEY, access);
  else localStorage.removeItem(ACCESS_KEY);
  if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
  else localStorage.removeItem(REFRESH_KEY);
}

// Callback invoked when refresh fails — lets AuthContext drop to the login screen.
let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(fn: (() => void) | null) {
  onAuthFailure = fn;
}

export const api = axios.create({ baseURL: `${API_URL}/api/v1` });

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// Single shared in-flight refresh so concurrent 401s don't each refresh.
let refreshPromise: Promise<string> | null = null;

async function doRefresh(): Promise<string> {
  if (!refreshToken) throw new Error("No refresh token");
  const res = await axios.post<{ accessToken: string; refreshToken: string }>(
    `${API_URL}/api/v1/auth/refresh`,
    { refreshToken }
  );
  setTokens(res.data.accessToken, res.data.refreshToken);
  return res.data.accessToken;
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;
    const url = original?.url ?? "";
    const isAuthCall = url.includes("/auth/");

    if (status === 401 && original && !original._retried && !isAuthCall && refreshToken) {
      original._retried = true;
      try {
        refreshPromise = refreshPromise ?? doRefresh();
        const fresh = await refreshPromise;
        refreshPromise = null;
        original.headers.Authorization = `Bearer ${fresh}`;
        return api(original);
      } catch (e) {
        refreshPromise = null;
        setTokens(null, null);
        onAuthFailure?.();
        return Promise.reject(e);
      }
    }
    return Promise.reject(error);
  }
);

// Extracts the API's standard { error: { code, message } } shape.
export function apiErrorMessage(err: unknown, fallback = "Something went wrong."): string {
  const ax = err as AxiosError<ApiErrorShape>;
  return ax?.response?.data?.error?.message ?? fallback;
}

export async function loginRequest(phone: string, password: string): Promise<LoginResponse> {
  const res = await axios.post<LoginResponse>(`${API_URL}/api/v1/auth/login`, { phone, password });
  return res.data;
}
