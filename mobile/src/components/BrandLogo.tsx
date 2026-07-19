// The UWC Berhad company logo (transparent PNG). Sized by height; width derives
// from the artwork's aspect ratio so it never distorts. Two variants:
//   default (colour) — for LIGHT surfaces (login card, tracking page).
//   white           — the same mark in solid white, for the app's BLUE headers
//                      (the colour mark is illegible on blue).
import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC_COLOR = require("../../assets/uwc-logo.png");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC_WHITE = require("../../assets/uwc-logo-white.png");
const RATIO = 602 / 748; // source width / height — keeps the logo undistorted.

export function BrandLogo({
  height = 40,
  white = false,
  style,
}: {
  height?: number;
  white?: boolean;
  style?: StyleProp<ImageStyle>;
}) {
  return (
    <Image
      source={white ? SRC_WHITE : SRC_COLOR}
      resizeMode="contain"
      style={[{ height, width: height * RATIO }, style]}
      accessibilityLabel="UWC Berhad"
    />
  );
}
