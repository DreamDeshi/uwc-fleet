import React, { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { greetingFontSize } from "../../lib/greetingName";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { DriverTabParamList } from "../../navigation/types";
import { useAuth } from "../../context/AuthContext";
import { useTrips, useMyTruckFuel, useUpdateTripStatus } from "../../hooks/queries";
import { apiErrorCode, apiErrorMessage } from "../../services/api";
import { colors, layout, radius, shadow } from "../../theme";
import { LoadingState, ErrorState } from "../../components/States";
import { LogFuelModal } from "../../components/LogFuelModal";
import { TripStopLadder } from "../../components/TripStopLadder";
import { formatDate, formatTime, relativeStart } from "../../lib/format";
import { daysSinceFill, fuelLogNudge } from "../../lib/fuelStats";
import { totalPallets } from "../../lib/trip";
import { shouldReconcileStart } from "../../lib/startTrip";
import { buildDriverDay, currentStopNumber, stopProgress, stopsOf } from "../../lib/driverHome";
import type { DriverDay } from "../../lib/driverHome";
import { Trip } from "../../types";

type Nav = BottomTabNavigationProp<DriverTabParamList>;

// Driver Home, rebuilt to the approved design (driver screens, 29 Jul 2026).
//
// The screen answers one question — what am I doing now — and answers it with
// the WORK, never with money. Every RM figure was removed: the design puts pay
// on My Stats (and Trip Details, where a driver checks why he was paid), so
// nothing here can be mistaken for approved pay. The old home showed a yellow
// "Est." pill per assignment and a green incentive on each completed card;
// both duplicated figures that carry approval rules elsewhere.
//
// One trip is the subject at a time (the running one, else today's next), it
// shows its whole stop ladder, and it offers exactly one action.
export function DriverDashboardScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const [fuelOpen, setFuelOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const fuel = useMyTruckFuel(user?.assigned_truck?.plate);
  const lastFill = fuel.data?.logs?.[0];
  // Only once the history has actually LOADED: an amber nudge on cold start
  // before data arrives would flash a false reminder at every launch.
  const fuelNudge =
    Boolean(user?.assigned_truck) && fuel.data !== undefined && fuelLogNudge(lastFill?.logged_at ?? null, new Date());
  const fuelDays = daysSinceFill(lastFill?.logged_at ?? null, new Date());

  const { data: trips, isLoading, isError, refetch, isRefetching } = useTrips();
  const startTrip = useUpdateTripStatus();
  const startInFlight = React.useRef(false);

  // `trips` is the dependency; `new Date()` is read once per render on purpose —
  // the day shape only has to be right at paint time, and a ticking clock here
  // would re-render Home every second for a countdown the card shows in minutes.
  const day = useMemo(() => buildDriverDay(trips, new Date()), [trips]);

  const openDetails = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "TripDetails", params: { tripId } });
  const openActive = (tripId: string) =>
    navigation.navigate("TripsTab", { screen: "ActiveTrip", params: { tripId } });

  // Home's single action. Same reconcile as Trip Details (lib/startTrip): a
  // committed-then-lost start must land the driver on the active screen, not on
  // an error he would answer by tapping Start a second time.
  const onStart = async (trip: Trip) => {
    if (startInFlight.current) return;
    startInFlight.current = true;
    setStartError(null);
    try {
      await startTrip.mutateAsync({ tripId: trip.id, action: "start" });
      openActive(trip.id);
    } catch (err) {
      if (shouldReconcileStart(apiErrorCode(err))) {
        const fresh = await refetch();
        const now = fresh.data?.find((tr) => tr.id === trip.id);
        if (now?.status === "in_progress") {
          openActive(trip.id);
          return;
        }
      }
      setStartError(apiErrorMessage(err));
    } finally {
      startInFlight.current = false;
    }
  };

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  return (
    <>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={{ paddingBottom: 28 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        <HomeHeader day={day} paddingTop={insets.top + 12} plate={user?.assigned_truck?.plate ?? null} name={user?.name ?? ""} />

        <View style={styles.section}>
          {day.state === "finished" ? <DayFinished day={day} /> : null}
          {day.state === "no_trips" ? <NoTrips /> : null}

          {day.primary ? (
            <PrimaryTripCard
              trip={day.primary}
              running={day.state === "running"}
              label={
                day.state === "running"
                  ? t("driver.activeTrip")
                  : day.state === "between"
                    ? t("driver.nextTripLabel")
                    : t("driver.firstTripLabel")
              }
              onPrimary={() => (day.state === "running" ? openActive(day.primary!.id) : onStart(day.primary!))}
              onOpen={() => (day.state === "running" ? openActive(day.primary!.id) : openDetails(day.primary!.id))}
              busy={startTrip.isPending}
            />
          ) : null}

          {startError ? <Text style={styles.error}>{startError}</Text> : null}

          <FuelBand
            plate={user?.assigned_truck?.plate ?? null}
            nudge={fuelNudge}
            days={fuelDays}
            lastFill={lastFill ?? null}
            onPress={() => setFuelOpen(true)}
          />

          {day.receipts.map((tr) => (
            <Receipt key={tr.id} trip={tr} onPress={() => openDetails(tr.id)} />
          ))}

          {day.upcoming.map((tr) => (
            <UpcomingRow key={tr.id} trip={tr} onPress={() => openDetails(tr.id)} />
          ))}

          {day.nextLater ? <NextLater trip={day.nextLater} onPress={() => openDetails(day.nextLater!.id)} /> : null}
        </View>
      </ScrollView>

      <LogFuelModal
        visible={fuelOpen}
        onClose={() => setFuelOpen(false)}
        truckPlate={user?.assigned_truck?.plate ?? null}
        truckLabel={user?.assigned_truck ? `${user.assigned_truck.plate} · ${user.assigned_truck.type}` : null}
      />
    </>
  );
}

// ── Header ────────────────────────────────────────────────────────────────
// Greeting, the day in one line, the plate the driver is on, and a band that
// states what is happening right now. The band is the part he reads first.
function HomeHeader({
  day,
  paddingTop,
  plate,
  name,
}: {
  day: DriverDay;
  paddingTop: number;
  plate: string | null;
  name: string;
}) {
  const { t } = useTranslation();

  const summary =
    day.state === "no_trips"
      ? formatDate(new Date())
      : `${formatDate(new Date())} · ${t("driver.tripCount", { n: day.tripCount })}, ${t("driver.stopCount", { n: day.stopCount })}`;

  const band = (() => {
    switch (day.state) {
      case "running": {
        const p = stopProgress(day.primary!);
        return {
          icon: "navigate" as const,
          tint: colors.yellow,
          text: t("driver.bandRunning", {
            n: currentStopNumber(day.primary!),
            total: p.total,
            delivered: p.delivered,
          }),
        };
      }
      case "before":
        return {
          icon: "sunny-outline" as const,
          tint: colors.yellow,
          text: t("driver.bandBefore", { time: formatTime(day.primary!.pickup_datetime) }),
        };
      case "between":
        return {
          icon: "cafe-outline" as const,
          tint: colors.yellow,
          text: t("driver.bandBetween", { time: formatTime(day.primary!.pickup_datetime) }),
        };
      case "finished":
        return { icon: "checkmark-circle" as const, tint: colors.yellow, text: t("driver.bandFinished") };
      case "no_trips":
        return { icon: "calendar-outline" as const, tint: colors.yellow, text: t("driver.bandNoTrips") };
    }
  })();

  return (
    <View style={[styles.header, { paddingTop }]}>
      <View style={styles.centerCol}>
        <View style={styles.headerTop}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {/* Full name, not the first word — Mr. Teh 16 Jul: "Need show the
                driver full name in driver page". Which is exactly why this
                wraps to two lines at 20px instead of the design's single 24px
                line: beside the plate chip, even "Ahmad Faizal" truncated to
                "Hi, Ahmad Faizal …", and real names here run far longer. */}
            {/* The size steps down as the name grows (lib/greetingName) —
                the full name is REQUIRED here, so shrinking is the only lever
                that keeps every character. numberOfLines={2} still catches the
                extreme tail. */}
            <Text style={[styles.greeting, { fontSize: greetingFontSize(name, 20) }]} numberOfLines={2}>
              {t("driver.greeting", { name })} 👋
            </Text>
            <Text style={styles.headerSub} numberOfLines={1}>{summary}</Text>
          </View>
          {plate ? (
            <View style={styles.plateChip}>
              <Ionicons name="car-outline" size={15} color={colors.white} />
              <Text style={styles.plateText}>{plate}</Text>
            </View>
          ) : null}
        </View>
        <View style={styles.band}>
          <Ionicons name={band.icon} size={17} color={band.tint} />
          <Text style={styles.bandText} numberOfLines={2}>{band.text}</Text>
        </View>
      </View>
    </View>
  );
}

// ── The one trip that matters ─────────────────────────────────────────────
function PrimaryTripCard({
  trip,
  running,
  label,
  onPrimary,
  onOpen,
  busy,
}: {
  trip: Trip;
  running: boolean;
  label: string;
  onPrimary: () => void;
  onOpen: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const progress = stopProgress(trip);
  const relative = relativeStart(trip.pickup_datetime);
  const left = progress.total - progress.delivered;

  return (
    <View style={styles.primaryCard}>
      <TouchableOpacity activeOpacity={0.85} onPress={onOpen} accessibilityRole="button">
        <View style={styles.primaryTop}>
          <View style={[styles.labelPill, running && styles.labelPillRunning]}>
            <Text style={[styles.labelPillText, running && styles.labelPillTextRunning]}>{label}</Text>
          </View>
          <Text style={styles.primaryTicket}>{trip.ticket_number}</Text>
        </View>

        <View style={styles.primaryHead}>
          <Text style={styles.primaryHeadline}>
            {running
              ? t("driver.stopOfTotal", { n: currentStopNumber(trip), total: progress.total })
              : formatTime(trip.pickup_datetime)}
          </Text>
          <Text style={styles.primaryHeadSub} numberOfLines={2}>
            {running
              ? t("driver.stopsLeft", { n: left })
              : [
                  relative,
                  t("driver.stopCount", { n: progress.total }),
                  t("driver.palletCount", { n: totalPallets(trip) }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </Text>
        </View>

        <TripStopLadder trip={trip} running={running} />

        {/* The booking's sequence is REFERENCE ONLY — Mr. Teh, 28 Jul 2026:
            "he can choose his own stop … driver no need follow route order". */}
        <Text style={styles.orderHint}>{t("trip.stopOrderHint")}</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.primaryAction, busy && { opacity: 0.6 }]}
        onPress={onPrimary}
        disabled={busy}
        activeOpacity={0.85}
        accessibilityRole="button"
      >
        <Ionicons name={running ? "navigate" : "play"} size={22} color={colors.white} />
        <Text style={styles.primaryActionText}>
          {running ? t("driver.continueTrip") : t("driver.startThisTrip")}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Fuel ──────────────────────────────────────────────────────────────────
// Amber is the owner-approved exception to the orange rule: it is a reminder,
// not an offline state, and it never blocks anything. The hue is unchanged; it
// moved from a hardcoded #d97706 (3.19:1) to `colors.amberText` (5.02:1) on
// 4 Aug 2026, because this band is read through a windscreen in daylight.
function FuelBand({
  plate,
  nudge,
  days,
  lastFill,
  onPress,
}: {
  plate: string | null;
  nudge: boolean;
  days: number | null;
  lastFill: { logged_at: string; liters: number } | null;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const sub = !plate
    ? t("fuel.noTruck")
    : nudge && days !== null
      ? t("fuel.staleNudge", { count: days })
      : lastFill
        ? t("fuel.lastFillShort", { when: formatDate(lastFill.logged_at), litres: lastFill.liters })
        : t("fuel.neverLogged");

  return (
    <TouchableOpacity
      style={[styles.fuelBand, nudge && styles.fuelBandNudge]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
    >
      <View style={[styles.fuelIcon, nudge && styles.fuelIconNudge]}>
        <MaterialCommunityIcons name="gas-station" size={23} color={nudge ? colors.amberText : colors.blue} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {/* Two lines, because one truncates the PLATE — the only part that
            identifies which truck this is about. "Rekod minyak untuk PND 1888"
            (ms) is 6 chars longer than the English and lost its plate to an
            ellipsis: "Rekod minyak untuk P…". English still fits on one line,
            so this only changes the taller languages. */}
        <Text style={styles.fuelTitle} numberOfLines={2}>
          {plate ? t("driver.logFuelFor", { plate }) : t("profile.logFuel")}
        </Text>
        {/* Same reason as the title: the Malay nudge
            ("belum ada isian direkodkan — log minyak?") lost its call to action
            to the ellipsis, leaving a statement with no prompt. */}
        <Text style={[styles.fuelSub, nudge && styles.fuelSubNudge]} numberOfLines={2}>
          {sub}
        </Text>
      </View>
      <View style={[styles.fuelPill, nudge && styles.fuelPillNudge]}>
        <Text style={styles.fuelPillText}>{t("driver.log")}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── After the run ─────────────────────────────────────────────────────────
// A finished trip collapses to a receipt: what it was, when it ended, and —
// while the office still has it — a GREY chip. No amount. Grey, not orange
// (offline only) and not green (green means paid).
function Receipt({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const { t } = useTranslation();
  const stops = stopsOf(trip);
  const finished = stops
    .map((s) => s.delivered_at)
    .filter((d): d is string => Boolean(d))
    .sort()
    .pop();

  return (
    <TouchableOpacity style={styles.receipt} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.receiptIcon}>
        <Ionicons name="checkmark-circle" size={20} color="#2E7D32" />
      </View>
      {/* The chip sits on the SECOND line, not beside the title: sharing the
          row cost the ticket ~150px and truncated it to "TKT-20260729-02…" —
          the one string on this card the driver would quote to the office. */}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.receiptTitle} numberOfLines={1}>
          {t("driver.receiptDelivered", { ticket: trip.ticket_number })}
        </Text>
        <View style={styles.receiptMetaRow}>
          <Text style={styles.receiptSub} numberOfLines={1}>
            {[
              t("driver.stopCount", { n: stops.length }),
              finished ? t("driver.finishedAt", { time: formatTime(finished) }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {trip.status === "pending_approval" ? (
            <View style={styles.awaitChip}>
              <Text style={styles.awaitChipText}>{t("trip.awaitingApproval")}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function DayFinished({ day }: { day: DriverDay }) {
  const { t } = useTranslation();
  return (
    <View style={styles.doneCard}>
      <Ionicons name="checkmark-circle" size={34} color="#2E7D32" />
      <Text style={styles.doneTitle}>{t("driver.allStopsDelivered", { n: day.deliveredStops })}</Text>
      <Text style={styles.doneBody}>{t("driver.runFinished")}</Text>
    </View>
  );
}

function NoTrips() {
  const { t } = useTranslation();
  return (
    <View style={styles.doneCard}>
      <Ionicons name="cafe-outline" size={32} color={colors.textFaint} />
      <Text style={styles.doneTitle}>{t("driver.noTripsToday")}</Text>
      <Text style={styles.doneBody}>{t("driver.noTripsBody")}</Text>
    </View>
  );
}

function UpcomingRow({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const { t } = useTranslation();
  const stops = stopsOf(trip);
  return (
    <TouchableOpacity style={styles.upcoming} onPress={onPress} activeOpacity={0.85}>
      <View style={styles.upcomingTime}>
        <Text style={styles.upcomingHour}>{formatTime(trip.pickup_datetime)}</Text>
        <Text style={styles.upcomingZone}>{stops[0]?.consignee?.zone_code ?? ""}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.upcomingName} numberOfLines={1}>
          {stops[0]?.consignee?.company_name ?? "—"}
        </Text>
        <Text style={styles.upcomingMeta} numberOfLines={1}>
          {trip.ticket_number} · {t("driver.stopCount", { n: stops.length })}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={colors.blue} />
    </TouchableOpacity>
  );
}

// Nothing today, but something IS coming — "no trips" alone reads as "no work
// this week" to a driver who was simply not rostered until tomorrow.
function NextLater({ trip, onPress }: { trip: Trip; onPress: () => void }) {
  const { t } = useTranslation();
  const stops = stopsOf(trip);
  return (
    <View style={styles.nextLater}>
      <Text style={styles.nextLaterLabel}>{t("driver.nextAssignedTrip")}</Text>
      <TouchableOpacity style={styles.nextLaterRow} onPress={onPress} activeOpacity={0.85}>
        <Text style={styles.nextLaterText} numberOfLines={1}>
          {formatDate(trip.pickup_datetime)} · {formatTime(trip.pickup_datetime)} ·{" "}
          {t("driver.stopCount", { n: stops.length })}
        </Text>
        <Ionicons name="chevron-forward" size={18} color={colors.blue} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  centerCol: { width: "100%", maxWidth: layout.content, alignSelf: "center" },
  section: { paddingHorizontal: 16, paddingTop: 16, gap: 12, width: "100%", maxWidth: layout.content, alignSelf: "center" },

  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 18 },
  headerTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  greeting: { color: colors.white, fontSize: 20, fontWeight: "800", lineHeight: 25 },
  headerSub: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginTop: 2 },
  plateChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  plateText: { color: colors.white, fontSize: 12, fontWeight: "700" },
  band: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    marginTop: 14,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  bandText: { flex: 1, color: colors.white, fontSize: 13, fontWeight: "700" },

  primaryCard: { backgroundColor: colors.white, borderRadius: radius.xl, padding: 15, ...shadow.floating },
  primaryTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  labelPill: { backgroundColor: colors.yellow, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  labelPillRunning: { backgroundColor: colors.blue },
  // Uppercased here, not in the strings: `driver.activeTrip` is shared with
  // other screens as "Active Trip", and next to a hard-coded "FIRST TRIP" the
  // pill read in two different cases.
  labelPillText: { fontSize: 12, fontWeight: "900", color: colors.navy, letterSpacing: 0.5, textTransform: "uppercase" },
  labelPillTextRunning: { color: colors.white },
  primaryTicket: { fontSize: 12, color: colors.textFaint, flexShrink: 1 },
  primaryHead: { flexDirection: "row", alignItems: "baseline", gap: 10, marginTop: 12 },
  primaryHeadline: { fontSize: 26, fontWeight: "900", color: colors.navy },
  primaryHeadSub: { flex: 1, fontSize: 13, fontWeight: "700", color: colors.grey },
  orderHint: { fontSize: 12, color: colors.textMuted, marginTop: 8, lineHeight: 16 },
  primaryAction: {
    minHeight: 58,
    marginTop: 10,
    borderRadius: radius.lg,
    backgroundColor: colors.blue,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryActionText: { color: colors.white, fontSize: 18, fontWeight: "800" },

  fuelBand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: 12,
    paddingHorizontal: 14,
    ...shadow.card,
  },
  fuelBandNudge: { borderWidth: 1.5, borderColor: colors.amberText },
  fuelIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  fuelIconNudge: { backgroundColor: colors.tintOrange },
  fuelTitle: { fontSize: 15, fontWeight: "800", color: colors.navy },
  fuelSub: { fontSize: 13, color: colors.textMuted, marginTop: 1 },
  fuelSubNudge: { color: colors.amberText, fontWeight: "700" },
  fuelPill: { minHeight: 44, paddingHorizontal: 16, borderRadius: radius.pill, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  // A FILL under the white "Log" label — 3.19:1 at #d97706, 5.02:1 here.
  fuelPillNudge: { backgroundColor: colors.amberText },
  fuelPillText: { fontSize: 14, fontWeight: "800", color: colors.white },

  receipt: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  receiptIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.tintGreen, alignItems: "center", justifyContent: "center" },
  receiptTitle: { fontSize: 14, fontWeight: "800", color: colors.navy },
  receiptMetaRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" },
  receiptSub: { fontSize: 12, color: colors.textMuted },
  awaitChip: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  awaitChipText: { fontSize: 12, fontWeight: "700", color: colors.textMuted },

  doneCard: { backgroundColor: colors.white, borderRadius: radius.lg, padding: 22, alignItems: "center", ...shadow.card },
  doneTitle: { fontSize: 16, fontWeight: "800", color: colors.navy, marginTop: 10, textAlign: "center" },
  doneBody: { fontSize: 14, color: colors.textMuted, marginTop: 6, textAlign: "center", lineHeight: 19 },

  upcoming: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  upcomingTime: { width: 66 },
  upcomingHour: { fontSize: 14, fontWeight: "800", color: colors.navy },
  upcomingZone: { fontSize: 12, color: colors.textMuted },
  upcomingName: { fontSize: 14, fontWeight: "800", color: colors.navy },
  upcomingMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },

  nextLater: { backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, padding: 14 },
  nextLaterLabel: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.5 },
  nextLaterRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, minHeight: 44 },
  nextLaterText: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.navy },

  error: { color: colors.red, fontSize: 14, fontWeight: "600" },
});
