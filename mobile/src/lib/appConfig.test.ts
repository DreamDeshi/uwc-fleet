import { describe, it, expect } from "vitest";
import appJson from "../../app.json";

/**
 * app.json invariants that only fail ON A DEVICE, months later, if broken.
 *
 * EAS Update strips the native config blocks (android.config, ios.config) from
 * the OTA manifest — native config cannot change over the air, so it is not
 * served. Runtime code therefore CANNOT read a key back out of them: in a build
 * with expo-updates, Constants.expoConfig comes from the applied update, not
 * from the config compiled into the binary.
 *
 * That is a silent failure. It broke every driver and requestor map on the APK
 * the moment the first OTA shipped, and it looked like a broken map rather than
 * a broken config, because the key WAS in the built manifest and the admin map
 * (which never consulted the flag) kept rendering.
 *
 * `extra` survives, so anything a running app needs is mirrored there. These
 * tests are what stop the mirror drifting away from the thing it mirrors.
 */

const expo = appJson.expo as {
  extra?: Record<string, unknown>;
  android?: { config?: { googleMaps?: { apiKey?: string } } };
};

describe("app.json — extra mirrors of native config", () => {
  it("extra.googleMapsConfigured matches whether an Android Maps key is actually set", () => {
    // src/lib/maps.ts reads the FLAG (native config is unreadable at runtime).
    // If someone adds or removes the key without touching the flag, the app
    // would either render a placeholder over a working map or mount MapView
    // with no key — which hard-crashes on Android. Fail here instead.
    const key = expo.android?.config?.googleMaps?.apiKey ?? "";
    expect(expo.extra?.googleMapsConfigured).toBe(key.trim().length > 0);
  });

  it("extra carries everything the app reads at runtime", () => {
    // Each of these is read via Constants.expoConfig.extra.* somewhere in src/.
    // Verified present in the live OTA manifest.
    expect(expo.extra?.apiUrl).toBeTruthy();
    expect((expo.extra?.eas as { projectId?: string } | undefined)?.projectId).toBeTruthy();
  });
});
