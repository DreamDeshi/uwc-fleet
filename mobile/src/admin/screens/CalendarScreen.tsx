// Calendar — the admin's one place for date-scoped fleet settings (owner ask,
// 2026-07-19): a real month grid painting public holidays + driver-leave onto
// the dates, with the add/remove management below behind a segmented toggle.
// Holidays moved off Incentive Rates, leave off Driver Management. Built to
// grow. Content only; the shell draws the header.
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useDrivers, useHolidays, useLeaves } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { MonthCalendar } from "../components/MonthCalendar";
import { HolidaysPanel } from "../components/HolidaysPanel";
import { LeavePanel } from "../components/LeavePanel";

type Section = "holidays" | "leave";

// 2020-06-01 is a Monday — anchor for Mon-first weekday short labels.
const MON_ANCHOR = new Date(2020, 5, 1);

export function CalendarScreen() {
  const { t, i18n } = useTranslation();
  const wide = useLayoutMode() === "wide";
  const [section, setSection] = useState<Section>("holidays");
  const drivers = useDrivers();
  const holidays = useHolidays();
  const leaves = useLeaves();

  const locale = i18n.language === "ms" ? "ms-MY" : i18n.language === "zh" ? "zh-CN" : "en-MY";
  const monthLabels = useMemo(
    () => Array.from({ length: 12 }, (_, m) => new Date(2020, m, 1).toLocaleDateString(locale, { month: "long" })),
    [locale]
  );
  const weekdayLabels = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date(MON_ANCHOR);
        d.setDate(d.getDate() + i);
        return d.toLocaleDateString(locale, { weekday: "short" });
      }),
    [locale]
  );

  const options: { value: Section; label: string }[] = [
    { value: "holidays", label: t("admin.calendar.holidays") },
    { value: "leave", label: t("admin.calendar.leave") },
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 14 }}
    >
      {/* The month grid — holidays + leave painted on the dates. */}
      <MonthCalendar
        holidays={holidays.data ?? []}
        leaves={leaves.data ?? []}
        monthLabels={monthLabels}
        weekdayLabels={weekdayLabels}
      />

      {/* Manage — add / remove, behind the segmented toggle. */}
      <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.textMuted, letterSpacing: 0.5, textTransform: "uppercase", marginTop: 4 }}>
        {t("admin.calendar.manage")}
      </Text>
      <View style={styles.segment}>
        {options.map((o) => {
          const active = section === o.value;
          return (
            <Pressable key={o.value} onPress={() => setSection(o.value)} style={[styles.segBtn, active && styles.segBtnActive]}>
              <Text style={[styles.segText, active && styles.segTextActive]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {section === "holidays" ? <HolidaysPanel /> : <LeavePanel drivers={drivers.data ?? []} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: "row",
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 4,
    alignSelf: "flex-start",
    maxWidth: 420,
    width: "100%",
  },
  segBtn: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 9, borderRadius: radius.sm },
  segBtnActive: { backgroundColor: colors.blue },
  segText: { fontSize: font.md, fontWeight: "700", color: colors.textMuted },
  segTextActive: { color: "#fff" },
});
