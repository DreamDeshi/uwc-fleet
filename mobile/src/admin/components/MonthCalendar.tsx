// A real month-grid calendar for the admin Calendar screen — public holidays
// and driver-leave spans painted onto the dates, with month navigation. Tapping
// a day surfaces that day's detail (holidays + who's on leave). Read-only view;
// the add/remove management lives in the panels below it.
import React, { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, font, radius } from "../theme";
import { Card } from "./ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DriverLeaveEntry, PublicHoliday } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Mon-first weekday index (Mon=0 … Sun=6).
const monFirst = (jsDay: number) => (jsDay + 6) % 7;

export function MonthCalendar({
  holidays,
  leaves,
  monthLabels,
  weekdayLabels,
}: {
  holidays: PublicHoliday[];
  leaves: DriverLeaveEntry[];
  monthLabels: string[]; // 12 localised month names
  weekdayLabels: string[]; // 7 short labels, Mon-first
}) {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const today = new Date();
  const [cursor, setCursor] = useState(() => ({ y: today.getFullYear(), m: today.getMonth() }));
  const [selected, setSelected] = useState<string | null>(null);

  const holidayByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const h of holidays) map.set(h.date.slice(0, 10), h.name);
    return map;
  }, [holidays]);

  // date key → drivers on leave that day.
  const leaveByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const l of leaves) {
      const start = l.start_date.slice(0, 10);
      const end = (l.end_date ?? l.start_date).slice(0, 10);
      const d = new Date(`${start}T00:00:00`);
      const last = new Date(`${end}T00:00:00`);
      // guard against a runaway range
      let guard = 0;
      while (d <= last && guard++ < 400) {
        const k = ymd(d);
        map.set(k, [...(map.get(k) ?? []), l.driver.name]);
        d.setDate(d.getDate() + 1);
      }
    }
    return map;
  }, [leaves]);

  const cells = useMemo(() => {
    const first = new Date(cursor.y, cursor.m, 1);
    const lead = monFirst(first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const date = new Date(cursor.y, cursor.m, i - lead + 1);
      return { date, key: ymd(date), inMonth: date.getMonth() === cursor.m };
    });
  }, [cursor]);

  const todayKey = ymd(today);
  const step = (delta: number) => {
    setSelected(null);
    setCursor(({ y, m }) => {
      const nm = m + delta;
      return { y: y + Math.floor(nm / 12), m: ((nm % 12) + 12) % 12 };
    });
  };

  const cellH = narrow ? 46 : 76;
  const selHolidays = selected ? holidayByKey.get(selected) : undefined;
  const selLeave = selected ? leaveByKey.get(selected) ?? [] : [];

  return (
    <Card>
      {/* Month nav */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <Pressable onPress={() => step(-1)} hitSlop={8} accessibilityLabel="Previous month" style={navBtn}>
          <Ionicons name="chevron-back" size={18} color={colors.text} />
        </Pressable>
        <Text style={{ fontSize: font.lg, fontWeight: "800", color: colors.text }}>
          {monthLabels[cursor.m]} {cursor.y}
        </Text>
        <Pressable onPress={() => step(1)} hitSlop={8} accessibilityLabel="Next month" style={navBtn}>
          <Ionicons name="chevron-forward" size={18} color={colors.text} />
        </Pressable>
      </View>

      {/* Weekday header */}
      <View style={{ flexDirection: "row" }}>
        {weekdayLabels.map((w, i) => (
          <Text
            key={i}
            style={{ flex: 1, textAlign: "center", fontSize: font.xs, fontWeight: "800", color: i >= 5 ? colors.textFaint : colors.textMuted, paddingBottom: 6, textTransform: "uppercase" }}
          >
            {w}
          </Text>
        ))}
      </View>

      {/* Grid */}
      <View style={{ borderTopWidth: 1, borderLeftWidth: 1, borderColor: colors.divider, borderRadius: radius.sm, overflow: "hidden" }}>
        {Array.from({ length: 6 }, (_, row) => (
          <View key={row} style={{ flexDirection: "row" }}>
            {cells.slice(row * 7, row * 7 + 7).map((c) => {
              const holiday = holidayByKey.get(c.key);
              const leaveNames = leaveByKey.get(c.key) ?? [];
              const isToday = c.key === todayKey;
              const isSel = c.key === selected;
              return (
                <Pressable
                  key={c.key}
                  onPress={() => setSelected(isSel ? null : c.key)}
                  style={{
                    flex: 1,
                    height: cellH,
                    padding: 4,
                    borderRightWidth: 1,
                    borderBottomWidth: 1,
                    borderColor: colors.divider,
                    backgroundColor: isSel ? colors.blueTint : holiday ? colors.yellowTint : c.inMonth ? colors.card : colors.panel,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor: isToday ? colors.blue : "transparent",
                      }}
                    >
                      <Text style={{ fontSize: font.xs, fontWeight: isToday ? "800" : "600", color: isToday ? "#fff" : c.inMonth ? colors.text : colors.textFaint }}>
                        {c.date.getDate()}
                      </Text>
                    </View>
                    {leaveNames.length > 0 && (
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.blue }} />
                        {leaveNames.length > 1 && <Text style={{ fontSize: 9, fontWeight: "800", color: colors.blue }}>{leaveNames.length}</Text>}
                      </View>
                    )}
                  </View>
                  {holiday && !narrow ? (
                    <Text numberOfLines={2} style={{ fontSize: 10, fontWeight: "700", color: colors.amber, marginTop: 2, lineHeight: 12 }}>
                      {holiday}
                    </Text>
                  ) : holiday && narrow ? (
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.amber, marginTop: 3, marginLeft: 2 }} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>

      {/* Legend */}
      <View style={{ flexDirection: "row", gap: 16, marginTop: 10 }}>
        <Legend color={colors.amber} label={t("admin.calendar.legendHoliday")} />
        <Legend color={colors.blue} label={t("admin.calendar.legendLeave")} />
      </View>

      {/* Selected-day detail */}
      {selected && (
        <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 12 }}>
          <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.text, marginBottom: 6 }}>{selected}</Text>
          {selHolidays ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: selLeave.length ? 6 : 0 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.amber }} />
              <Text style={{ fontSize: font.sm, color: colors.text }}>{selHolidays}</Text>
            </View>
          ) : null}
          {selLeave.map((name, i) => (
            <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue }} />
              <Text style={{ fontSize: font.sm, color: colors.text }}>{t("admin.calendar.onLeave", { name })}</Text>
            </View>
          ))}
          {!selHolidays && selLeave.length === 0 && (
            <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.calendar.nothingOnDay")}</Text>
          )}
        </View>
      )}
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ fontSize: font.xs, color: colors.textMuted, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

const navBtn = {
  width: 34,
  height: 34,
  borderRadius: 17,
  alignItems: "center" as const,
  justifyContent: "center" as const,
  backgroundColor: colors.panel,
  borderWidth: 1,
  borderColor: colors.border,
};
