import { Platform } from "react-native";
import Constants from "expo-constants";

// react-native-maps uses the Google Maps provider on Android and hard-crashes
// the app at launch if no API key is present in the manifest. We mirror the key
// configured in app.json (android.config.googleMaps.apiKey) here so the UI can
// fall back to a static placeholder when it's empty/missing instead of mounting
// <MapView>. iOS defaults to Apple Maps, which needs no key.
const androidKey =
  ((Constants.expoConfig?.android as any)?.config?.googleMaps?.apiKey as string | undefined) ?? "";

export const mapsEnabled = Platform.OS === "android" ? androidKey.trim().length > 0 : true;
