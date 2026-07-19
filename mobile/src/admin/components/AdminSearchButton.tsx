// Global-search entry for the admin header (owner ask, 2026-07-19): a small
// search icon in the top-right chrome next to the date + bell, on every admin
// screen. Tapping opens the existing AdminSearch screen (which owns the box +
// results), shell-aware so it resolves on both the PC drawer and the phone
// tab/stack shells. Styled to sit on the blue header (white icon, translucent
// box) — matches the bell button.
import React from "react";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useNavigation, type NavigationProp, type ParamListBase } from "@react-navigation/native";
import { useLayoutMode } from "../hooks/useLayoutMode";

export function AdminSearchButton() {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const mode = useLayoutMode();
  const open = () => {
    if (mode === "wide") navigation.navigate("AdminSearch");
    else navigation.navigate("AdminMore", { screen: "AdminSearch" });
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="search"
      accessibilityLabel="Search"
      style={{
        width: 40,
        height: 40,
        borderRadius: 10,
        backgroundColor: "rgba(255,255,255,0.12)",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Ionicons name="search" size={18} color="#fff" />
    </Pressable>
  );
}
