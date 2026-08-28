import React, { useRef, useState } from "react";
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, font, radius } from "../theme";

// Owner feedback, 28 Aug 2026: editing a time by TYPING "10:00" into a box is
// not "easy" — tap a value instead. Typing stays available as a fallback (the
// caller renders its own text Input alongside this), it just isn't the first
// thing offered.
//
// Owner feedback again, same evening, on a desktop screenshot: a horizontal
// ScrollView has NOTHING for a mouse to grab. Touch-swipe reaches hidden chips
// on a phone; a mouse has no swipe gesture, RN-Web does not turn a vertical
// wheel into horizontal scroll on its own, and with no visible scrollbar the
// row just LOOKS like six buttons and a dead end past hour 10. Fixed with the
// thing "a typical website" actually uses for this: explicit prev/next arrow
// buttons that page the strip, PLUS the OS scrollbar shown on web so the strip
// reads as scrollable at all. Both work identically by mouse, trackpad or
// touch — nothing here is guessing at a gesture.
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const pad2 = (n: number) => String(n).padStart(2, "0");
// Approximate rendered width of one two-digit chip (padding + text + the gap
// to its neighbour) — close enough to scroll the selected value roughly into
// view on open, and to size one arrow-button "page". Doesn't need to be exact
// since the strip stays scrollable either way.
const CHIP_WIDTH = 56;
const PAGE_CHIPS = 4;

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

function ArrowButton({ direction, onPress, disabled }: { direction: "left" | "right"; onPress: () => void; disabled: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={direction === "left" ? "Scroll earlier" : "Scroll later"}
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: disabled ? "transparent" : colors.card,
        borderWidth: disabled ? 0 : 1,
        borderColor: colors.border,
      }}
    >
      <Ionicons
        name={direction === "left" ? "chevron-back" : "chevron-forward"}
        size={16}
        color={disabled ? colors.border : colors.text}
      />
    </TouchableOpacity>
  );
}

/**
 * One horizontal row of chips with a scroll position tracked in state (not
 * just a ref) so the two ArrowButtons can disable themselves at each end —
 * without that, "scroll earlier" past hour 0 or "scroll later" past hour 23
 * would look like it worked (it just clamps) with no sign why nothing moved.
 */
function ChipRow<T extends number>({
  values,
  selected,
  onSelect,
  scrollRef,
  onLayoutContentWidth,
}: {
  values: readonly T[];
  selected: T;
  onSelect: (v: T) => void;
  scrollRef: React.RefObject<ScrollView | null>;
  onLayoutContentWidth: (w: number) => void;
}) {
  const [scrollX, setScrollX] = useState(0);
  const [viewportW, setViewportW] = useState(0);
  const [contentW, setContentW] = useState(0);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setScrollX(e.nativeEvent.contentOffset.x);
  };
  const page = (dir: 1 | -1) => {
    const next = Math.max(0, scrollX + dir * CHIP_WIDTH * PAGE_CHIPS);
    scrollRef.current?.scrollTo({ x: next, animated: true });
  };

  const atStart = scrollX <= 0;
  const atEnd = scrollX + viewportW >= contentW - 1;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <ArrowButton direction="left" onPress={() => page(-1)} disabled={atStart} />
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={Platform.OS === "web"}
        contentContainerStyle={{ paddingVertical: 2 }}
        style={{ flex: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onLayout={(e) => setViewportW(e.nativeEvent.layout.width)}
        onContentSizeChange={(w) => {
          setContentW(w);
          onLayoutContentWidth(w);
        }}
      >
        {values.map((v) => (
          <Chip key={v} label={pad2(v)} selected={v === selected} onPress={() => onSelect(v)} />
        ))}
      </ScrollView>
      <ArrowButton direction="right" onPress={() => page(1)} disabled={atEnd} />
    </View>
  );
}

/**
 * Tap an hour, tap a minute — two rows, no keyboard. `minuteStep` defaults to
 * 5 (the same grid the requestor's own pickup dial uses), so an exact-on-the-
 * hour setting like the B7 cut-offs needs one tap per row.
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
  const scrolledOnMount = useRef(false);

  // Bring the CURRENT value into view once, when the strip first reports its
  // content size (a fresh modal open) — a chip strip that opens showing
  // 00-05 while the real value is 23:xx makes the admin hunt for what they're
  // already on, which is the opposite of "easy". Gated on a ref (not empty
  // deps) because onContentSizeChange, not mount, is the first point the
  // ScrollView can actually accept a scrollTo — re-scrolling on every later
  // resize would fight the admin's own scrolling.
  const scrollToCurrent = () => {
    if (scrolledOnMount.current) return;
    scrolledOnMount.current = true;
    hourScroll.current?.scrollTo({ x: Math.max(0, CHIP_WIDTH * HOURS.indexOf(hour) - CHIP_WIDTH * 2), animated: false });
    minuteScroll.current?.scrollTo({
      x: Math.max(0, CHIP_WIDTH * minutes.indexOf(minute) - CHIP_WIDTH * 2),
      animated: false,
    });
  };

  return (
    <View style={{ gap: 8 }}>
      <ChipRow
        values={HOURS}
        selected={hour}
        onSelect={(h) => onChange(h, minute)}
        scrollRef={hourScroll}
        onLayoutContentWidth={scrollToCurrent}
      />
      <ChipRow
        values={minutes}
        selected={minute}
        onSelect={(m) => onChange(hour, m)}
        scrollRef={minuteScroll}
        onLayoutContentWidth={scrollToCurrent}
      />
    </View>
  );
}
