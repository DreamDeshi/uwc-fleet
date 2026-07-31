/**
 * Server error monitoring.
 *
 * THE GAP THIS CLOSES: until now an unexpected 500 went to `console.error` in
 * errorHandler and nowhere else. Railway keeps logs, but nothing aggregates,
 * counts, dedupes or alerts — so a production failure was invisible unless a
 * driver or the office happened to report it. Every defect found in the 31 Jul
 * audit was found by READING CODE, which does not scale and does not run at
 * 2am. Flagged in the 04-07 review and still true until this.
 *
 * ── OFF UNLESS DELIBERATELY TURNED ON ──────────────────────────────────────
 *
 * No `SENTRY_DSN` ⇒ `init()` is never called and every helper here is a no-op.
 * That is the state in dev, in CI, in the test suites, and on production until
 * someone sets the variable. A monitoring tool that changes behaviour when it is
 * absent is a liability, so the absent path does nothing at all.
 *
 * ── WHAT IS DELIBERATELY NOT SENT ──────────────────────────────────────────
 *
 * Sentry is a third party (see lib/sentryScrub for the full argument):
 *
 *   request bodies        NEVER. `sendDefaultPii: false` plus a beforeSend that
 *                         deletes `request.data`. A booking payload carries
 *                         consignee names; a login carries a phone and password.
 *   headers               Authorization / Cookie redacted by NAME.
 *   query values          redacted; `?search=<a customer name>` is customer data.
 *   free text             connection strings, JWTs, +60 numbers and emails are
 *                         scrubbed out of messages and stack frames.
 *   4xx                   not an error. Validation, 403 and 409 are the API
 *                         working; shipping them would bury the real signal.
 *   user identity         only the ROLE and the opaque user id. Never the phone
 *                         (which is the login) and never the name.
 *
 * ⚠ Sending anything to Sentry is an outward transfer. If the scrubber and the
 * DSN disagree about how careful to be, the scrubber wins — add rules there
 * rather than relaxing them here.
 */
import * as Sentry from "@sentry/node";
import { scrubDeep, scrubHeaders, scrubQueryString, scrubText } from "./sentryScrub";

let started = false;

/** True when monitoring is actually configured. Everything else keys on this. */
export function sentryEnabled(): boolean {
  return started;
}

/**
 * Initialise, if a DSN is configured. Call as EARLY as possible in the entry
 * file — instrumentation can only see what is required after it.
 *
 * Safe to call more than once; the second call is a no-op rather than a second
 * client (the test suites import app.ts repeatedly).
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || started) return;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
    release: process.env.RAILWAY_GIT_COMMIT_SHA ?? undefined,

    // NO performance tracing. It samples ordinary requests — including their
    // URLs — and this is an error monitor, not an APM. Turning it on is a
    // separate decision with a separate privacy review.
    tracesSampleRate: 0,

    // The master switch for IP addresses, cookies and request bodies. Off.
    sendDefaultPii: false,

    // Belt and braces: breadcrumbs record outgoing HTTP and console output, and
    // console output is where a stray log of a payload would end up.
    maxBreadcrumbs: 20,

    beforeBreadcrumb(crumb) {
      if (crumb.message) crumb.message = scrubText(crumb.message);
      if (crumb.data) crumb.data = scrubDeep(crumb.data) as Record<string, unknown>;
      return crumb;
    },

    beforeSend(event) {
      // Request bodies never travel, whatever the SDK decided to attach.
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.url) event.request.url = scrubQueryString(event.request.url);
        if (event.request.query_string) event.request.query_string = "[redacted]";
        if (event.request.headers) {
          event.request.headers = scrubHeaders(event.request.headers) as Record<string, string>;
        }
      }
      // Identity: role + opaque id only. `sendDefaultPii: false` already drops
      // ip_address; this drops the rest by construction rather than by trust.
      if (event.user) {
        event.user = { id: event.user.id, role: (event.user as { role?: string }).role };
      }
      if (event.message) event.message = scrubText(event.message);
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = scrubText(ex.value);
        scrubFrames(ex.stacktrace?.frames);
      }
      // Sentry can carry a second set of stacktraces here.
      for (const th of event.threads?.values ?? []) scrubFrames(th.stacktrace?.frames);
      if (event.extra) event.extra = scrubDeep(event.extra) as Record<string, unknown>;
      return event;
    },
  });

  started = true;
  // eslint-disable-next-line no-console
  console.log("sentry: error monitoring enabled");
}

/**
 * THE STACKTRACE IS A FOURTH PAYLOAD, AND IT USED TO GO OUT UNSCRUBBED.
 *
 * Found by capturing the ACTUAL envelope the SDK puts on the wire, rather than
 * unit-testing the scrub functions in isolation. The three layers that were
 * designed all worked — `exception.value`, `contexts.request.url` and the
 * headers all came back `[redacted]`. The frames did not, because nothing
 * touched them:
 *
 *   context_line / pre_context / post_context
 *       Sentry's contextLines integration OPENS THE SOURCE FILE around every
 *       frame and attaches the real lines. So a string literal sitting near a
 *       throwing line is uploaded verbatim, and no amount of scrubbing the
 *       MESSAGE catches it. In the probe that shipped a connection string and a
 *       customer name straight out of the probe's own source.
 *   vars
 *       local variables, if includeLocalVariables is ever switched on. It is
 *       off, and it must stay off — but scrubbing them costs nothing and means
 *       switching it on is not silently a data-exfiltration change.
 *   filename / module / function
 *       real paths in production, so ordinarily harmless. Scrubbed anyway:
 *       scrubText is a no-op on a normal path, and "ordinarily" is not a
 *       guarantee.
 *
 * ⚠ Our source is public, so this is defence in depth rather than a live
 * breach — but "the repo is public" is a property of today, not a design.
 */
function scrubFrames(frames: readonly unknown[] | undefined): void {
  for (const raw of frames ?? []) {
    const f = raw as Record<string, unknown>;
    for (const key of ["context_line", "filename", "module", "function", "abs_path"]) {
      if (typeof f[key] === "string") f[key] = scrubText(f[key] as string);
    }
    for (const key of ["pre_context", "post_context"]) {
      const lines = f[key];
      if (Array.isArray(lines)) f[key] = lines.map((l) => (typeof l === "string" ? scrubText(l) : l));
    }
    if (f.vars) f.vars = scrubDeep(f.vars);
  }
}

/** Minimal request shape — structural, so callers need no Express types. */
export interface SentryRequestLike {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, unknown>;
  user?: { id?: string; role?: string };
}

/**
 * Report an UNEXPECTED error. Returns the Sentry event id (useful in a support
 * conversation) or null when monitoring is off.
 *
 * Never throws: a monitoring failure must not turn a handled 500 into an
 * unhandled one.
 */
export function captureServerError(err: unknown, req?: SentryRequestLike): string | null {
  if (!started) return null;
  try {
    return Sentry.withScope((scope) => {
      if (req) {
        scope.setContext("request", {
          method: req.method,
          url: scrubQueryString(req.originalUrl ?? req.url ?? ""),
          headers: scrubHeaders(req.headers ?? {}),
        });
        if (req.user?.id) scope.setUser({ id: req.user.id, role: req.user.role } as never);
      }
      return Sentry.captureException(err);
    });
  } catch {
    return null;
  }
}

/** Flush pending events on shutdown, so a crash-on-exit still reports. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!started) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* shutting down anyway */
  }
}
