import AsyncStorage from "@react-native-async-storage/async-storage";
import { Me } from "../types";

// Caches the last confirmed /users/me so a COLD start with no signal can still
// route the driver into their app (RootNavigator needs `user` to pick the role
// stack — keeping tokens isn't enough on its own). It holds only the user's OWN
// profile (name / role / assigned truck) — never consignee or trip data — so no
// NDA/customer data is written to unencrypted device storage. Refreshed on every
// successful fetchMe; cleared on logout and on a genuine auth failure.
const KEY = "uwc.cachedMe";

export async function saveCachedMe(me: Me): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(me));
  } catch {
    /* best-effort — a write failure just means no offline identity next launch */
  }
}

export async function loadCachedMe(): Promise<Me | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Me;
    // Minimal shape check — a corrupt/partial blob must not route the app.
    return parsed && typeof parsed.id === "string" && typeof parsed.role === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function clearCachedMe(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
