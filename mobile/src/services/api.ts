import axios, { AxiosError, AxiosRequestConfig, InternalAxiosRequestConfig } from "axios";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { LoginResponse } from "../types";
// The i18next instance directly, not the React hook: apiErrorMessage is called
// from plain functions and mutation handlers, not only from components.
import i18n from "../i18n";

// ── Base URL ────────────────────────────────────────────────────────────
// Reads `extra.apiUrl` from app.json. On a physical phone via Expo Go,
// localhost points at the phone itself — set apiUrl to your machine's LAN IP.
const API_URL =
  // EXPO_PUBLIC_API_URL wins when set. It is inlined at BUILD time, so a normal
  // APK or OTA build (where it is unset) falls through to extra.apiUrl exactly
  // as before — this cannot change what production points at.
  //
  // It exists so local runs and CI stop having to EDIT app.json. That edit is a
  // live hazard: the file is committed, the override is a production URL, and a
  // run that dies before its revert leaves "http://localhost:3000" staged for
  // release. An env var cannot be committed by accident.
  process.env.EXPO_PUBLIC_API_URL?.trim() ||
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ||
  "http://localhost:3000";

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  timeout: 15000,
  headers: { "Content-Type": "application/json" },
});

// ── Token storage ─────────────────────────────────────────────────────────
const ACCESS_KEY = "uwc.accessToken";
const REFRESH_KEY = "uwc.refreshToken";

// In-memory copies so the request interceptor stays synchronous.
let accessToken: string | null = null;
let refreshToken: string | null = null;

// AuthContext registers this so a failed refresh can force a logout.
let onAuthFailure: (() => void) | null = null;
export function setAuthFailureHandler(fn: () => void) {
  onAuthFailure = fn;
}

export async function loadStoredTokens(): Promise<boolean> {
  const [a, r] = await Promise.all([
    AsyncStorage.getItem(ACCESS_KEY),
    AsyncStorage.getItem(REFRESH_KEY),
  ]);
  accessToken = a;
  refreshToken = r;
  return Boolean(a && r);
}

export async function setTokens(access: string, refresh: string) {
  accessToken = access;
  refreshToken = refresh;
  await AsyncStorage.multiSet([
    [ACCESS_KEY, access],
    [REFRESH_KEY, refresh],
  ]);
}

/**
 * The in-memory tokens, for the two callers that legitimately need the raw
 * values: biometric ENROLMENT (which hands the refresh token to the OS keystore)
 * and the offline unlock DECISION (which reads the access token's expiry).
 *
 * ⚠ Not a general accessor. Every request already attaches the access token
 * through the interceptor above; a screen that reads a token is doing something
 * the interceptor should be doing for it.
 */
export function currentAccessToken(): string | null {
  return accessToken;
}

export function currentRefreshToken(): string | null {
  return refreshToken;
}

export async function clearTokens() {
  accessToken = null;
  refreshToken = null;
  await AsyncStorage.multiRemove([ACCESS_KEY, REFRESH_KEY]);
}

// ── Request interceptor — attach the access token ──────────────────────────
api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  return config;
});

// ── Response interceptor — refresh once on 401, then retry ──────────────────
// Concurrent 401s share a single in-flight refresh so we don't rotate the
// refresh token multiple times (the API rotates on every /auth/refresh).
let refreshing: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  if (!refreshToken) return null;
  try {
    // Bare axios (not `api`) so this request skips the interceptors.
    const res = await axios.post<{ accessToken: string; refreshToken: string }>(
      `${API_URL}/api/v1/auth/refresh`,
      { refreshToken }
    );
    await setTokens(res.data.accessToken, res.data.refreshToken);
    return res.data.accessToken;
  } catch (err) {
    // A CONNECTIVITY failure (signal dropped between the 401 and the refresh)
    // is not an auth rejection — keep the tokens so the session survives and
    // the request can be retried later. Only a genuine server rejection (the
    // refresh token is expired/rotated → an HTTP response) logs the user out.
    if (isNetworkError(err)) return null;
    await clearTokens();
    onAuthFailure?.();
    return null;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;

    // Only try refresh on a 401, once per request, and never for the
    // login/refresh calls themselves.
    const url = original?.url ?? "";
    const isAuthCall = url.includes("/auth/login") || url.includes("/auth/refresh");

    if (status === 401 && original && !original._retried && !isAuthCall && refreshToken) {
      original._retried = true;
      refreshing = refreshing ?? doRefresh();
      const newAccess = await refreshing;
      refreshing = null;
      if (newAccess) {
        original.headers = { ...(original.headers ?? {}), Authorization: `Bearer ${newAccess}` };
        return api(original);
      }
    }
    return Promise.reject(error);
  }
);

// ── Helpers ─────────────────────────────────────────────────────────────
// Pull the API's standard error message ({ error: { code, message } }) out of
// an axios error so screens can show plain-language messages.
export function apiErrorMessage(err: unknown, fallback = "Something went wrong."): string {
  const ax = err as AxiosError<{ error?: { code?: string; message?: string } }>;
  if (ax?.response?.data?.error?.message) return ax.response.data.error.message;
  // ⚠ DRIVER-FACING, AND TRANSLATED. These were hardcoded English written for a
  // developer — "check that the API is running" means nothing to someone in a
  // truck cab, and it is the message he gets when Start Trip fails in a
  // basement loading bay. Neither promises the work is saved: only the outbox
  // paths are, and claiming it here would be a lie on every other screen.
  if (ax?.code === "ECONNABORTED") return i18n.t("common.errorTimeout");
  if (ax?.message === "Network Error") return i18n.t("common.errorOffline");
  return fallback;
}

/** The API's error code (e.g. "SIMILAR_EXISTS"), or null for non-API errors. */
export function apiErrorCode(err: unknown): string | null {
  const ax = err as AxiosError<{ error?: { code?: string } }>;
  return ax?.response?.data?.error?.code ?? null;
}

/**
 * A request that never got a server reply — offline, DNS failure, timeout
 * (ECONNABORTED) or a connection torn down mid-flight. This is the "queue it
 * and retry later" class: the POD outbox keeps items on these and only gives
 * up on real API replies. Anything WITH a response is a server decision, not
 * a connectivity problem.
 */
export function isNetworkError(err: unknown): boolean {
  const ax = err as AxiosError;
  if (!ax?.isAxiosError) return false;
  return !ax.response;
}

/** Similar-consignee candidates from a 409 SIMILAR_EXISTS response. */
export interface SimilarConsignee {
  id: string;
  company_name: string;
  area: string | null;
  state: string | null;
  zone_code: string;
}
export function apiErrorCandidates(err: unknown): SimilarConsignee[] {
  const ax = err as AxiosError<{ error?: { candidates?: SimilarConsignee[] } }>;
  return ax?.response?.data?.error?.candidates ?? [];
}

// ── Auth calls (used by AuthContext) ───────────────────────────────────────
export async function loginRequest(phone: string, password: string): Promise<LoginResponse> {
  const res = await api.post<LoginResponse>("/auth/login", { phone, password });
  return res.data;
}

export interface RegisterPayload {
  phone: string;
  password: string;
  name: string;
  employee_number?: string;
  department_id?: string;
  role: "driver" | "requestor";
}

export async function registerRequest(payload: RegisterPayload) {
  const res = await api.post("/auth/register", payload);
  return res.data;
}

// Register/clear this device's Expo push token on the server. Best-effort —
// callers swallow errors so notifications never block auth.
export async function savePushToken(token: string | null) {
  await api.patch("/users/push-token", { expo_push_token: token });
}
