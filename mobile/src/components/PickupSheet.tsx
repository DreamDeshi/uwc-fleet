import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { PICKUP_MINUTE_STEP, type PickupSlot } from "../lib/bookingEdit";
import {
  bookableHours,
  bookableMinutes,
  dateForOffset,
  dayOffsetOf,
  dialAngle,
  dialIndexToHour,
  dialPosition,
  hourDialIndex,
  HOUR_RING,
  isDayBookable,
  isMonthReachable,
  maxBookableDate,
  meridiemOf,
  MINUTE_RING,
  monthGrid,
  sameDay,
  slotToDate,
} from "../lib/pickupCalendar";
import { formatDate, weekdayShortNames } from "../lib/format";

/**
 * The requestor's pickup picker: calendar → hour dial → minute dial, in one
 * sheet (design frames 5, 6 and 6b). Replaces two scrolling dropdowns.
 *
 * The three steps share one draft slot and only commit on Confirm, so backing
 * out leaves the booking's pickup untouched.
 *
 * WHAT IS DIMMED, AND WHY IT IS NOT DECORATION: every disabled day, hour and
 * minute comes from lib/pickupCalendar, which encodes the two real rules — the
 * fleet's 07:00→02:00 window and "not in the past". The frame's note about
 * 10 and 11 PM being closed does not match the shipped window (they are inside
 * it); the dimming here follows the window, which means the AM ring dims
 * 03:00–06:00 and today's rings shrink as the day goes on.
 */

const DIAL = 260;
const MARKER = 40;
const DIAL_INSET = 10;
const HAND_TOP = DIAL_INSET + MARKER / 2;

type Step = "date" | "hour" | "minute";

export function PickupSheet({
  visible,
  slot,
  now,
  isReturn,
  isAdmin,
  onConfirm,
  onClose,
  inline = false,
}: {
  visible: boolean;
  slot: PickupSlot;
  /** WIDE (>=1024px): render as a step of the form instead of an overlay — no
   *  Modal, no backdrop, no dimming. See the note above the return. */
  inline?: boolean;
  /** Injectable for tests/screenshots; defaults to the device clock. */
  now?: Date;
  /**
   * B7 — a RETURN booking is exempt from the 08:30 / 13:30 cut-offs ("for
   * return cargo from supplier / customer, they can choose pickup anytime
   * before 12am"). Defaults to false, i.e. RESTRICTED: forgetting it shows
   * fewer slots than the server would take, where the opposite default would
   * offer one the server refuses.
   */
  isReturn?: boolean;
  /** B7 — an ADMIN is offered a closed slot (they may override on the server,
   *  with a stated reason). Not an exemption; see pickupCalendar's CutoffOpts. */
  isAdmin?: boolean;
  onConfirm: (slot: PickupSlot) => void;
  onClose: () => void;
}) {
  const cutoffOpts = useMemo(
    () => ({ isReturn: isReturn === true, isAdmin: isAdmin === true }),
    [isReturn, isAdmin]
  );
  const { t } = useTranslation();
  const clock = useMemo(() => now ?? new Date(), [now, visible]);

  const [step, setStep] = useState<Step>("date");
  const [draft, setDraft] = useState<PickupSlot>(slot);
  // Which month the grid is showing — not necessarily the selected day's.
  const [cursor, setCursor] = useState(() => dateForOffset(clock, slot.dayOffset));
  // Tracked separately from the hour so tapping "12" on the AM ring means
  // midnight rather than silently flipping the requestor to noon.
  const [meridiem, setMeridiem] = useState<"AM" | "PM">(meridiemOf(slot.hour));

  // Re-seed every time the sheet opens: it is a draft of the CURRENT pickup,
  // and a stale draft would quietly re-apply an abandoned edit.
  useEffect(() => {
    if (!visible) return;
    setDraft(slot);
    setStep("date");
    setCursor(dateForOffset(now ?? new Date(), slot.dayOffset));
    setMeridiem(meridiemOf(slot.hour));
  }, [visible]);

  const selectedDate = dateForOffset(clock, draft.dayOffset);
  const hoursToday = bookableHours(selectedDate, clock, cutoffOpts);
  const minutesThisHour = bookableMinutes(selectedDate, draft.hour, clock, cutoffOpts);

  const weekdays = weekdayShortNames();
  const cells = monthGrid(cursor.getFullYear(), cursor.getMonth());
  const prevMonth = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1);
  const nextMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  const canGoBack = isMonthReachable(prevMonth.getFullYear(), prevMonth.getMonth(), clock);
  const canGoForward = isMonthReachable(nextMonth.getFullYear(), nextMonth.getMonth(), clock);

  const pickDay = (date: Date) => {
    const dayOffset = dayOffsetOf(date, clock);
    const hours = bookableHours(date, clock, cutoffOpts);
    // Keep the chosen time when the new date still offers it; otherwise fall to
    // that date's first open slot rather than holding a pickup in the past.
    const hour = hours.includes(draft.hour) ? draft.hour : hours[0];
    const minutes = bookableMinutes(date, hour, clock, cutoffOpts);
    const minute = minutes.includes(draft.minute) ? draft.minute : (minutes[0] ?? 0);
    setDraft({ dayOffset, hour, minute });
    setMeridiem(meridiemOf(hour));
  };

  const pickHour = (index: number) => {
    const hour = dialIndexToHour(index, meridiem);
    const minutes = bookableMinutes(selectedDate, hour, clock, cutoffOpts);
    if (minutes.length === 0) return;
    setDraft((d) => ({
      ...d,
      hour,
      minute: minutes.includes(d.minute) ? d.minute : minutes[0],
    }));
  };

  const switchMeridiem = (next: "AM" | "PM") => {
    setMeridiem(next);
    const hour = dialIndexToHour(hourDialIndex(draft.hour), next);
    const minutes = bookableMinutes(selectedDate, hour, clock, cutoffOpts);
    // A meridiem with nothing open under the current hour still switches the
    // ring — the requestor is mid-choice — but the draft only moves if it can.
    if (minutes.length === 0) return;
    setDraft((d) => ({ ...d, hour, minute: minutes.includes(d.minute) ? d.minute : minutes[0] }));
  };

  const headerDate = slotToDate(clock, draft);
  // ⚠ The header used to render a literal "— : —" on the date step
  // (`timeChosen = step !== "date"`), which read as a rendering failure rather
  // than as an empty field — and it was never empty: `slot` always carries an
  // hour and a minute, and `draft` is seeded from it. The header calls itself
  // "the running answer", so it shows the answer from the first step.

  const body = (
    <>
        {/* Header — the running answer, so the requestor always sees what they
            are about to commit to rather than just where the cursor is. */}
        <View style={styles.head}>
          <Text style={styles.headLabel}>{t("booking.pickupSheetTitle")}</Text>
          <View style={styles.headLine}>
            <Text style={styles.headDate}>{shortDay(headerDate, weekdays)}</Text>
            <Text style={styles.headTime}>{formatClock(draft.hour, draft.minute)}</Text>
          </View>
        </View>

        {step === "date" ? (
          <>
            <View style={styles.monthBar}>
              <TouchableOpacity
                style={styles.monthArrow}
                disabled={!canGoBack}
                onPress={() => setCursor(prevMonth)}
                accessibilityLabel={t("booking.prevMonth")}
              >
                <Text style={[styles.monthArrowText, !canGoBack && styles.monthArrowOff]}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.monthTitle}>{monthTitle(cursor)}</Text>
              <TouchableOpacity
                style={styles.monthArrow}
                disabled={!canGoForward}
                onPress={() => setCursor(nextMonth)}
                accessibilityLabel={t("booking.nextMonth")}
              >
                <Text style={[styles.monthArrowText, !canGoForward && styles.monthArrowOff]}>›</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.weekRow}>
              {weekdays.map((w, i) => (
                <Text key={`${w}-${i}`} style={styles.weekday}>
                  {w.slice(0, 1)}
                </Text>
              ))}
            </View>

            <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid}>
              {cells.map((cell, i) => {
                if (!cell.date) return <View key={`blank-${i}`} style={styles.cell} />;
                const date = cell.date;
                const enabled = isDayBookable(date, clock, cutoffOpts);
                const selected = sameDay(date, selectedDate);
                const today = sameDay(date, clock);
                return (
                  <TouchableOpacity
                    key={date.toISOString()}
                    style={styles.cell}
                    disabled={!enabled}
                    onPress={() => pickDay(date)}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: !enabled }}
                    accessibilityLabel={formatDate(date)}
                  >
                    <View
                      style={[
                        styles.dayPill,
                        selected && styles.dayPillSelected,
                        !selected && today && styles.dayPillToday,
                      ]}
                    >
                      <Text
                        style={[
                          styles.dayText,
                          !enabled && styles.dayTextOff,
                          selected && styles.dayTextSelected,
                          !selected && today && styles.dayTextToday,
                        ]}
                      >
                        {date.getDate()}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <Text style={styles.hint}>
              {t("booking.bookableThrough", { date: formatDate(maxBookableDate(clock)) })}
            </Text>
          </>
        ) : (
          <>
            <View style={styles.dialBar}>
              <View style={styles.unitTabs}>
                {(["hour", "minute"] as const).map((unit) => (
                  <TouchableOpacity
                    key={unit}
                    style={[styles.unitTab, step === unit && styles.unitTabActive]}
                    onPress={() => setStep(unit)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: step === unit }}
                  >
                    <Text style={[styles.unitTabText, step === unit && styles.unitTabTextActive]}>
                      {t(unit === "hour" ? "booking.unitHour" : "booking.unitMinute")}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.meridiem}>
                {(["AM", "PM"] as const).map((m) => (
                  <TouchableOpacity
                    key={m}
                    style={[styles.meridiemBtn, meridiem === m && styles.meridiemBtnActive]}
                    onPress={() => switchMeridiem(m)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: meridiem === m }}
                  >
                    <Text style={[styles.meridiemText, meridiem === m && styles.meridiemTextActive]}>
                      {m}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            <View style={styles.dialWrap}>
              <View style={styles.dial}>
                {/* The hand: a full-size square rotated about its own centre, so
                    no transform-origin trick is needed (RN has none). */}
                <View
                  pointerEvents="none"
                  style={[
                    styles.handBox,
                    {
                      transform: [
                        {
                          rotate: `${
                            step === "hour"
                              ? dialAngle(hourDialIndex(draft.hour), 12)
                              : dialAngle(draft.minute / PICKUP_MINUTE_STEP, 12)
                          }deg`,
                        },
                      ],
                    },
                  ]}
                >
                  <View style={styles.hand} />
                </View>
                <View pointerEvents="none" style={styles.hub} />

                {(step === "hour" ? HOUR_RING : MINUTE_RING).map((value, index) => {
                  const isHour = step === "hour";
                  const hour24 = isHour ? dialIndexToHour(index, meridiem) : draft.hour;
                  const enabled = isHour
                    ? bookableMinutes(selectedDate, hour24, clock, cutoffOpts).length > 0
                    : minutesThisHour.includes(value);
                  const selected = isHour
                    ? draft.hour === hour24
                    : draft.minute === value;
                  return (
                    <TouchableOpacity
                      key={`${step}-${value}`}
                      disabled={!enabled}
                      onPress={() =>
                        isHour ? pickHour(index) : setDraft((d) => ({ ...d, minute: value }))
                      }
                      accessibilityRole="button"
                      accessibilityState={{ selected, disabled: !enabled }}
                      style={[
                        styles.marker,
                        dialPosition(index, 12, DIAL, MARKER, DIAL_INSET),
                        selected && styles.markerSelected,
                      ]}
                    >
                      <Text
                        style={[
                          styles.markerText,
                          !enabled && styles.markerTextOff,
                          selected && styles.markerTextSelected,
                        ]}
                      >
                        {isHour ? value : String(value).padStart(2, "0")}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <Text style={styles.hint}>
              {t(step === "hour" ? "booking.dialHourHint" : "booking.dialMinuteHint")}
            </Text>
          </>
        )}

        <View style={styles.footer}>
          <TouchableOpacity
            style={styles.secondaryBtn}
            disabled={inline && step === "date"}
            onPress={() => (step === "date" ? (inline ? undefined : onClose()) : setStep(step === "minute" ? "hour" : "date"))}
          >
            {/* Inline there is nothing to cancel OUT of — the picker is part of
                the page — so on the first step the button is a disabled Back
                rather than a Cancel that would do nothing. */}
            <Text style={[styles.secondaryText, inline && step === "date" && styles.secondaryTextOff]}>
              {t(inline || step !== "date" ? "common.back" : "common.cancel")}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.primaryBtn, hoursToday.length === 0 && styles.primaryBtnOff]}
            disabled={hoursToday.length === 0}
            onPress={() => {
              if (step === "date") return setStep("hour");
              if (step === "hour") return setStep("minute");
              onConfirm(draft);
              // Inline there is no overlay to dismiss: commit and return to the
              // calendar, so the picker keeps showing the slot it just set.
              if (inline) return setStep("date");
              onClose();
            }}
          >
            <Text style={styles.primaryText}>
              {t(
                step === "date"
                  ? "booking.nextTime"
                  : step === "hour"
                    ? "booking.nextMinute"
                    : "common.confirm"
              )}
            </Text>
          </TouchableOpacity>
        </View>
    </>
  );

  // ── WIDE: the picker is a STEP OF THE FORM, not an overlay ───────────────
  //
  // At >=1024px the phone sheet was a 460px card floating over a dimmed 1440px
  // form: it covered the form it belongs to, hid the primary action behind it,
  // cut the fleet-hours hint mid-sentence, and sat beside "Pickup date" while
  // overlapping "Pickup time" and "Remarks". Owner review, 18 Aug 2026.
  //
  // The fix is not a smaller overlay. An anchored popover keeps the phone
  // interaction model — dim the page for one field — and adds viewport
  // collision logic (flip above when there is no room below) that exists
  // nowhere else in this codebase. Inline removes the problem instead of
  // mitigating it: this control is a step of a form that is ALREADY a wide
  // stepped layout (`layout.wide` is 1160 precisely so wide gets real columns
  // rather than a stranded phone column), so at this width it can simply BE a
  // step.
  //
  // ⚠ The narrow path below is untouched. Phones keep the sheet, the backdrop
  // and the slide, because on a phone an overlay IS the right model.
  if (inline) return <View style={styles.inlineCard}>{body}</View>;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel={t("common.cancel")} />
      <View style={styles.sheet}>{body}</View>
    </Modal>
  );
}

// "Wed 12 Aug" — the header line. Weekday names come from the shared localised
// helper so the sheet reads in the app's language, not always English.
function shortDay(d: Date, weekdays: string[]): string {
  const weekday = weekdays[(d.getDay() + 6) % 7];
  return `${weekday} ${formatDate(d).replace(/\s\d{4}$/, "")}`;
}

function monthTitle(d: Date): string {
  return formatDate(new Date(d.getFullYear(), d.getMonth(), 1)).replace(/^\d+\s/, "");
}

function formatClock(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(26,31,94,0.32)" },
  // The inline (wide) container. A card in the form's own column: no rounded
  // top-only corners, no bottom padding for a phone's home indicator, and no
  // width cap fighting the column it sits in.
  inlineCard: {
    backgroundColor: colors.white,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingBottom: 18,
    marginTop: 8,
    alignSelf: "stretch",
  },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 26,
    // On a desktop browser the sheet would otherwise stretch across a 1440px
    // monitor; the dial is a fixed 260px and looks stranded in the middle.
    width: "100%",
    maxWidth: 460,
    alignSelf: "center",
  },

  head: { paddingHorizontal: 22, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.bg, gap: 6 },
  headLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase", color: colors.grey },
  headLine: { flexDirection: "row", alignItems: "baseline", gap: 10, flexWrap: "wrap" },
  headDate: { fontSize: 26, fontWeight: "900", color: colors.navy, letterSpacing: -0.5 },
  headTime: { fontSize: 26, fontWeight: "900", color: colors.blue, letterSpacing: -0.5 },
  headTimeEmpty: { fontSize: 20, fontWeight: "700", color: colors.textFaint },

  monthBar: { paddingHorizontal: 22, paddingTop: 18, paddingBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  monthArrow: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  monthArrowText: { fontSize: 26, lineHeight: 30, color: colors.blue, fontWeight: "700" },
  monthArrowOff: { color: colors.border },
  monthTitle: { fontSize: 16, fontWeight: "800", color: colors.navy },

  weekRow: { flexDirection: "row", paddingHorizontal: 18 },
  weekday: { flex: 1, textAlign: "center", fontSize: 12, fontWeight: "700", color: colors.textFaint, paddingVertical: 6 },
  gridScroll: { maxHeight: 6 * 46 },
  grid: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 18 },
  cell: { width: `${100 / 7}%`, height: 46, alignItems: "center", justifyContent: "center" },
  dayPill: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  dayPillSelected: { backgroundColor: colors.blue },
  dayPillToday: { borderWidth: 1.5, borderColor: colors.blue },
  dayText: { fontSize: 15, fontWeight: "600", color: colors.navy },
  dayTextOff: { color: colors.border, fontWeight: "400" },
  dayTextSelected: { color: colors.white, fontWeight: "800" },
  dayTextToday: { color: colors.blue, fontWeight: "800" },

  dialBar: { paddingHorizontal: 22, paddingTop: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  unitTabs: { flexDirection: "row", alignItems: "center", gap: 8 },
  unitTab: { height: 36, paddingHorizontal: 14, borderRadius: 10, justifyContent: "center" },
  unitTabActive: { backgroundColor: colors.tintBlue },
  unitTabText: { fontSize: 14, fontWeight: "700", color: colors.textFaint },
  unitTabTextActive: { color: colors.blue, fontWeight: "800" },
  meridiem: { flexDirection: "row", borderWidth: 1.5, borderColor: colors.border, borderRadius: 10, overflow: "hidden" },
  meridiemBtn: { width: 48, height: 36, alignItems: "center", justifyContent: "center" },
  meridiemBtnActive: { backgroundColor: colors.blue },
  meridiemText: { fontSize: 13, fontWeight: "700", color: colors.textFaint },
  meridiemTextActive: { color: colors.white, fontWeight: "800" },

  dialWrap: { paddingTop: 18, paddingBottom: 6, alignItems: "center" },
  dial: { width: DIAL, height: DIAL, borderRadius: DIAL / 2, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.borderLight },
  handBox: { position: "absolute", width: DIAL, height: DIAL },
  hand: { position: "absolute", left: DIAL / 2 - 1, top: HAND_TOP, width: 2, height: DIAL / 2 - HAND_TOP, backgroundColor: colors.blue },
  hub: { position: "absolute", left: DIAL / 2 - 4, top: DIAL / 2 - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.blue },
  marker: { position: "absolute", width: MARKER, height: MARKER, borderRadius: MARKER / 2, alignItems: "center", justifyContent: "center" },
  markerSelected: { backgroundColor: colors.blue },
  markerText: { fontSize: 15, fontWeight: "700", color: colors.navy },
  markerTextOff: { color: colors.border },
  markerTextSelected: { color: colors.white, fontWeight: "800" },

  hint: { paddingHorizontal: 22, paddingTop: 10, fontSize: 12, lineHeight: 18, color: colors.textMuted },

  footer: { paddingHorizontal: 22, paddingTop: 16, flexDirection: "row", gap: 10 },
  secondaryBtn: { width: 104, height: 52, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  secondaryTextOff: { opacity: 0.4 },
  secondaryText: { fontSize: 15, fontWeight: "700", color: colors.textMuted },
  primaryBtn: { flex: 1, height: 52, borderRadius: radius.md, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  primaryBtnOff: { opacity: 0.5 },
  primaryText: { fontSize: 16, fontWeight: "800", color: colors.white },
});
