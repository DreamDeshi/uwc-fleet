import { Expo, type ExpoPushMessage } from "expo-server-sdk";

// EXPO_ACCESS_TOKEN is optional for sending, but recommended (and required once
// the Expo project enforces it). Reads from .env / Railway env.
const expo = new Expo({ accessToken: process.env.EXPO_ACCESS_TOKEN });

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
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
    (t): t is string => typeof t === "string" && Expo.isExpoPushToken(t)
  );
  if (valid.length === 0) return;

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      console.error("Failed to send push notification chunk:", err);
    }
  }
}
