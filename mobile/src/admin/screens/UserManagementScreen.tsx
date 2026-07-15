// USER MANAGEMENT (Part B/C) — the single parent screen that consolidates the
// old top-level "Approvals" queue with a new "All Users" directory under one
// segment toggle (same pattern as FleetScreen). Approvals is the FIRST tab so
// existing behaviour/muscle-memory is preserved, just re-homed.
import React, { useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { usePendingUsers } from "../hooks/queries";
import { colors } from "../theme";
import { SegmentedFilter } from "../components/ui";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { ApprovalsScreen } from "./ApprovalsScreen";
import { AllUsersScreen } from "./AllUsersScreen";

type Tab = "approvals" | "all";

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
          ]}
        />
      </View>
      {tab === "approvals" ? <ApprovalsScreen /> : <AllUsersScreen />}
    </View>
  );
}
