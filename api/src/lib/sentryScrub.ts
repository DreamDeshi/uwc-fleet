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
 * 5. THE CLIENT IP IS PERSONAL DATA, AND `sendDefaultPii: false` DOES NOT COVER
 *    IT. That flag governs `user.ip_address`; the address ALSO arrives as
 *    `x-forwarded-for` and half a dozen other spellings, which are just headers
 *    as far as the SDK is concerned. Railway forwards the real client address
 *    and the app trusts one proxy hop, so on production that is a driver's home
 *    or mobile connection, sitting on the same event as their user id.
 *
 * ⚠ THE COUNT HAS ONLY EVER GONE UP, AND NEVER FROM READING THIS FILE. Items 5
 * and the stack-frame and breadcrumb channels were all found by capturing the
 * actual wire payload while the whole suite was green. Treat this list as the
 * things known to leak, never as the things that can.
 *
 * Anything not understood is left alone deliberately: this scrubs KNOWN
 * dangerous shapes rather than trying to whitelist safe text, and the callers
 * (sentry.ts) already withhold the categories that are dangerous wholesale.
 */

/**
 * Header names never forwarded, whatever their value.
 *
 * ⚠ THE IP FAMILY IS HERE BECAUSE AN IP ADDRESS IS PERSONAL DATA. Railway
 * terminates TLS at its proxy and forwards the client address, and the app sets
 * `trust proxy`, so in production the first entry of `x-forwarded-for` is A
 * DRIVER'S REAL IP — a home or roadside mobile connection, tied to a named
 * employee by the `user.id` on the same event.
 *
 * `sendDefaultPii: false` does NOT cover these. It governs `user.ip_address`
 * (verified null on the wire) and nothing else; the headers arrive through
 * `scrubHeaders`, which until now had no rule for them. Two different channels
 * that the phrase "PII is off" reads as one.
 *
 * Redacting by NAME rather than by value shape also covers IPv6 for free, which
 * matters because an IPv6 regex cannot be written safely — `(?:[0-9a-f]{1,4}:)`
 * repeated matches an ordinary timestamp like `00:00:11`.
 */
export const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  // The client-IP family. Every proxy spells it differently, and one unredacted
  // spelling is as good as none.
  "x-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "forwarded",
  "x-forwarded",
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
 * IPv4 in FREE TEXT — the header family is redacted by name above, but an
 * address also reaches a message or a stack frame whenever anything logs one.
 *
 * IPv4 only, deliberately. A general IPv6 pattern is repeated hex groups
 * separated by colons, which matches an ordinary timestamp (`00:00:11`) and a
 * host:port pair; over-scrubbing every log line to catch a rare free-text IPv6
 * is a bad trade when the headers — where an IPv6 client address actually
 * arrives — are already redacted by name. Documented gap, not an oversight.
 *
 * Loopback and private ranges are redacted too. Splitting "harmless" addresses
 * from client ones is exactly the judgement this file refuses to make elsewhere
 * (see the query-string note), and it would get it wrong once.
 */
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

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
    .replace(IPV4, REDACTED)
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

  /**
   * AN ERROR IS THE ONE NON-PLAIN OBJECT THAT ROUTINELY CARRIES SECRETS, AND IT
   * GETS HERE FOR REAL — this was a live leak on production, found 31 Jul by
   * capturing the envelope of a deliberate 500 rather than by reasoning:
   *
   *   errorHandler does `console.error(err)`. Sentry's console integration puts
   *   the RAW Error instance into breadcrumb `data.arguments`. The prototype
   *   guard below then waved it straight through, because an Error's prototype
   *   is Error.prototype, not Object.prototype. The SDK serialized it to
   *   {message, stack} AFTER beforeBreadcrumb had already passed on it.
   *
   * Net effect: every reported 500 carried a SECOND, UNSCRUBBED copy of its own
   * message in the breadcrumbs, beside the scrubbed `exception.value`. For a
   * Prisma connection failure that copy is the production database password —
   * precisely the leak the scrubber exists to stop.
   *
   * Own enumerable properties are walked too: a PrismaClientKnownRequestError
   * carries `code` and `meta`, and `meta` holds query detail.
   */
  if (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") {
    const err = value as Error & Record<string, unknown>;
    const out: Record<string, unknown> = {
      name: err.name,
      message: scrubText(String(err.message ?? "")),
    };
    if (typeof err.stack === "string") out.stack = scrubText(err.stack);
    // name/message/stack are non-enumerable on a standard Error, so this adds
    // the extras (Prisma's code/meta, a cause) without duplicating the above.
    for (const [k, v] of Object.entries(err)) {
      if (k === "name" || k === "message" || k === "stack") continue;
      out[k] = scrubDeep(v, depth + 1);
    }
    return out;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? REDACTED : scrubDeep(v, depth + 1);
  }
  return out;
}
