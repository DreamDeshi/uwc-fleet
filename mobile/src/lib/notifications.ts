import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";

// How notifications behave while the app is foregrounded: show a banner + add
// to the list, play a sound, but don't touch the badge count.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Ask for permission and return this device's Expo push token (or null if the
 * user declines, we're on a simulator, or the project isn't push-configured).
 * Best-effort: never throws so login can't be blocked by notification setup.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  try {
    // Web push isn't configured (no VAPID key / service worker), so
    // getExpoPushTokenAsync throws on web anyway — but requestPermissionsAsync
    // still pops the browser "Allow notifications?" prompt first. Bail out on web
    // so users aren't asked to enable a feature that can't work here. On web the
    // driver/requestor screens poll instead (see hooks/queries.ts). Native is
    // unaffected and continues to register for real push.
    if (Platform.OS === "web") return null;

    if (!Device.isDevice) return null; // push tokens only issue on real hardware

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;
    if (existing !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return null;

    // projectId is needed for getExpoPushTokenAsync in standalone/EAS builds.
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? (Constants as any).easConfig?.projectId;
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    return token.data;
  } catch (err) {
    console.warn("Push registration failed:", err);
    return null;
  }
}
