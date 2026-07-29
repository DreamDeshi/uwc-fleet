import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { formatTime } from "../lib/format";
import { stopsOf } from "../lib/driverHome";
import { requiresCustomsDoc } from "../lib/activeTripStage";
import { totalPallets, ORIGIN_LABEL } from "../lib/trip";
import type { Trip, TripStop } from "../types";
import { isStopSettled } from "../lib/stopSettled";

// The stop ladder on the driver's Home card: the pickup, then every drop, on a
// single rail. Before the run it reads as a plan; during the run the same
// component becomes the progress record — delivered stops go grey behind a
// green tick and the current stop wears a NOW chip.
//
// The rail's colour carries the progress: grey behind the driver, yellow ahead.
//
// PER-STOP CARGO IS NOT SHOWN, on purpose. `CargoDetail` hangs off the TRIP,
// not the stop (api/prisma/schema.prisma — the model even notes cargo *may*
// become per-stop later), so a "2 plt" against one drop would be invented. The
// trip total is real, so it rides on the pickup row where it is true.

const RAIL_W = 16;

export function TripStopLadder({ trip, running }: { trip: Trip; running: boolean }) {
  const { t } = useTranslation();
  const stops = stopsOf(trip);
  if (stops.length === 0) return null;

  // The rail's "you are here" marker follows the first OUTSTANDING stop —
  // a settled paid-undelivered stop (R3 Q11(a)) is finished work, not the
  // driver's next job. See lib/stopSettled.
  const currentIdx = stops.findIndex((s) => !isStopSettled(s) && s.status !== "delivered");
  const pallets = totalPallets(trip);

  return (
    <View style={styles.wrap}>
      <Row
        rail={<Marker kind={running ? "done" : "pickup"} />}
        railAfter={running ? "past" : "ahead"}
        name={ORIGIN_LABEL}
        nameStyle={running ? styles.namePast : styles.name}
        meta={
          running
            ? t("driver.ladderLoaded", { n: pallets })
            : t("driver.ladderPickup", { n: pallets })
        }
        last={false}
      />
      {stops.map((s, i) => {
        const delivered = s.status === "delivered";
        const isNow = running && i === currentIdx;
        const last = i === stops.length - 1;
        return (
          <Row
            key={s.id}
            rail={
              <Marker kind={delivered ? "done" : isNow ? "now" : last ? "final" : "next"} />
            }
            railBefore={delivered || (running && i <= currentIdx) ? "past" : "ahead"}
            railAfter={delivered ? "past" : "ahead"}
            name={s.consignee?.company_name ?? t("trip.stop", { n: i + 1 })}
            nameStyle={delivered ? styles.namePast : isNow ? styles.nameNow : styles.name}
            meta={
              delivered
                ? s.delivered_at
                  ? t("driver.ladderDelivered", { time: formatTime(s.delivered_at) })
                  : t("trip.markDelivered")
                : townOf(s)
            }
            k2={requiresCustomsDoc(s.consignee?.zone_code, s.consignee?.area)}
            highlight={isNow}
            nowLabel={isNow ? t("driver.ladderNow") : undefined}
            last={last}
          />
        );
      })}
    </View>
  );
}

function townOf(s: TripStop): string {
  return s.consignee?.area || s.consignee?.zone?.name || s.consignee?.zone_code || "";
}

type RailTone = "past" | "ahead";

function Row({
  rail,
  railBefore,
  railAfter,
  name,
  nameStyle,
  meta,
  k2,
  highlight,
  nowLabel,
  last,
}: {
  rail: React.ReactNode;
  railBefore?: RailTone;
  railAfter?: RailTone;
  name: string;
  nameStyle: object;
  meta: string;
  k2?: boolean;
  highlight?: boolean;
  nowLabel?: string;
  last: boolean;
}) {
  const tone = (r?: RailTone) => (r === "past" ? colors.border : colors.yellow);
  return (
    <View style={styles.row}>
      <View style={styles.rail}>
        {railBefore ? <View style={[styles.connectorStub, { backgroundColor: tone(railBefore) }]} /> : null}
        {rail}
        {!last ? <View style={[styles.connector, { backgroundColor: tone(railAfter) }]} /> : null}
      </View>
      {highlight ? (
        <View style={styles.nowBody}>
          <View style={styles.nowTop}>
            <Text style={[styles.name, nameStyle]} numberOfLines={1}>
              {name}
            </Text>
            {k2 ? <K2Badge /> : null}
            {nowLabel ? <Text style={styles.nowTag}>{nowLabel}</Text> : null}
          </View>
          {meta ? <Text style={styles.nowMeta} numberOfLines={1}>{meta}</Text> : null}
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={[styles.name, nameStyle]} numberOfLines={1}>
            {name}
          </Text>
          {k2 ? <K2Badge /> : null}
          {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
        </View>
      )}
    </View>
  );
}

// Borang K2 is required before this drop can be marked delivered, so the driver
// learns it on Home rather than at the tailgate. Amber tint (pending
// semantics), never orange — orange stays reserved for offline/queued.
function K2Badge() {
  return (
    <View style={styles.k2}>
      <Text style={styles.k2Text}>K2</Text>
    </View>
  );
}

function Marker({ kind }: { kind: "pickup" | "done" | "now" | "next" | "final" }) {
  if (kind === "done") {
    return <Ionicons name="checkmark-circle" size={15} color="#2E7D32" />;
  }
  if (kind === "final") {
    return <Ionicons name="location" size={18} color={colors.red} />;
  }
  if (kind === "pickup") {
    return <View style={styles.dotFilled} />;
  }
  return <View style={kind === "now" ? styles.dotNow : styles.dotOpen} />;
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  row: { flexDirection: "row", gap: 12, minHeight: 32 },
  rail: { width: RAIL_W, alignItems: "center" },
  connectorStub: { width: 2, height: 7 },
  connector: { width: 2, flex: 1, marginVertical: 2 },
  body: { flex: 1, flexDirection: "row", alignItems: "center", gap: 7, paddingBottom: 6 },
  name: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.navy },
  namePast: { color: colors.textFaint },
  nameNow: { fontWeight: "800" },
  // textMuted, not textFaint: the town is the line a driver actually reads to
  // place the drop, and textFaint on white is 2.5:1.
  meta: { fontSize: 12, fontWeight: "600", color: colors.textMuted },

  nowBody: { flex: 1, backgroundColor: colors.tintBlue, borderRadius: radius.sm, paddingVertical: 6, paddingHorizontal: 9, marginBottom: 6 },
  nowTop: { flexDirection: "row", alignItems: "center", gap: 7 },
  nowTag: { fontSize: 12, fontWeight: "800", color: colors.blue },
  nowMeta: { fontSize: 12, fontWeight: "600", color: colors.grey, marginTop: 1 },

  dotFilled: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.blue, marginTop: 4 },
  dotOpen: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.blue, backgroundColor: colors.white },
  dotNow: { width: 12, height: 12, borderRadius: 6, borderWidth: 3, borderColor: colors.blue, backgroundColor: colors.white },

  k2: { backgroundColor: colors.tintOrange, borderWidth: 1, borderColor: "#f0c98a", borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  k2Text: { fontSize: 12, fontWeight: "800", color: "#8b5b00" },
});
