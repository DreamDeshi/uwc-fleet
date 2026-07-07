import React, { createContext, useCallback, useContext, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, shadow } from "../theme";

// Lightweight app-wide success/error/info toast. Phase-5 audit flagged that no
// mutation in the app confirmed success — this fills that gap. Call the hook and
// fire a message; it animates up from the bottom and auto-dismisses.

type ToastType = "success" | "error" | "info";

const ToastContext = createContext<(message: string, type?: ToastType) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

const ICON: Record<ToastType, keyof typeof Ionicons.glyphMap> = {
  success: "checkmark-circle",
  error: "alert-circle",
  info: "information-circle",
};
const TONE: Record<ToastType, string> = {
  success: colors.green,
  error: colors.red,
  info: colors.blue,
};
const VISIBLE_MS = 2600;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<{ message: string; type: ToastType } | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(20)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (message: string, type: ToastType = "success") => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setToast({ message, type });
      opacity.setValue(0);
      translateY.setValue(20);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(
          ({ finished }) => {
            if (finished) setToast(null);
          }
        );
      }, VISIBLE_MS);
    },
    [opacity, translateY]
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.wrap, { bottom: insets.bottom + 24, opacity, transform: [{ translateY }] }]}
        >
          <View style={[styles.toast, { borderLeftColor: TONE[toast.type] }]}>
            <Ionicons name={ICON[toast.type]} size={22} color={TONE[toast.type]} />
            <Text style={styles.text}>{toast.message}</Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16, alignItems: "center" },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    // Type-colored accent bar so success/error/info reads at a glance —
    // the icon alone was the only signal before.
    borderLeftWidth: 5,
    paddingHorizontal: 16,
    paddingVertical: 14,
    maxWidth: 460,
    ...shadow.floating,
  },
  text: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.navy },
});
