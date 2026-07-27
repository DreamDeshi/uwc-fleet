// Global JS error reporting → POST /client-errors, fire-and-forget.
// The owner's ask: every uncaught error in a live user's app should reach
// us without a screenshot. Deliberately boring and safe:
//   - never throws, never awaited on any user path
//   - deduped by message + capped per session, so an error loop can't
//     flood the API or burn the user's data
//   - no PII: message/stack/screen/platform/versions only
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { api } from "../services/api";

const seen = new Set<string>();
let sent = 0;
const MAX_REPORTS_PER_SESSION = 10;

export function reportClientError(err: unknown, opts?: { fatal?: boolean; screen?: string }): void {
  try {
    const e = err as { message?: string; stack?: string } | null | undefined;
    const message = String(e?.message ?? err ?? "unknown error").slice(0, 1000);
    const key = message.slice(0, 200);
    if (seen.has(key) || sent >= MAX_REPORTS_PER_SESSION) return;
    seen.add(key);
    sent += 1;
    void api
      .post("/client-errors", {
        message,
        stack: e?.stack ? String(e.stack).slice(0, 8000) : undefined,
        screen: opts?.screen,
        platform: Platform.OS,
        app_version: (Constants.expoConfig?.version as string) ?? undefined,
        update_id: Updates.updateId ?? "embedded",
        is_fatal: Boolean(opts?.fatal),
      })
      .catch(() => {
        /* reporting must never cause errors of its own */
      });
  } catch {
    /* ditto */
  }
}

/** Install once at app start. Chains the previous handler so RN's own
 *  fatal-error behavior (redbox in dev, crash dialog in prod) is unchanged. */
export function installGlobalErrorReporting(): void {
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") {
      window.addEventListener("error", (event) => reportClientError(event.error ?? event.message));
      window.addEventListener("unhandledrejection", (event) =>
        reportClientError((event as PromiseRejectionEvent).reason)
      );
    }
    return;
  }
  const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler?: () => unknown; setGlobalHandler?: (fn: unknown) => void } }).ErrorUtils;
  const prev = errorUtils?.getGlobalHandler?.() as ((e: unknown, isFatal?: boolean) => void) | undefined;
  errorUtils?.setGlobalHandler?.((e: unknown, isFatal?: boolean) => {
    reportClientError(e, { fatal: Boolean(isFatal) });
    prev?.(e, isFatal);
  });
}
