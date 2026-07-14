// The narrow (phone) admin header — flat corporate blue, no yellow underline
// (owner ruling), no hamburger (the bottom tab bar replaced the drawer,
// mobile polish pass 14 Jul 2026). Same bar the drawer's AdminHeader drew on
// narrow, now shared by the tab screens and the More stack; sub-screens get
// a back button.
import React from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../theme";

export function AdminMobileHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: colors.blue }}>
      <View
        style={{
          paddingTop: insets.top,
          height: insets.top + 60,
          paddingHorizontal: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        {onBack && (
          <Pressable
            onPress={onBack}
            accessibilityLabel="Back"
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              backgroundColor: "rgba(255,255,255,0.12)",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ionicons name="arrow-back" size={20} color="#fff" />
          </Pressable>
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "800", color: "#fff", letterSpacing: -0.2 }}>
            {title}
          </Text>
        </View>
      </View>
    </View>
  );
}
