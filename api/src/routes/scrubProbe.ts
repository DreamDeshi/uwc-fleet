/**
 * ⚠⚠ TEMPORARY. THIS FILE IS DELETED IN THE FOLLOW-UP PR. ⚠⚠
 *
 * Added 31 Jul 2026 to verify the Sentry scrubber against a REAL production
 * event, by looking at the bytes rather than by reasoning about them.
 *
 * WHY IT EXISTS AT ALL, GIVEN THE TEST SUITE ALREADY PASSES:
 *
 *   tests/sentryScrub.test.ts        tests the pure functions.
 *   tests/sentryWirePayload.test.ts  drives the real SDK at a local listener.
 *
 * Both are green. Both were ALSO green while six of nine sensitive values were
 * going out on the wire, because each one tests the inputs someone remembered to
 * hand it, and the leak came from something nobody handed it (Sentry's
 * contextLines integration attaching SOURCE LINES around every stack frame).
 *
 * What no local test can cover is the PRODUCTION configuration: the real DSN,
 * the real `beforeSend` running in the deployed process, the real Express
 * pipeline, the real compiled `dist/` files that contextLines will open, and the
 * real `DATABASE_URL`. That is the residual risk this closes, and it is why the
 * verification is worth two deploys.
 *
 * ── EVERY SENSITIVE VALUE BELOW IS A DECOY ─────────────────────────────────
 *
 * Nothing real is used, and nothing real is ever transmitted — including in the
 * failure case. That is deliberate: the whole premise is that we do NOT yet know
 * whether the scrubber holds in production, so putting a genuine credential in
 * the payload would risk uploading it to a third party to find out. A decoy that
 * matches the same regex proves the same rule.
 *
 * ⚠ This file is committed to a PUBLIC repository and will remain in its
 * history after deletion — see the 13 Jul phone-number incident. Every decoy is
 * therefore marked, non-routable (`.invalid`, RFC 2606) and obviously synthetic.
 *
 * Decoys carry the marker ZZPROBE so verification is one search: if ZZPROBE
 * appears anywhere in the received event, something did not get scrubbed.
 */
import { Router } from "express";
import { REDACTED, scrubText } from "../lib/sentryScrub";
import { sentryEnabled } from "../lib/sentry";

const router = Router();

/**
 * Shared-secret header. The repo is public, so this is not a secret in any
 * cryptographic sense — it is a guard against a drive-by hitting an endpoint
 * that exists for roughly fifteen minutes. That is proportionate because the
 * route's entire effect is to throw: no database access, no writes, no auth
 * bypass. The worst an attacker achieves is spending Sentry event quota, and
 * the global rate limiter (100/min/IP) already bounds that.
 */
const PROBE_TOKEN = "zzprobe-8f3a1c94-remove-me";

/**
 * Does the scrubber actually redact the REAL production connection string?
 *
 * The decoy proves the regex works on a string I chose, which is a weaker claim
 * than it looks: the real `DATABASE_URL` could contain a character that breaks
 * the pattern (a `@` or `/` in a generated password is the realistic case, and
 * CONNECTION_URI's `[^\s/@]*` password class would stop early on exactly those).
 *
 * So this checks the real value — and returns only a VERDICT WORD. The URL, the
 * credentials, and any fragment of them never enter the response or the event,
 * in either the passing or the failing branch. A test that leaks the secret when
 * it fails is not a test, it is the incident.
 */
function databaseUrlVerdict(): string {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw) return "no-DATABASE_URL-set";

  const sep = raw.indexOf("://");
  const at = raw.indexOf("@");
  const credentials = sep >= 0 && at > sep ? raw.slice(sep + 3, at) : "";
  if (!credentials) return "url-has-no-inline-credentials";

  const scrubbed = scrubText(raw);
  if (scrubbed.includes(credentials)) return "FAIL-credentials-survived";
  if (!scrubbed.includes(REDACTED)) return "FAIL-not-redacted";

  // Belt and braces: the password alone, in case the user:pass split differs.
  const password = credentials.slice(credentials.indexOf(":") + 1);
  if (password.length > 3 && scrubbed.includes(password)) return "FAIL-password-survived";
  return "PASS-scrubbed";
}

router.get("/__scrub-probe", (req, res, next) => {
  // Wrong or missing token: fall through to the 404 handler, so the endpoint is
  // indistinguishable from a typo for anyone who does not already know it.
  if (req.get("x-scrub-probe") !== PROBE_TOKEN) return next();

  if (req.query.mode === "status") {
    res.json({
      sentryEnabled: sentryEnabled(),
      environment: process.env.SENTRY_ENVIRONMENT ?? null,
      release: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      databaseUrl: databaseUrlVerdict(),
    });
    return;
  }

  // A synthetic identity, so the user-trimming branch of beforeSend is exercised
  // without needing a real login. `captureServerError` reads `req.user`; only
  // `id` and `role` may survive. The phone and name here MUST NOT appear.
  (req as unknown as { user: Record<string, string> }).user = {
    id: "zzprobe-synthetic-user-id",
    role: "driver",
    phone: "+60123456789",
    name: "ZZPROBE Driver Name",
  };

  // ── The decoys sit HERE, immediately around the throw, on purpose ──────────
  // This is the exact channel that leaked: contextLines opens the compiled file
  // and uploads the lines surrounding the throwing frame as pre_context /
  // post_context. If frame scrubbing regressed, these literals arrive verbatim
  // even though the message itself is clean.
  const decoyConnection = "postgresql://zzprobe_user:ZZPROBE-DB-PASSWORD@decoy.invalid:5432/decoy";
  const decoyEmail = "ZZPROBE@example.invalid";
  const decoyPhone = "+60123456789";

  throw new Error(
    `SCRUB PROBE (deliberate, temporary): db=${decoyConnection} ` +
      `contact=${decoyEmail} driver=${decoyPhone} ` +
      `databaseUrlVerdict=${databaseUrlVerdict()}`
  );
});

export default router;
