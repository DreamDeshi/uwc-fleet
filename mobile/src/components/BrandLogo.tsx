// The UWC Berhad company logo (transparent PNG). One source, sized by height;
// width derives from the artwork's aspect ratio so it never distorts. Used in
// three places only: the login screen (large), the app header (small corner),
// and — server-side — the public tracking page.
import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC = require("../../assets/uwc-logo.png");
const RATIO = 602 / 748; // source width / height — keeps the logo undistorted.

export function BrandLogo({ height = 40, style }: { height?: number; style?: StyleProp<ImageStyle> }) {
  return <Image source={SRC} resizeMode="contain" style={[{ height, width: height * RATIO }, style]} accessibilityLabel="UWC Berhad" />;
}
