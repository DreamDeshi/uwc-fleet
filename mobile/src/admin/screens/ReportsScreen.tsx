// Reports & Analytics — RN port of admin/src/pages/ReportsPage.tsx (Phase 4,
// PC-first). MONEY RULES: all pay math and CSV generation come VERBATIM from
// the ported lib/payroll.ts + lib/csv.ts (never re-implemented here); the
// export gate (payrollBusy) and the false-"no trips" guards are preserved
// exactly — a CSV must never carry another month's rows under the selected
// month's name (audit 2026-07-05 #1/#2).
import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { LinearGradient } from "expo-linear-gradient";
import { useConsolidationSavings, useMonthly, usePayroll, useTrips } from "../hooks/queries";
import { colors, font, gradients, radius } from "../theme";
import { Button, Card, ErrorState, Loading, SectionTitle, TableCell, TableHeader, TableRow } from "../components/ui";
import { formatDateTime, formatMoney, formatNumber } from "../lib/format";
import { buildPayrollCsv, lastNMytMonthKeys, monthKeyLabel, payrollBusy } from "../lib/payroll";
import { CSV_BOM } from "../lib/csv";
import { shareCsv } from "../platform/csvShare";
import { IncentiveBarChart, RouteSplitDonut, PIE_COLORS } from "../platform/reportCharts";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { OptionsModal } from "../../components/OptionsModal";
import type { MonthlyRow, PayrollDriverRow } from "../types";

export function ReportsScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const monthly = useMonthly();
  // Feeds ONLY the route-type pie — one fetch, 5-min stale, recent-500 window.
  const trips = useTrips({}, { poll: false, limit: 500 });
  // Month-end payroll: any MYT month selectable (the clerk closes LAST month
  // in the first days of the next one).
  const monthOptions = useMemo(() => lastNMytMonthKeys(new Date(), 12), []);
  const [month, setMonth] = useState(monthOptions[0]);
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);
  const payroll = usePayroll(month);
  const consolidation = useConsolidationSavings();

  const routeSplit = useMemo(() => {
    const map = new Map<string, number>();
    for (const tr of trips.data ?? []) {
      map.set(tr.route_type.name, (map.get(tr.route_type.name) ?? 0) + 1);
    }
    return [...map.entries()].map(([name, value]) => ({ name, value }));
  }, [trips.data]);

  if (monthly.isLoading || payroll.isLoading) return <Loading />;
  if (monthly.isError) return <ErrorState message={t("admin.reports.reportsError")} onRetry={() => monthly.refetch()} />;
  // A payroll fetch error must NOT fall through to rows=[] — that renders as
  // "No completed trips" (a false claim about pay) with a live Export button.
  if (payroll.isError) return <ErrorState message={t("admin.reports.payrollError")} onRetry={() => payroll.refetch()} />;

  const wide = mode === "wide";
  const months = monthly.data ?? [];
  const payrollRows = payroll.data?.drivers ?? [];
  // Month-switch placeholder guard: dim + disable Export until settled.
  const payrollSettling = payrollBusy(payroll);

  const totalTrips = months.reduce((s, m) => s + m.trips, 0);
  const totalIncentive = months.reduce((s, m) => s + m.incentive, 0);
  const totalExternal = months.reduce((s, m) => s + m.external, 0);
  const avgTrip = (() => {
    const completed = months.reduce((s, m) => s + m.completed, 0);
    return completed ? totalIncentive / completed : 0;
  })();

  async function exportCsv() {
    // Belt-and-braces with the disabled button: never write a sheet while the
    // rows on screen may still be another month's placeholder data.
    if (payrollSettling) return;
    // buildPayrollCsv + CSV_BOM are the PORTED libs, verbatim — the export
    // must stay byte-identical to the old admin's.
    const csv = buildPayrollCsv(month, payrollRows, months);
    await shareCsv(`uwc-payroll-${month}.csv`, CSV_BOM + csv);
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 18 } : { padding: 14, gap: 18 }}
      refreshControl={<RefreshControl refreshing={monthly.isRefetching} onRefresh={() => monthly.refetch()} />}
    >
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button variant="primary" size="sm" onPress={exportCsv} disabled={payrollSettling}>
          {payrollSettling ? t("admin.reports.loadingPayroll") : t("admin.reports.exportCsv")}
        </Button>
      </View>

      {/* KPI cards */}
      <View style={{ flexDirection: wide ? "row" : "column", gap: 16 }}>
        <MiniKpi label={t("admin.reports.kpiTotalIncentive")} value={formatMoney(totalIncentive)} bg={colors.blueTint} fg={colors.blue} wide={wide} />
        <MiniKpi label={t("admin.reports.kpiAvgTrip")} value={formatMoney(avgTrip)} bg={colors.greenTint} fg={colors.green} wide={wide} />
        <MiniKpi label={t("admin.reports.kpiTotalTrips")} value={formatNumber(totalTrips)} bg={colors.yellowTint} fg={colors.amber} wide={wide} />
        <MiniKpi label={t("admin.reports.kpiExternal")} value={formatNumber(totalExternal)} bg={colors.orangeTint} fg={colors.orange} wide={wide} />
      </View>

      {/* Charts */}
      <View style={{ flexDirection: wide ? "row" : "column", gap: 16 }}>
        <View style={{ flex: wide ? 1.4 : undefined }}>
          <Card>
            <SectionTitle title={t("admin.reports.incentiveByMonth")} subtitle={t("admin.reports.last6")} />
            <IncentiveBarChart months={months} />
          </Card>
        </View>
        <View style={{ flex: wide ? 1 : undefined }}>
          <Card>
            <SectionTitle
              title={t("admin.reports.routeSplit")}
              subtitle={t("admin.reports.tripsCount", { count: routeSplit.reduce((s, r) => s + r.value, 0) })}
            />
            {routeSplit.length === 0 ? (
              <Text style={{ padding: 30, textAlign: "center", color: colors.textMuted, fontSize: font.md }}>
                {t("admin.reports.noTrips")}
              </Text>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                <RouteSplitDonut data={routeSplit} />
                <View style={{ flex: 1, gap: 6 }}>
                  {routeSplit.map((r, i) => (
                    <View key={r.name} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <Text numberOfLines={1} style={{ flex: 1, color: colors.textMuted, fontSize: font.sm }}>{r.name}</Text>
                      <Text style={{ fontWeight: "700", fontSize: font.sm, color: colors.text }}>{r.value}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </Card>
        </View>
      </View>

      {/* Sustainability — consolidation ("empty-mile") savings. Fewer-trips is
          exact; km/CO2 are estimates from average trip distance (labelled). */}
      {consolidation.data && consolidation.data.tripsSaved > 0 && (
        <Card>
          <SectionTitle title={t("admin.reports.consolidationTitle")} subtitle={t("admin.reports.consolidationSub")} />
          <View style={{ flexDirection: wide ? "row" : "column", gap: 16, marginTop: 8 }}>
            <MiniKpi label={t("admin.reports.tripsSaved")} value={formatNumber(consolidation.data.tripsSaved)} bg={colors.greenTint} fg={colors.green} wide={wide} />
            <MiniKpi label={t("admin.reports.co2Saved")} value={`${formatNumber(consolidation.data.estCo2eKgSaved)} kg`} bg={colors.greenTint} fg={colors.green} wide={wide} />
            <MiniKpi label={t("admin.reports.kmSaved")} value={`${formatNumber(consolidation.data.estKmSaved)} km`} bg={colors.greenTint} fg={colors.green} wide={wide} />
          </View>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 10 }}>{t("admin.reports.consolidationEstNote")}</Text>
        </Card>
      )}

      {/* Payroll table — the clerk's month-end sheet; a row expands to the
          per-trip lines its total is the sum of (dispute path). */}
      <Card pad={0}>
        <View
          style={{
            padding: 18,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {/* The click-a-driver explainer stays PC-only (mobile: lead with data). */}
          <SectionTitle title={t("admin.reports.payrollTitle")} subtitle={wide ? t("admin.reports.payrollSub") : undefined} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            {payrollSettling && (
              <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
                {t("admin.reports.loadingMonth", { month: monthKeyLabel(month) })}
              </Text>
            )}
            <Pressable
              onPress={() => setMonthPickerOpen(true)}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                height: 34,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: colors.border,
                paddingHorizontal: 8,
                backgroundColor: colors.card,
              }}
            >
              <Text style={{ fontSize: font.md, color: colors.text }}>{monthKeyLabel(month)}</Text>
              <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
            </Pressable>
          </View>
        </View>
        {/* Dimmed while settling: the rows below may still be the previous
            month's placeholder data. */}
        <View style={{ opacity: payrollSettling ? 0.45 : 1 }}>
          <TableHeader style={{ borderRadius: 0 }}>
            <TableCell flex={1.6} header>{t("admin.reports.colDriver")}</TableCell>
            <TableCell flex={1} header>{t("admin.reports.colEmpNo")}</TableCell>
            <TableCell flex={0.7} header>{t("admin.reports.colTrips")}</TableCell>
            <TableCell flex={1} header>{t("admin.reports.colTotal")}</TableCell>
          </TableHeader>
          {payrollRows.length === 0 ? (
            <Text style={{ padding: 20, textAlign: "center", color: colors.textMuted, fontSize: font.md }}>
              {/* Only claim "no trips" once the month has actually loaded. */}
              {payrollSettling
                ? t("admin.reports.loading")
                : t("admin.reports.noCompleted", { month: monthKeyLabel(month) })}
            </Text>
          ) : (
            payrollRows.map((d) => <PayrollRow key={d.driver_id} row={d} />)
          )}
        </View>
      </Card>

      {/* Monthly summary table */}
      <Card pad={0} style={{ overflow: "hidden" }}>
        <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <SectionTitle
            title={t("admin.reports.monthlyTitle")}
            subtitle={`${months[0]?.label ?? ""} – ${months[months.length - 1]?.label ?? ""}`}
          />
        </View>
        <TableHeader style={{ borderRadius: 0 }}>
          <TableCell flex={wide ? 1.2 : 1} header>{t("admin.reports.colMonth")}</TableCell>
          <TableCell flex={wide ? 0.8 : 0.6} header>{t("admin.reports.colTrips")}</TableCell>
          {/* Short header forms + a wider money column on phones — the full
              words and "RM 855.00" wrap mid-word otherwise. */}
          <TableCell flex={wide ? 0.9 : 0.7} header>{t(wide ? "admin.reports.colCompleted" : "admin.reports.colCompletedShort")}</TableCell>
          <TableCell flex={wide ? 1 : 1.3} header>{t(wide ? "admin.reports.colIncentive" : "admin.reports.colIncentiveShort")}</TableCell>
          <TableCell flex={wide ? 0.8 : 0.6} header>{t(wide ? "admin.reports.colExternal" : "admin.reports.colExternalShort")}</TableCell>
        </TableHeader>
        {months.map((m: MonthlyRow) => (
          <TableRow key={m.month}>
            <TableCell flex={wide ? 1.2 : 1} textStyle={{ fontWeight: "600" }}>{m.label}</TableCell>
            <TableCell flex={wide ? 0.8 : 0.6}>{m.trips}</TableCell>
            <TableCell flex={wide ? 0.9 : 0.7}>{m.completed}</TableCell>
            <TableCell flex={wide ? 1 : 1.3} textStyle={{ color: colors.green, fontWeight: "700" }}>{formatMoney(m.incentive)}</TableCell>
            <TableCell flex={wide ? 0.8 : 0.6}>{m.external}</TableCell>
          </TableRow>
        ))}
        {/* Dark summary footer — same gradient surface as the sidebar. */}
        <LinearGradient
          colors={gradients.sidebar}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={{ paddingVertical: 16, paddingHorizontal: 18, flexDirection: "row", justifyContent: "space-around" }}
        >
          <FooterStat label={t("admin.reports.footTotalTrips")} value={formatNumber(totalTrips)} />
          <FooterStat label={t("admin.reports.footTotalIncentive")} value={formatMoney(totalIncentive)} />
          <FooterStat label={t("admin.reports.footExternal")} value={formatNumber(totalExternal)} />
        </LinearGradient>
      </Card>

      <OptionsModal
        visible={monthPickerOpen}
        title={t("admin.reports.payrollTitle")}
        options={monthOptions.map((k) => ({ label: monthKeyLabel(k), value: k }))}
        selectedValue={month}
        onSelect={setMonth}
        onClose={() => setMonthPickerOpen(false)}
      />
    </ScrollView>
  );
}

// One payroll row, expandable to the per-trip lines the month total is the
// sum of — a pay dispute is settled by reading exactly these.
function PayrollRow({ row }: { row: PayrollDriverRow }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)}>
        <TableRow>
          <TableCell flex={1.6}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name={open ? "chevron-down" : "chevron-forward"} size={12} color={colors.textMuted} />
              <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>{row.name}</Text>
            </View>
          </TableCell>
          <TableCell flex={1}>{row.employee_number ?? "—"}</TableCell>
          <TableCell flex={0.7}>{row.trip_count}</TableCell>
          <TableCell flex={1} textStyle={{ color: colors.green, fontWeight: "700" }}>{formatMoney(row.total)}</TableCell>
        </TableRow>
      </Pressable>
      {open &&
        row.trips.map((tr) => (
          <View key={tr.id} style={{ backgroundColor: colors.panel }}>
            <TableRow>
              <TableCell flex={1.6}>
                <Text style={{ fontSize: font.sm, color: colors.text, paddingLeft: 20 }}>{tr.ticket_number}</Text>
              </TableCell>
              <TableCell flex={1.7} textStyle={{ fontSize: font.sm, color: colors.textMuted }}>
                {/* The pay-deciding delivery-confirm instant (MYT). */}
                {formatDateTime(tr.delivered_at ?? tr.pickup_datetime)}
              </TableCell>
              <TableCell flex={1} textStyle={{ fontSize: font.sm }}>{formatMoney(tr.incentive_earned)}</TableCell>
            </TableRow>
          </View>
        ))}
    </View>
  );
}

function MiniKpi({ label, value, bg, fg, wide }: { label: string; value: string; bg: string; fg: string; wide: boolean }) {
  return (
    <View
      style={{
        flex: wide ? 1 : undefined,
        backgroundColor: colors.card,
        borderRadius: radius.lg,
        padding: 18,
        borderWidth: 1,
        borderColor: colors.border,
        borderLeftWidth: 4,
        borderLeftColor: fg,
        shadowColor: "#000",
        shadowOpacity: 0.06,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 2 },
      }}
    >
      <Text style={{ fontSize: font.xs, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4, color: colors.textMuted }}>
        {label}
      </Text>
      <Text style={{ fontSize: 26, fontWeight: "800", color: fg, marginTop: 8 }}>{value}</Text>
      <View style={{ width: 28, height: 4, backgroundColor: bg, borderRadius: 2, marginTop: 8 }} />
    </View>
  );
}

function FooterStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ alignItems: "center" }}>
      <Text style={{ fontSize: font.xs, color: "rgba(255,255,255,0.55)", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</Text>
      <Text style={{ fontSize: 19, fontWeight: "800", color: colors.yellow, marginTop: 4 }}>{value}</Text>
    </View>
  );
}
