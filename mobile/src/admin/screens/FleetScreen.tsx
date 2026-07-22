// FLEET — mobile-only tab (bottom-bar shell, 14 Jul 2026): Drivers and
// Trucks combined under one thumb-reachable tab with a segment toggle at the
// top. Each segment renders the existing screen unchanged — this is
// navigation restructuring, not a feature change. Wide keeps the separate
// drawer pages (PC untouched).
//
// The Trucks' Fleet/Fuel sub-toggle is lifted up here and injected into the
// blue header (via setOptions) so the content band count drops — it shows only
// while the Trucks segment is active.
import React, { useLayoutEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import { useDrivers, useTrucks } from "../hooks/queries";
import { colors, radius } from "../theme";
import { SegmentedFilter } from "../components/ui";
import { AdminMobileHeader } from "../components/MobileHeader";
import { DriversScreen } from "./DriversScreen";
import { TrucksScreen, type TruckTab } from "./TrucksScreen";

type Segment = "drivers" | "trucks";

// Compact Fleet/Fuel toggle styled for the blue header (pills read on blue).
function FleetFuelToggle({ value, onChange, t }: { value: TruckTab; onChange: (v: TruckTab) => void; t: (k: string) => string }) {
  const opts: { value: TruckTab; label: string }[] = [
    { value: "fleet", label: t("admin.trucks.tabFleet") },
    { value: "fuel", label: t("admin.trucks.tabFuel") },
  ];
  return (
    <View style={{ flexDirection: "row", backgroundColor: "rgba(255,255,255,0.15)", borderRadius: radius.pill, padding: 2 }}>
      {opts.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{ paddingVertical: 5, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: active ? "#fff" : "transparent" }}
          >
            <Text style={{ fontSize: 13, fontWeight: "700", color: active ? colors.blue : "rgba(255,255,255,0.9)" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function FleetScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<any>();
  const [segment, setSegment] = useState<Segment>("drivers");
  const [truckTab, setTruckTab] = useState<TruckTab>("fleet");
  // Counts only — both screens already use these cached queries internally.
  const drivers = useDrivers();
  const trucks = useTrucks();

  // Inject the Fleet/Fuel toggle into the tab's blue header, only on Trucks.
  useLayoutEffect(() => {
    navigation.setOptions({
      header: () => (
        <AdminMobileHeader
          title={t("admin.titles.fleet")}
          right={segment === "trucks" ? <FleetFuelToggle value={truckTab} onChange={setTruckTab} t={t} /> : undefined}
        />
      ),
    });
  }, [navigation, segment, truckTab, t]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
        <SegmentedFilter<Segment>
          value={segment}
          onChange={setSegment}
          options={[
            { value: "drivers", label: t("admin.fleet.drivers"), count: drivers.data?.length },
            { value: "trucks", label: t("admin.fleet.trucks"), count: trucks.data?.length },
          ]}
        />
      </View>
      {segment === "drivers" ? <DriversScreen /> : <TrucksScreen tab={truckTab} onTabChange={setTruckTab} />}
    </View>
  );
}
