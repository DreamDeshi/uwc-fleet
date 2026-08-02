/**
 * WHEN the app may look for an over-the-air update, and what it may do with one
 * it finds. Pure rules — no React Native, no Expo — so the decisions that
 * protect a driver's in-flight work can be tested directly rather than through
 * three layers of native mocks (same split as lib/uploadTypes.ts).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * expo-updates' built-in automatic check is enabled here (app.json sets only
 * `updates.url`, so `checkOnLaunch` defaults to ALWAYS) — but it can never show
 * the driver a new build on the launch that finds it:
 *
 *   • `launchWaitMs` defaults to 0, so LoaderTask launches from the CACHED
 *     bundle and only then downloads the new one in the background. The
 *     download becomes the candidate for the NEXT process start. Two cold
 *     starts, minimum.
 *   • That check runs once per PROCESS START, not per foreground. Pressing Home
 *     and reopening resumes the live process, so it never runs again at all.
 *
 * A driver who never force-quits therefore never gets a fix, and the only path
 * that applied one immediately was the manual button in AppUpdatesCard. This
 * module drives a check on foreground instead, so the app finds the update on
 * its own and offers a one-tap restart.
 */

/**
 * How long to wait between foreground checks.
 *
 * ⚠ NOT cosmetic, and not a politeness throttle. Capturing a POD backgrounds
 * the app (expo-image-picker hands off to the camera) and returning to it
 * foregrounds it again — so a driver working a stop generates a burst of
 * foreground events. Without this every one of them would fire a network
 * request on a metered phone in a depot yard. Fifteen minutes is far tighter
 * than the "two cold starts, whenever those happen" it replaces, and still
 * costs at most a handful of requests per shift.
 */
export const MIN_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Where the update flow currently stands.
 *
 * `ready` is terminal until the driver restarts: the new bundle is on disk and
 * the banner is up. Re-checking from there would either find the same update
 * again or, worse, start a second download over the first.
 */
export type OtaPhase = "idle" | "checking" | "downloading" | "ready" | "error";

export interface CheckDecisionInput {
  phase: OtaPhase;
  /** Epoch ms of the last completed check, or null if none this session. */
  lastCheckAt: number | null;
  now: number;
  minIntervalMs?: number;
}

/**
 * May we run a check right now, on this foreground event?
 *
 * Deliberately conservative: every `false` here costs at most a delayed update,
 * while a spurious `true` costs data on a phone in the field.
 */
export function shouldCheckOnForeground({
  phase,
  lastCheckAt,
  now,
  minIntervalMs = MIN_CHECK_INTERVAL_MS,
}: CheckDecisionInput): boolean {
  // A check or download is already in flight — a second one would race it.
  if (phase === "checking" || phase === "downloading") return false;
  // Already downloaded and waiting on the driver's tap. Nothing to gain.
  if (phase === "ready") return false;
  // First foreground of the session: always check. This is the one that
  // replaces the cold-start check the driver never performs.
  if (lastCheckAt === null) return true;
  // ⚠ Clock moved BACKWARDS (device time correction, timezone fix, manual
  // change). `now - lastCheckAt` goes negative and the interval test passes for
  // free — but treating that as "due" is the correct answer anyway, and saying
  // so explicitly stops a future edit from "fixing" it into a stall that only
  // clears on a restart. A clock bug hides from a clock.
  if (now < lastCheckAt) return true;
  return now - lastCheckAt >= minIntervalMs;
}

/**
 * Is this AppState transition a foreground event worth acting on?
 *
 * Android emits "inactive" between "background" and "active" on some devices,
 * and iOS uses it for the app switcher and the control centre pull-down — so
 * only a real settle into "active" counts, and only FROM a non-active state.
 * Without the second half, an app already active re-fires on every incidental
 * "inactive" blip.
 */
export function isForegroundTransition(previous: string, next: string): boolean {
  return next === "active" && previous !== "active";
}
