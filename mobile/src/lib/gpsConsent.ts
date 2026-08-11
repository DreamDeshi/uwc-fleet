import { scopedGetItem, scopedSetItem } from "./scopedStorage";

// Remembers the driver's answer to the live-location explainer, per device.
// This is our APP-level consent, shown BEFORE the OS/browser geolocation prompt
// so the driver understands it's active-trip-only and foreground-only. The OS
// permission is still the real gate; this just avoids a cold, context-free
// prompt and lets a driver who declined re-enable later from the badge.
export type GpsConsent = "accepted" | "declined";

const SUFFIX = "gpsConsent";

export async function getGpsConsent(): Promise<GpsConsent | null> {
  try {
    const v = await scopedGetItem(SUFFIX);
    return v === "accepted" || v === "declined" ? v : null;
  } catch {
    return null; // storage unavailable — treat as "not yet decided"
  }
}

export async function setGpsConsent(value: GpsConsent): Promise<void> {
  try {
    await scopedSetItem(SUFFIX, value);
  } catch {
    /* ignore — the choice still holds in memory for this session */
  }
}
