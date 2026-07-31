/**
 * WHAT IS ALLOWED TO LEAVE THE BUILDING.
 *
 * Sentry is a THIRD PARTY. Everything this file lets through is copied to
 * servers we do not run, retained on their schedule, and readable by anyone with
 * access to the project. AGENTS.md forbids exposing customer lists, employee
 * identities, telephone numbers, client emails, NDA-adjacent data, credentials
 * and production data — and an error report is an unusually rich place for all
 * of those to hide, because it is assembled automatically from whatever the
 * request happened to contain.
 *
 * So the posture is DENY BY DEFAULT: request bodies are never sent at all, and
 * everything that does go is run through this scrubber. Pure (no SDK import,
 * no I/O) so every rule below is unit-tested — see tests/sentryScrub.test.ts.
 *
 * ── THE FOUR THINGS THAT WOULD ACTUALLY LEAK ────────────────────────────────
 *
 * 1. `Authorization: Bearer <jwt>` — a live access token. Sentry captures
 *    headers by default. This is the single worst one: a token in an error
 *    report is a working credential sitting in a third party's UI.
 *
 * 2. THE QUERY STRING IS CUSTOMER DATA HERE. `/consignees?search=<company>` puts
 *    a real customer name in the URL, and `?q=` on the trip search does the
 *    same. Keys are kept (they say which endpoint shape failed); VALUES are
 *    redacted, because the value is the customer.
 *
 * 3. PRISMA ERRORS EMBED THE CONNECTION STRING. An init or pool failure
 *    stringifies `DATABASE_URL`, credentials and all. That is the production
 *    database password, in an exception message, uploaded automatically.
 *
 * 4. Malaysian phone numbers are the login identity for every driver and
 *    requestor (lib/phone normalises to +60…), so one in a message is both PII
 *    and half of a credential.
 *
 * Anything not understood is left alone deliberately: this scrubs KNOWN
 * dangerous shapes rather than trying to whitelist safe text, and the callers
 * (sentry.ts) already withhold the categories that are dangerous wholesale.
 */

/** Header names never forwarded, whatever their value. */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

export const REDACTED = "[redacted]";

/**
 * Postgres/MySQL/Mongo/Redis URIs WITH credentials. Matched on the `://user:pass@`
 * shape rather than on the variable name, because the string arrives inside a
 * sentence ("Can't reach database server at …"), not as a labelled field.
 */
const CONNECTION_URI = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]*@[^\s]+/gi;

/** A Malaysian mobile in any of the shapes lib/phone accepts before normalising. */
const MY_PHONE = /(?:\+?60|\b0)1\d[-\s]?\d{3,4}[-\s]?\d{4}\b/g;

/** JWTs and long opaque tokens, wherever they appear in free text. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** Email addresses — client contacts are NDA-adjacent. */
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Redact the known-dangerous shapes from a free-text string (an exception
 * message, a stack frame, a breadcrumb).
 *
 * Order matters: connection URIs are replaced before EMAIL, or the `user:pass@host`
 * portion would be partly eaten by the email pattern and the rest left behind.
 */
export function scrubText(value: string): string {
  return value
    .replace(CONNECTION_URI, (_m, scheme: string) => `${scheme}://${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(MY_PHONE, REDACTED)
    .replace(EMAIL, REDACTED)
    .replace(EMBEDDED_QUERY, (_m, key: string) => `${key}=${REDACTED}`);
}

/**
 * A `key=value` pair inside FREE TEXT, not just inside a URL field.
 *
 * scrubQueryString handles a URL we were handed. This handles the same data
 * arriving somewhere nobody expected — and it does, because Sentry's
 * contextLines integration uploads SOURCE LINES around every stack frame. A
 * line like
 *
 *     originalUrl: "/api/v1/consignees?search=<company>&zone=P1",
 *
 * is not a URL field, it is a string of source code, and it carried a real
 * customer name past every other rule here. Caught by auditing the actual wire
 * payload; the unit tests could not see it because they test this function's
 * inputs, not what the SDK chooses to attach.
 *
 * Deliberately narrow: it needs a `?` or `&` before the key, so ordinary
 * assignments (`const total = x`) and object literals are untouched.
 */
const EMBEDDED_QUERY = /(?<=[?&])([A-Za-z0-9_]+)=([^&\s"'`]+)/g;

/** Header map with the sensitive names removed by NAME, others scrubbed by value. */
export function scrubHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (REDACTED_HEADERS.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = typeof value === "string" ? scrubText(value) : value;
  }
  return out;
}

/**
 * Keep the query KEYS, drop every VALUE.
 *
 * `?search=KEYSIGHT&zone=P1` becomes `?search=[redacted]&zone=[redacted]`. The
 * keys are the diagnostic content — they identify which endpoint shape failed —
 * and the values are the customer. Zone codes would be harmless, but
 * distinguishing harmless values from customer names is exactly the judgement
 * that gets it wrong once and leaks a directory.
 */
export function scrubQueryString(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const [path, query] = [url.slice(0, q), url.slice(q + 1)];
  const parts = query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? pair : `${pair.slice(0, eq)}=${REDACTED}`;
    });
  return parts.length ? `${path}?${parts.join("&")}` : path;
}

/**
 * Walk any structure and scrub every string, bounded so a pathological payload
 * cannot spin. Arrays and plain objects only — a Date or Buffer is returned
 * as-is rather than rebuilt.
 */
export function scrubDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrubDeep(v, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? REDACTED : scrubDeep(v, depth + 1);
  }
  return out;
}
