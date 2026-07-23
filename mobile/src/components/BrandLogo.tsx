// The UWC Berhad company logo (transparent PNG). Sized by height; width derives
// from the artwork's aspect ratio so it never distorts. Variants:
//   default (colour) — full logo (mark + "UWC" wordmark) for LIGHT surfaces
//                      (login card, tracking page) where it stands alone as the
//                      sole brand name.
//   white            — the same full logo in solid white, for BLUE surfaces.
//   mark             — the diamond MARK only, no "UWC" letters. Used in headers
//                      that already print "UWC TRUCKING" as text, so the wordmark
//                      isn't repeated. Pairs with `white` for blue headers.
import React from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC_COLOR = require("../../assets/uwc-logo.png");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC_WHITE = require("../../assets/uwc-logo-white.png");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC_MARK_COLOR = require("../../assets/uwc-mark.png");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SRC_MARK_WHITE = require("../../assets/uwc-mark-white.png");
const RATIO = 602 / 748; // full logo: source width / height — keeps it undistorted.
const MARK_RATIO = 602 / 592; // mark-only crop (wordmark removed) is near-square.

export function BrandLogo({
  height = 40,
  white = false,
  mark = false,
  style,
}: {
  height?: number;
  white?: boolean;
  mark?: boolean;
  style?: StyleProp<ImageStyle>;
}) {
  const source = mark
    ? white
      ? SRC_MARK_WHITE
      : SRC_MARK_COLOR
    : white
      ? SRC_WHITE
      : SRC_COLOR;
  return (
    <Image
      source={source}
      resizeMode="contain"
      style={[{ height, width: height * (mark ? MARK_RATIO : RATIO) }, style]}
      accessibilityLabel="UWC Berhad"
    />
  );
}
