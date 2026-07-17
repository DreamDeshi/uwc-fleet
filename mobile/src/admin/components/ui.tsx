// The admin UI kit in React Native — the RN counterpart of the web admin's
// components/ui.tsx. Prop APIs mirror the web kit exactly so screen ports
// stay mechanical; visuals are the same corporate identity expressed in RN
// (gradients via expo-linear-gradient, shadows via theme.shadow objects).
// Built-in labels go through i18n (admin.* / common.* keys) per the
// full-i18n decision — unlike the web kit's hardcoded English.
import React from "react";
import {
  ActivityIndicator,
  Modal as RNModal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, font, radius, shadow, tripStatusColor, tripStatusLabelKey } from "../theme";
import type { TripStatus } from "../types";
import { initials } from "../lib/format";
import { adminFontScope } from "../platform/webFonts";

type Kids = React.ReactNode;

// ── Card ─────────────────────────────────────────────────────────────
export function Card({
  children,
  style,
  pad = 20,
}: {
  children: Kids;
  style?: StyleProp<ViewStyle>;
  pad?: number;
}) {
  return (
    <View
      style={[
        { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: pad },
        shadow.card,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: Kids }) {
  return (
    <View style={styles.sectionRow}>
      {/* Corporate-yellow tick before every section title — the small,
          repeated brand mark from the web admin. */}
      <View style={{ flexDirection: "row", gap: 10, flex: 1, minWidth: 0 }}>
        <View style={styles.sectionTick} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: font.lg, fontWeight: "800", color: colors.text, letterSpacing: -0.2 }}>{title}</Text>
          {subtitle ? <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>{subtitle}</Text> : null}
        </View>
      </View>
      {right}
    </View>
  );
}

// ── KPI card (gradient-filled stat tile, optional press-through) ─────
// `bg` takes a gradients token (color-stop tuple); `shadowColor` a kpiShadow
// token (RN shadow style object).
export function KpiCard({
  label,
  value,
  sub,
  bg,
  fg,
  accent,
  icon,
  onPress,
  shadowStyle,
}: {
  label: string;
  value: Kids;
  sub?: string;
  bg: readonly [string, string, ...string[]];
  fg: string;
  accent: string;
  icon?: Kids;
  onPress?: () => void;
  shadowStyle?: ViewStyle;
}) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[shadowStyle ?? shadow.card, { borderRadius: radius.xl }]}>
      <LinearGradient
        colors={bg}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ borderRadius: radius.xl, paddingVertical: 20, paddingHorizontal: 22, minHeight: 142, overflow: "hidden" }}
      >
        {/* Decorative depth: two translucent discs bleeding off the corner. */}
        <View pointerEvents="none" style={[styles.disc, { right: -34, top: -34, width: 130, height: 130, borderRadius: 65, backgroundColor: "rgba(255,255,255,0.09)" }]} />
        <View pointerEvents="none" style={[styles.disc, { right: 26, bottom: -48, width: 96, height: 96, borderRadius: 48, backgroundColor: "rgba(255,255,255,0.07)" }]} />
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
          <Text style={{ fontSize: font.xs, fontWeight: "800", letterSpacing: 1.2, textTransform: "uppercase", color: fg, opacity: 0.9, flex: 1 }}>
            {label}
          </Text>
          {icon ? (
            <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: accent, alignItems: "center", justifyContent: "center" }}>
              {icon}
            </View>
          ) : null}
        </View>
        <Text style={{ fontSize: 44, fontWeight: "800", marginTop: 8, lineHeight: 46, letterSpacing: -1, color: fg }}>{value}</Text>
        {sub ? <Text style={{ fontSize: font.sm, fontWeight: "600", color: fg, opacity: 0.9, marginTop: 9 }}>{sub}</Text> : null}
      </LinearGradient>
    </Pressable>
  );
}

// ── Button ───────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "accent" | "success" | "danger" | "outline" | "ghost";
const buttonFill: Record<ButtonVariant, { bg: string; fg: string; borderColor?: string; borderWidth?: number; shadowOf?: string }> = {
  primary: { bg: colors.blue, fg: "#fff", shadowOf: colors.blue },
  accent: { bg: colors.yellow, fg: colors.navy, shadowOf: "#D69E00" },
  success: { bg: colors.green, fg: "#fff", shadowOf: "#2E7F24" },
  danger: { bg: colors.red, fg: "#fff", shadowOf: "#B71C1C" },
  outline: { bg: "transparent", fg: colors.blue, borderColor: colors.blue, borderWidth: 1.5 },
  ghost: { bg: colors.panel, fg: colors.text, borderColor: colors.border, borderWidth: 1 },
};

export function Button({
  children,
  onPress,
  variant = "primary",
  disabled,
  full,
  size = "md",
  style,
}: {
  children: Kids;
  onPress?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  full?: boolean;
  size?: "sm" | "md";
  style?: StyleProp<ViewStyle>;
}) {
  const v = buttonFill[variant];
  const raised = v.shadowOf
    ? { shadowColor: v.shadowOf, shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 3 }
    : null;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          backgroundColor: v.bg,
          borderColor: v.borderColor,
          borderWidth: v.borderWidth ?? 0,
          paddingVertical: size === "sm" ? 8 : 11,
          paddingHorizontal: size === "sm" ? 14 : 18,
          borderRadius: radius.md,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          alignSelf: full ? "stretch" : "flex-start",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        },
        !disabled && raised,
        style,
      ]}
    >
      {typeof children === "string" ? (
        <Text style={{ color: v.fg, fontWeight: "700", fontSize: size === "sm" ? 13.5 : font.md }}>{children}</Text>
      ) : (
        children
      )}
    </Pressable>
  );
}

// ── Generic pill / badge ─────────────────────────────────────────────
export function Pill({
  children,
  bg,
  fg,
  border,
  dot,
}: {
  children: Kids;
  bg: string;
  fg: string;
  border?: string;
  dot?: string;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: bg,
        borderColor: border,
        borderWidth: border ? 1 : 0,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: radius.pill,
        alignSelf: "flex-start",
      }}
    >
      {dot ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} /> : null}
      {typeof children === "string" || typeof children === "number" ? (
        <Text numberOfLines={1} style={{ color: fg, fontSize: font.sm, fontWeight: "700" }}>{children}</Text>
      ) : (
        children
      )}
    </View>
  );
}

// Status badge — louder than a generic Pill (uppercase micro-type, tinted
// fill, real border, status dot). Label text via i18n; color is always
// reinforcement, never the only channel.
// `status: TripStatus`, not `string`. As `string` this prop threw away the
// union at the component boundary, so nothing downstream could be checked: the
// colour lookup fell back to the `pending` swatch and the label fell back to
// the raw enum. A delivered trip awaiting POD approval rendered as an amber
// badge reading "PENDING_APPROVAL".
export function TripStatusBadge({ status }: { status: TripStatus }) {
  const { t } = useTranslation();
  // No `?? tripStatusColor.pending` fallback: tripStatusColor is keyed on
  // TripStatus, so every status resolves by construction. The fallback was not
  // defensive — it was the thing that hid the missing entry.
  const c = tripStatusColor[status];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        backgroundColor: c.bg,
        borderColor: c.border,
        borderWidth: 1.5,
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: radius.pill,
        alignSelf: "flex-start",
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.dot }} />
      <Text style={{ color: c.fg, fontSize: 11.5, fontWeight: "800", letterSpacing: 0.6, textTransform: "uppercase" }}>
        {t(tripStatusLabelKey(status), { defaultValue: status })}
      </Text>
    </View>
  );
}

// ── Avatar (navy circle, yellow initials/glyph) ──────────────────────
export function Avatar({ name, size = 38, glyph }: { name?: string; size?: number; glyph?: Kids }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.blue,
        borderWidth: 2,
        borderColor: colors.yellow,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {glyph ?? (
        <Text style={{ color: colors.yellow, fontSize: size * 0.36, fontWeight: "700" }}>
          {name ? initials(name) : "?"}
        </Text>
      )}
    </View>
  );
}

// ── Search input ─────────────────────────────────────────────────────
export function SearchInput({
  value,
  onChange,
  placeholder,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          paddingVertical: 9,
          paddingHorizontal: 12,
          minWidth: 240,
        },
        style,
      ]}
    >
      <Ionicons name="search" size={16} color={colors.textFaint} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={{ fontSize: font.md, flex: 1, color: colors.text, padding: 0 }}
      />
    </View>
  );
}

// ── Segmented filter with counts ─────────────────────────────────────
export function SegmentedFilter<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 7,
              paddingVertical: 8,
              paddingHorizontal: 15,
              borderRadius: radius.pill,
              borderWidth: 1.5,
              borderColor: active ? colors.blue : colors.border,
              backgroundColor: active ? colors.blue : colors.card,
            }}
          >
            <Text style={{ color: active ? "#fff" : colors.textMuted, fontWeight: "700", fontSize: font.md }}>{o.label}</Text>
            {o.count !== undefined && (
              <View
                style={{
                  backgroundColor: active ? "rgba(255,255,255,0.22)" : colors.panel,
                  borderRadius: radius.pill,
                  paddingVertical: 1,
                  paddingHorizontal: 7,
                }}
              >
                <Text style={{ color: active ? "#fff" : colors.textMuted, fontSize: font.xs, fontWeight: "700" }}>{o.count}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Chip grid ────────────────────────────────────────────────────────
// Filter chips laid out in EVEN columns (mobile) instead of ragged wrap.
// Options are chunked into rows of `columns`; each cell is flex:1 so every
// chip in a row is the same width, and a short final row is padded with
// invisible spacers so columns stay aligned. Narrow-only by convention —
// the PC keeps SegmentedFilter's inline wrap.
export function ChipGrid<T extends string>({
  options,
  value,
  onChange,
  columns,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  columns: number;
}) {
  const rows: { value: T; label: string; count?: number }[][] = [];
  for (let i = 0; i < options.length; i += columns) rows.push(options.slice(i, i + columns));
  return (
    <View style={{ gap: 8 }}>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: "row", gap: 8 }}>
          {row.map((o) => {
            const active = o.value === value;
            return (
              <Pressable
                key={o.value}
                onPress={() => onChange(o.value)}
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  paddingVertical: 9,
                  paddingHorizontal: 6,
                  borderRadius: radius.pill,
                  borderWidth: 1.5,
                  borderColor: active ? colors.blue : colors.border,
                  backgroundColor: active ? colors.blue : colors.card,
                }}
              >
                <Text numberOfLines={1} style={{ color: active ? "#fff" : colors.textMuted, fontWeight: "700", fontSize: font.md }}>
                  {o.label}
                </Text>
                {o.count !== undefined && (
                  <View
                    style={{
                      backgroundColor: active ? "rgba(255,255,255,0.22)" : colors.panel,
                      borderRadius: radius.pill,
                      paddingVertical: 1,
                      paddingHorizontal: 7,
                    }}
                  >
                    <Text style={{ color: active ? "#fff" : colors.textMuted, fontSize: font.xs, fontWeight: "700" }}>{o.count}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
          {/* Keep columns aligned when the last row is short. */}
          {row.length < columns &&
            Array.from({ length: columns - row.length }).map((_, i) => <View key={`pad-${i}`} style={{ flex: 1 }} />)}
        </View>
      ))}
    </View>
  );
}

// ── Progress bar ─────────────────────────────────────────────────────
export function ProgressBar({ pct, color = colors.blue, height = 8 }: { pct: number; color?: string; height?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View style={{ backgroundColor: colors.divider, borderRadius: radius.pill, height, width: "100%", overflow: "hidden" }}>
      <View style={{ width: `${clamped}%`, height: "100%", backgroundColor: color, borderRadius: radius.pill }} />
    </View>
  );
}

// ── Modal ────────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 460,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: Kids;
  width?: number;
}) {
  if (!open) return null;
  return (
    <RNModal visible transparent animationType="fade" onRequestClose={onClose}>
      {/* RN Modal portals outside the admin subtree — re-apply the Inter
          font scope so dialogs match (web only; see platform/webFonts). */}
      <Pressable onPress={onClose} style={styles.modalBackdrop} {...adminFontScope}>
        {/* Inner pressable swallows taps so content clicks don't close. */}
        <Pressable onPress={() => {}} style={[styles.modalCard, shadow.floating, { width, maxWidth: "100%" }]}>
          <View style={styles.modalHeader}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
              <View style={{ width: 4, height: 16, borderRadius: 2, backgroundColor: colors.yellow }} />
              <Text numberOfLines={1} style={{ fontSize: font.lg, fontWeight: "800", color: colors.text, flex: 1 }}>{title}</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={20} color={colors.textMuted} />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ padding: 20 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
    </RNModal>
  );
}

// ── Confirm dialog ───────────────────────────────────────────────────
// Generic Cancel/Confirm modal for destructive actions. The caller keeps its
// own error display; on success it should close the dialog itself.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onClose,
  onConfirm,
}: {
  title: string;
  body: Kids;
  confirmLabel?: string;
  pending?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal open onClose={onClose} title={title} width={420}>
      {typeof body === "string" ? (
        <Text style={{ fontSize: font.md, color: colors.text, lineHeight: 22, marginBottom: 14 }}>{body}</Text>
      ) : (
        <View style={{ marginBottom: 14 }}>{body}</View>
      )}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button variant="ghost" onPress={onClose} disabled={pending} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" onPress={onConfirm} disabled={pending} style={{ flex: 1 }}>
          {pending ? t("admin.working") : (confirmLabel ?? t("common.confirm"))}
        </Button>
      </View>
    </Modal>
  );
}

// ── Form input ───────────────────────────────────────────────────────
// `type` mirrors the web kit ("text" | "number" | "date"); number maps to the
// numeric keyboard. Date entry gets a real picker via platform/datePicker in
// Phase 2 — until then it's a plain YYYY-MM-DD text field.
export function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <View style={{ marginBottom: 14 }}>
      {label ? <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 6, color: colors.text }}>{label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        keyboardType={type === "number" ? "numeric" : "default"}
        style={{
          paddingVertical: 11,
          paddingHorizontal: 13,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          fontSize: font.md,
          color: colors.text,
          backgroundColor: colors.card,
        }}
      />
    </View>
  );
}

// ── Table pattern ────────────────────────────────────────────────────
// RN has no <table>: rows are flex layouts.
//
// OWNER RULING (13 Jul 2026): on NARROW screens, wide tables must NOT
// horizontal-scroll — render each row as a stacked CARD instead (key fields
// visible at once, secondary columns below or behind a tap-to-expand), and
// keep the full table on wide screens. See PerformanceScreen's leaderboard
// for the reference implementation. TableScroll remains for WIDE mode and
// for tables narrow enough to fit a phone without panning.
export function TableScroll({ children, minWidth = 640 }: { children: Kids; minWidth?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ minWidth, flex: 1 }}>{children}</View>
    </ScrollView>
  );
}

/** Header row for a flex "table" — panel background, muted uppercase labels. */
export function TableHeader({ children, style }: { children: Kids; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", backgroundColor: colors.panel, borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm, paddingVertical: 9, paddingHorizontal: 12, gap: 10 }, style]}>{children}</View>;
}

/** One data row — bottom hairline, aligned with TableHeader's flex columns. */
export function TableRow({ children, style }: { children: Kids; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: colors.divider, paddingVertical: 10, paddingHorizontal: 12, gap: 10 }, style]}>{children}</View>;
}

/** Column cell: flex-weighted text. Use textStyle for money/right-aligned cells. */
export function TableCell({ children, flex = 1, textStyle, header }: { children: Kids; flex?: number; textStyle?: StyleProp<TextStyle>; header?: boolean }) {
  return (
    <View style={{ flex, minWidth: 0 }}>
      {typeof children === "string" || typeof children === "number" ? (
        <Text
          numberOfLines={2}
          style={[
            header
              ? { fontSize: font.xs, fontWeight: "800", letterSpacing: 0.6, textTransform: "uppercase", color: colors.textMuted }
              : { fontSize: font.md, color: colors.text },
            textStyle,
          ]}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

// ── States ───────────────────────────────────────────────────────────
export function Spinner({ size = 28 }: { size?: number }) {
  return <ActivityIndicator size={size > 24 ? "large" : "small"} color={colors.blue} />;
}

export function CenterState({ children }: { children: Kids }) {
  return <View style={{ alignItems: "center", justifyContent: "center", gap: 12, padding: 50 }}>{children}</View>;
}

export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <CenterState>
      <Spinner />
      <Text style={{ fontSize: font.md, color: colors.textMuted }}>{label ?? t("common.loading")}</Text>
    </CenterState>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <CenterState>
      <Text style={{ fontSize: font.md, color: colors.red, fontWeight: "600", textAlign: "center" }}>{message}</Text>
      {onRetry && (
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </CenterState>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <CenterState>
      <Text style={{ fontSize: font.md, color: colors.textMuted, textAlign: "center" }}>{message}</Text>
    </CenterState>
  );
}

const styles = StyleSheet.create({
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 10 },
  sectionTick: { width: 4, borderRadius: 2, backgroundColor: colors.yellow, alignSelf: "stretch", marginVertical: 2 },
  disc: { position: "absolute" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(16,24,40,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.panel,
    gap: 10,
  },
});
