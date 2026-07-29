import { Platform } from "react-native";
import Constants from "expo-constants";

/**
 * Is the native Google Maps provider usable on this device?
 *
 * react-native-maps uses the Google Maps provider on Android and hard-crashes
 * the app if <MapView> mounts with no API key in the native manifest, so the
 * UI falls back to <MapPlaceholder> instead. iOS defaults to Apple Maps, which
 * needs no key.
 *
 * ⚠ THIS MUST NOT READ android.config. It used to, and it broke every driver
 * and requestor map on the APK the moment EAS Update shipped its first OTA:
 *
 *   EAS Update STRIPS the native config blocks (android.config, ios.config)
 *   out of the update manifest. Native config cannot change over the air, so
 *   it is not served. In a build with expo-updates, Constants.expoConfig comes
 *   from the APPLIED UPDATE, not from the config compiled into the binary —
 *   so `expoConfig.android.config.googleMaps.apiKey` reads back undefined even
 *   though the key IS in the built manifest and maps work fine.
 *
 * The failure is silent and looks like a broken map, not a broken config; the
 * admin fleet map kept working the whole time because it mounts <MapView>
 * unconditionally and never consulted this flag.
 *
 * `extra` DOES survive the manifest (that is how apiUrl and the EAS projectId
 * reach the app), so the key's PRESENCE is mirrored there as a boolean. The two
 * are kept in step by tests/appConfig.test.ts, which fails if they drift.
 *
 * RULE, for anything else that needs build-time config at runtime: read it from
 * expo.extra. Never from a native config block. See AGENTS.md.
 */
const googleMapsConfigured = Constants.expoConfig?.extra?.googleMapsConfigured === true;

export const mapsEnabled = Platform.OS === "android" ? googleMapsConfigured : true;
