// USER MANAGEMENT (Part B/C) — the single parent screen that consolidates the
// old top-level "Approvals" queue with a new "All Users" directory under one
// segment toggle (same pattern as FleetScreen). Approvals is the FIRST tab so
// existing behaviour/muscle-memory is preserved, just re-homed.
//
// PERFORMANCE joined as a THIRD segment (owner, 15 Aug 2026), off the admin
// home grid. It sits here because the question it answers — "how is this driver
// doing" — is a question about a person, and the people are already on this
// screen; it was never a top-level destination. `AdminPerformance` remains a
// registered route in both shells, so every existing link still resolves.
import React, { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { usePendingUsers } from "../hooks/queries";
import { colors } from "../theme";
import { SegmentedFilter } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { ApprovalsScreen } from "./ApprovalsScreen";
import { AllUsersScreen } from "./AllUsersScreen";
import { PerformanceScreen } from "./PerformanceScreen";

type Tab = "approvals" | "all" | "performance";

export function UserManagementScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [tab, setTab] = useState<Tab>("approvals");
  // Count only — ApprovalsScreen owns the same cached query internally.
  const pending = usePendingUsers();

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={mode === "wide" ? { paddingHorizontal: 28, paddingTop: 20 } : { paddingHorizontal: 14, paddingTop: 12 }}>
        <SegmentedFilter<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "approvals", label: t("admin.users.tabApprovals"), count: pending.data?.length },
            { value: "all", label: t("admin.users.tabAll") },
            { value: "performance", label: t("admin.users.tabPerformance") },
          ]}
        />
      </View>
      {tab === "approvals" ? <ApprovalsScreen /> : tab === "all" ? <AllUsersScreen /> : <PerformanceScreen />}
    </View>
  );
}
