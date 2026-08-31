// Expo push notifications via the public HTTP API. We call it directly with
// fetch rather than the expo-server-sdk package: the SDK is ESM-only and this
// API compiles to CommonJS (tsc → `node dist/index.js`), which can't require
// an ES module. fetch is global in Node 18+, so this needs no dependency.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE = 100; // Expo accepts up to 100 messages per request

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Expo tokens look like ExponentPushToken[xxxx] or ExpoPushToken[xxxx].
function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

export interface PushSendResult {
  /** How many tokens actually got a send attempt. 0 is a FINDING, not a
   * success — see the comment on the early return below. */
  recipients: number;
}

/**
 * Send a single notification to one or more device tokens. Best-effort:
 * invalid/empty tokens are skipped and transport errors are logged rather than
 * thrown, so a notification failure never breaks the request that triggered it.
 */
export async function sendPushNotifications(
  tokens: (string | null | undefined)[],
  payload: PushPayload
): Promise<PushSendResult> {
  const valid = tokens.filter(
    (t): t is string => typeof t === "string" && isExpoPushToken(t)
  );
  if (valid.length === 0) {
    // ⚠ THE PUSH THAT WENT TO NOBODY (AGENTS.md). This used to `return`
    // silently here, so `sendPushNotifications([])` resolved exactly like a
    // real send — "notified everyone" and "notified nobody" were the same
    // non-event to every one of the ~20 call sites across the codebase
    // (driver reassignment, stale-ticket sweeps, doc-expiry reminders, admin
    // exception pings...), because none of them inspected a return value that
    // never carried the information. The one place this was actually fixed
    // (reports.ts's exceptions dashboard count) is a compensating UI for ONE
    // caller, not a fix to the shared function every OTHER caller also goes
    // through — found in code review 31 Aug 2026. Logging it here, in the one
    // choke point almost every caller already funnels through, fixes all of
    // them at once with no call-site changes needed.
    console.warn(
      `Push "${payload.title}" reached 0 recipients (${tokens.length} candidate token(s), none valid) — nobody was notified.`
    );
    return { recipients: 0 };
  }

  const messages = valid.map((to) => ({
    to,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Optional but recommended; required once the Expo project enforces it.
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(chunk),
      });
      if (!res.ok) {
        console.error(`Expo push failed: HTTP ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      console.error("Failed to send push notification chunk:", err);
    }
  }

  return { recipients: valid.length };
}
