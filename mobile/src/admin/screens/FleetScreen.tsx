// FLEET — mobile-only tab (bottom-bar shell, 14 Jul 2026): Drivers and
// Trucks combined under one thumb-reachable tab with a segment toggle at the
// top. Each segment renders the existing screen unchanged — this is
// navigation restructuring, not a feature change. Wide keeps the separate
// drawer pages (PC untouched).
//
// The old Fleet/Fuel header toggle is gone (27 Jul 2026): the Fuel tab moved
// to the top-level Sustainability screen, so this tab is fleet management
// only and uses the shell's plain blue header.
import React, { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useDrivers, useTrucks } from "../hooks/queries";
import { colors } from "../theme";
import { SegmentedFilter } from "../components/ui";
import { DriversScreen } from "./DriversScreen";
import { PerformanceScreen } from "./PerformanceScreen";
import { TrucksScreen } from "./TrucksScreen";

// PERFORMANCE rides on THIS row on the phone (owner, 17 Aug 2026). The wide
// shell puts it inside Driver Management (`DriverManagementScreen`), but on a
// phone the driver board is already inside this tab's segment — nesting a
// second toggle would stack three control rows above the list, so it sits next
// to Drivers here instead. Same place in the information architecture, one row
// instead of three. It is NOT on the home grid and NOT in the sidebar.
type Segment = "drivers" | "performance" | "trucks";

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
            { value: "performance", label: t("admin.fleet.performance") },
            { value: "trucks", label: t("admin.fleet.trucks"), count: trucks.data?.length },
          ]}
        />
      </View>
      {segment === "drivers" ? <DriversScreen /> : segment === "performance" ? <PerformanceScreen /> : <TrucksScreen />}
    </View>
  );
}
