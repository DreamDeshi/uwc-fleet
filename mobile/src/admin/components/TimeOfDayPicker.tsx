import React, { useEffect, useRef } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { colors, font, radius } from "../theme";

// Owner feedback, 28 Aug 2026: editing a time by TYPING "10:00" into a box is
// not "easy" — tap a value instead. Typing stays available as a fallback (the
// caller renders its own text Input alongside this), it just isn't the first
// thing offered.
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pad2 = (n: number) => String(n).padStart(2, "0");
// Approximate rendered width of one two-digit chip (padding + text + the gap
// to its neighbour) — close enough to scroll the selected value roughly into
// view on open; it doesn't need to be exact since the strip stays scrollable.
const CHIP_WIDTH = 56;

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: radius.pill,
        borderWidth: 1.5,
        borderColor: selected ? colors.blue : colors.border,
        backgroundColor: selected ? colors.blue : colors.card,
        marginRight: 8,
      }}
    >
      <Text style={{ fontSize: font.md, fontWeight: "700", color: selected ? "#fff" : colors.text }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * Tap an hour, tap a minute — two scrollable rows, no keyboard. `minuteStep`
 * defaults to 5 (the same grid the requestor's own pickup dial uses), so an
 * exact-on-the-hour setting like the B7 cut-offs needs one tap per row.
 */
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
  const hourScroll = useRef<ScrollView>(null);
  const minuteScroll = useRef<ScrollView>(null);

  // Bring the CURRENT value into view once, when the picker first mounts (a
  // fresh modal open) — a chip strip that opens showing 00-05 while the real
  // value is 23:xx makes the admin scroll to find what they're already on,
  // which is the opposite of "easy". Deliberately only on mount (empty deps):
  // re-scrolling on every keystroke while the admin types in the fallback
  // Input would fight their own scrolling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    hourScroll.current?.scrollTo({ x: Math.max(0, CHIP_WIDTH * HOURS.indexOf(hour) - CHIP_WIDTH * 2), animated: false });
    minuteScroll.current?.scrollTo({
      x: Math.max(0, CHIP_WIDTH * minutes.indexOf(minute) - CHIP_WIDTH * 2),
      animated: false,
    });
  }, []);

  return (
    <View style={{ gap: 8 }}>
      <ScrollView ref={hourScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 2 }}>
        {HOURS.map((h) => (
          <Chip key={h} label={pad2(h)} selected={h === hour} onPress={() => onChange(h, minute)} />
        ))}
      </ScrollView>
      <ScrollView ref={minuteScroll} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 2 }}>
        {minutes.map((m) => (
          <Chip key={m} label={pad2(m)} selected={m === minute} onPress={() => onChange(hour, m)} />
        ))}
      </ScrollView>
    </View>
  );
}
