// FLEET — mobile-only tab (bottom-bar shell, 14 Jul 2026): Drivers and
// Trucks combined under one thumb-reachable tab with a segment toggle at the
// top. Each segment renders the existing screen unchanged — this is
// navigation restructuring, not a feature change. Wide keeps the separate
// drawer pages (PC untouched).
import React, { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useDrivers, useTrucks } from "../hooks/queries";
import { colors } from "../theme";
import { SegmentedFilter } from "../components/ui";
import { DriversScreen } from "./DriversScreen";
import { TrucksScreen } from "./TrucksScreen";

type Segment = "drivers" | "trucks";

export function FleetScreen() {
  const { t } = useTranslation();
  const [segment, setSegment] = useState<Segment>("drivers");
  // Counts only — both screens already use these cached queries internally.
  const drivers = useDrivers();
  const trucks = useTrucks();

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
      {segment === "drivers" ? <DriversScreen /> : <TrucksScreen />}
    </View>
  );
}
