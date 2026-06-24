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

/**
 * Send a single notification to one or more device tokens. Best-effort:
 * invalid/empty tokens are skipped and transport errors are logged rather than
 * thrown, so a notification failure never breaks the request that triggered it.
 */
export async function sendPushNotifications(
  tokens: (string | null | undefined)[],
  payload: PushPayload
): Promise<void> {
  const valid = tokens.filter(
    (t): t is string => typeof t === "string" && isExpoPushToken(t)
  );
  if (valid.length === 0) return;

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
}
