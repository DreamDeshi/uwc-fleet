import React from "react";
import { Text, View } from "react-native";
import { colors, font } from "../theme";
import { FilterDropdown } from "./ui";

// Owner feedback, 28 Aug 2026: editing a time by TYPING "10:00" into a box is
// not "easy" — tap a value instead. Typing stays available as a fallback (the
// caller renders its own text Input alongside this), it just isn't the first
// thing offered.
//
// Owner feedback again, same evening: a horizontal ScrollView has NOTHING for
// a mouse to grab. A first fix kept a touch-swipe chip strip on phone and
// added arrow buttons + a dropdown form on desktop — the owner rejected the
// chip strip outright on 30 Aug 2026 ("i dont want this type of at all"), on
// a narrow screenshot showing exactly that strip. So this is now ONE form,
// every width: two "value ▾" dropdowns, same shape as every other admin
// filter select (`FilterDropdown`). No horizontal scroll anywhere, no
// gesture to guess at. 24-hour values throughout this app, so no AM/PM
// segment.
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pad2 = (n: number) => String(n).padStart(2, "0");

export function TimeOfDayPicker({
  hour,
  minute,
  onChange,
  minuteStep = 5,
}: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  minuteStep?: number;
}) {
  const minutes = Array.from({ length: 60 / minuteStep }, (_, i) => i * minuteStep);
  const hourOptions = HOURS.map((h) => ({ value: String(h), label: pad2(h) }));
  const minuteOptions = minutes.map((m) => ({ value: String(m), label: pad2(m) }));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <FilterDropdown value={String(hour)} onChange={(v) => onChange(Number(v), minute)} options={hourOptions} />
      <Text style={{ fontSize: font.lg, fontWeight: "800", color: colors.textMuted }}>:</Text>
      <FilterDropdown value={String(minute)} onChange={(v) => onChange(hour, Number(v))} options={minuteOptions} />
    </View>
  );
}
