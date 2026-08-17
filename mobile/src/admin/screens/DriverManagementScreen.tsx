// DRIVER MANAGEMENT — the driver board and the per-driver Performance view
// under one segment toggle (same pattern as FleetScreen and User Management).
//
// Performance MOVED HERE from User Management (owner, 17 Aug 2026). It is a
// PER-DRIVER metric and this is the driver surface; User Management covers all
// three roles, so a driver-only view sitting there was the odd one out. The
// conditions are unchanged from the earlier move: `AdminPerformance` stays a
// registered route in both shells so every existing link still resolves
// (DashboardWide's on-time KPI card, the DriversScreen row), it stays off the
// admin home grid, and it does NOT go back into the sidebar — one screen with
// two doors in the same navigation is the clutter both moves set out to remove.
//
// ⚠ WIDE SHELL ONLY. On a phone the driver board is reached through the FLEET
// tab, which already carries its own segment row (Drivers / Trucks) — wrapping
// this around it there would stack THREE control rows above the list (fleet
// segment, driver segment, then DriversScreen's own status filter). The phone
// gets Performance as a third segment on that existing row instead, which is
// the same information architecture with one row instead of three.
import React, { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { useDrivers } from "../hooks/queries";
import { colors } from "../theme";
import { SegmentedFilter } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { DriversScreen } from "./DriversScreen";
import { PerformanceScreen } from "./PerformanceScreen";

type Tab = "drivers" | "performance";

export function DriverManagementScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [tab, setTab] = useState<Tab>("drivers");
  // Count only — DriversScreen owns the same cached query internally.
  const drivers = useDrivers();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View
        style={
          mode === "wide"
            ? { paddingHorizontal: 28, paddingTop: 20 }
            : { paddingHorizontal: 14, paddingTop: 12 }
        }
      >
        <SegmentedFilter<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "drivers", label: t("admin.fleet.drivers"), count: drivers.data?.length },
            { value: "performance", label: t("admin.fleet.performance") },
          ]}
        />
      </View>
      {tab === "drivers" ? <DriversScreen /> : <PerformanceScreen />}
    </View>
  );
}
