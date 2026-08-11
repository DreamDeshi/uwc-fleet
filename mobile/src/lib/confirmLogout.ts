import { Alert, Platform } from "react-native";
import i18n from "../i18n";

/**
 * "N delivery photos have not uploaded yet. Log out anyway?"
 *
 * Shown ONLY when a best-effort flush left something unsent, and it always
 * offers a way through: a driver at a dead-signal loading bay who has to hand
 * the phone over now must not be trapped by a dialog. This is informed consent,
 * not a gate — refusing logout would strand exactly the person the shared-
 * handset flow exists to serve.
 *
 * ⚠ Resolves TRUE only on an explicit tap of "Log out". Dismissing the dialog
 * (back button, tapping outside, the browser's Cancel) resolves FALSE and keeps
 * the session, because the unsent items are delivery evidence and the payment
 * behind them cannot be corrected once approved (BL9).
 */
export function confirmLogoutWithUnsent(count: number): Promise<boolean> {
  const title = i18n.t("driver.unsentPodTitle");
  const message = i18n.t("driver.unsentPodMessage", { count });

  // react-native-web's Alert renders a bare window.alert and DROPS the buttons,
  // so a driver on the web build would get an OK box and be logged out with no
  // choice at all. The trial runs on the web build today, so this branch is the
  // real one, not a fallback.
  if (Platform.OS === "web") {
    const confirmFn = typeof globalThis !== "undefined" ? globalThis.confirm : undefined;
    // No confirm available (SSR/export): keep the session rather than silently
    // logging out over unsent evidence.
    if (typeof confirmFn !== "function") return Promise.resolve(false);
    return Promise.resolve(confirmFn(`${title}\n\n${message}`));
  }

  return new Promise<boolean>((resolve) => {
    Alert.alert(
      title,
      message,
      [
        { text: i18n.t("common.cancel"), style: "cancel", onPress: () => resolve(false) },
        {
          text: i18n.t("driver.unsentPodLogOutAnyway"),
          style: "destructive",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}
