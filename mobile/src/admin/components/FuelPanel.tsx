// FR-CT5 — fuel cost tracking. RN port of the web admin's FuelPanel:
// this-month spend per truck, each row expandable to its fill-up logs, plus
// the admin "Log Fuel" form. Wide mirrors the web table; narrow is a
// functional stacked list (mobile polish comes in the dedicated pass).
import React, { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useFuelSummary, useLogFuel, useTruckFuel, useTrucks } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Button, Card, EmptyState, ErrorState, Input, Loading, Modal, TableCell, TableHeader, TableRow } from "../components/ui";
import { DateField } from "../platform/datePicker";
import { apiErrorMessage } from "../services/api";
import { formatDate, formatMoney, formatNumber } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { OptionsModal } from "../../components/OptionsModal";
import type { TruckFuelSummary } from "../types";

export function FuelPanel() {
  const { t } = useTranslation();
  const summary = useFuelSummary();
  const [logOpen, setLogOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const mode = useLayoutMode();

  const monthTotal = useMemo(
    () => (summary.data ?? []).reduce((s, r) => s + r.total_cost_rm, 0),
    [summary.data]
  );

  if (summary.isLoading) return <Loading />;
  if (summary.isError) return <ErrorState message={t("admin.trucks.fuelLoadError")} onRetry={() => summary.refetch()} />;

  const rows = summary.data ?? [];
  const wide = mode === "wide";

  return (
    <>
      <Card pad={0} style={{ overflow: "hidden" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border, flexWrap: "wrap" }}>
          <View style={{ flex: 1, minWidth: 180 }}>
            <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.text }}>{t("admin.trucks.fuelTitle")}</Text>
            <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
              {t("admin.trucks.fuelSub", { total: formatMoney(monthTotal), count: rows.length })}
            </Text>
          </View>
          <Button size="sm" onPress={() => setLogOpen(true)}>
            {t("admin.trucks.logFuel")}
          </Button>
        </View>

        {rows.length === 0 ? (
          <EmptyState message={t("admin.trucks.noFuel")} />
        ) : wide ? (
          <View>
            <TableHeader style={{ borderRadius: 0 }}>
              <TableCell flex={1.2} header>{t("admin.trucks.colTruck")}</TableCell>
              <TableCell flex={1} header>{t("admin.trucks.colType")}</TableCell>
              <TableCell flex={0.9} header textStyle={{ textAlign: "right" }}>{t("admin.trucks.litres")}</TableCell>
              <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.trucks.costRm")}</TableCell>
              <TableCell flex={0.9} header textStyle={{ textAlign: "right" }}>{t("admin.trucks.colCostKm")}</TableCell>
              <TableCell flex={0.8} header textStyle={{ textAlign: "right" }}>{""}</TableCell>
            </TableHeader>
            {rows.map((r) => (
              <FuelRowWide key={r.plate} row={r} expanded={expanded === r.plate} onToggle={() => setExpanded((p) => (p === r.plate ? null : r.plate))} />
            ))}
          </View>
        ) : (
          // Narrow (functional, pre-polish): stacked rows with tap-to-expand.
          <View>
            {rows.map((r, i) => (
              <View key={r.plate} style={{ borderBottomWidth: i === rows.length - 1 ? 0 : 1, borderBottomColor: colors.divider }}>
                <Pressable
                  onPress={() => setExpanded((p) => (p === r.plate ? null : r.plate))}
                  style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 16, backgroundColor: expanded === r.plate ? colors.blueTint : undefined }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.text }}>{r.plate}</Text>
                    <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
                      {formatNumber(r.total_litres)} L · {formatMoney(r.total_cost_rm)}
                      {r.cost_per_km != null ? ` · ${formatMoney(r.cost_per_km)}/km` : ""}
                    </Text>
                  </View>
                  <Ionicons name={expanded === r.plate ? "chevron-up" : "chevron-down"} size={16} color={colors.textFaint} />
                </Pressable>
                {expanded === r.plate && <ExpandedLogs plate={r.plate} />}
              </View>
            ))}
          </View>
        )}
      </Card>

      <LogFuelModal open={logOpen} onClose={() => setLogOpen(false)} />
    </>
  );
}

function FuelRowWide({ row, expanded, onToggle }: { row: TruckFuelSummary; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const right = { textAlign: "right" as const };
  return (
    <View>
      <Pressable onPress={onToggle} style={{ backgroundColor: expanded ? colors.blueTint : undefined }}>
        <TableRow>
          <TableCell flex={1.2}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Ionicons name={expanded ? "chevron-down" : "chevron-forward"} size={12} color={colors.textFaint} />
              <Text style={{ fontWeight: "800", letterSpacing: 0.3, fontSize: font.md, color: colors.text }}>{row.plate}</Text>
            </View>
          </TableCell>
          <TableCell flex={1} textStyle={{ color: colors.textMuted }}>{row.type}</TableCell>
          <TableCell flex={0.9} textStyle={right}>{`${formatNumber(row.total_litres)} L`}</TableCell>
          <TableCell flex={1} textStyle={right}>{formatMoney(row.total_cost_rm)}</TableCell>
          <TableCell flex={0.9} textStyle={right}>{row.cost_per_km != null ? formatMoney(row.cost_per_km) : "—"}</TableCell>
          <TableCell flex={0.8} textStyle={{ textAlign: "right", color: colors.textFaint, fontSize: font.sm }}>
            {t("admin.trucks.fills", { count: row.log_count })}
          </TableCell>
        </TableRow>
      </Pressable>
      {expanded && (
        <View style={{ backgroundColor: colors.panel }}>
          <ExpandedLogs plate={row.plate} />
        </View>
      )}
    </View>
  );
}

function ExpandedLogs({ plate }: { plate: string }) {
  const { t } = useTranslation();
  const fuel = useTruckFuel(plate);
  const mode = useLayoutMode();

  if (fuel.isLoading) return <Text style={{ padding: 16, fontSize: font.md, color: colors.textMuted }}>{t("admin.trucks.loadingLogs")}</Text>;
  if (fuel.isError) return <Text style={{ padding: 16, fontSize: font.md, color: colors.red }}>{t("admin.trucks.logsError")}</Text>;

  const logs = fuel.data?.logs ?? [];
  const s = fuel.data?.summary;

  if (logs.length === 0) return <Text style={{ padding: 16, fontSize: font.md, color: colors.textMuted }}>{t("admin.trucks.noFills")}</Text>;

  return (
    <View style={{ paddingTop: 8, paddingHorizontal: 16, paddingBottom: 14 }}>
      {s && (
        <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 6, marginBottom: 10 }}>
          {t("admin.trucks.allTime", {
            litres: formatNumber(s.total_litres),
            cost: formatMoney(s.total_cost_rm),
            perL: s.avg_cost_per_litre != null ? formatMoney(s.avg_cost_per_litre) : "—",
            km: s.total_km_covered > 0 ? formatNumber(s.total_km_covered) : "—",
          })}
        </Text>
      )}
      {mode === "wide" ? (
        <View>
          <TableHeader>
            <TableCell flex={1.1} header>{t("admin.trucks.colDate")}</TableCell>
            <TableCell flex={0.8} header textStyle={{ textAlign: "right" }}>{t("admin.trucks.litres")}</TableCell>
            <TableCell flex={0.9} header textStyle={{ textAlign: "right" }}>{t("admin.trucks.colCost")}</TableCell>
            <TableCell flex={1} header textStyle={{ textAlign: "right" }}>{t("admin.trucks.odometerKm")}</TableCell>
            <TableCell flex={1.1} header>{t("admin.trucks.colLoggedBy")}</TableCell>
          </TableHeader>
          {logs.map((l) => (
            <TableRow key={l.id}>
              <TableCell flex={1.1}>{formatDate(l.logged_at)}</TableCell>
              <TableCell flex={0.8} textStyle={{ textAlign: "right" }}>{`${formatNumber(l.liters)} L`}</TableCell>
              <TableCell flex={0.9} textStyle={{ textAlign: "right" }}>{formatMoney(l.cost)}</TableCell>
              <TableCell flex={1} textStyle={{ textAlign: "right" }}>
                {l.odometer != null ? `${formatNumber(l.odometer)} km` : "—"}
              </TableCell>
              <TableCell flex={1.1} textStyle={{ color: colors.textMuted }}>{l.driver?.name ?? "—"}</TableCell>
            </TableRow>
          ))}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {logs.map((l) => (
            <View key={l.id} style={{ borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: 8 }}>
              <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.text }}>{formatDate(l.logged_at)}</Text>
              <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
                {formatNumber(l.liters)} L · {formatMoney(l.cost)}
                {l.odometer != null ? ` · ${formatNumber(l.odometer)} km` : ""}
                {l.driver?.name ? ` · ${l.driver.name}` : ""}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// ── Log Fuel form (admin) ────────────────────────────────────────────────
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function LogFuelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const trucks = useTrucks();
  const logFuel = useLogFuel();
  const [plate, setPlate] = useState("");
  const [litres, setLitres] = useState("");
  const [cost, setCost] = useState("");
  const [odometer, setOdometer] = useState("");
  const [date, setDate] = useState(todayIso);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const reset = () => {
    setPlate("");
    setLitres("");
    setCost("");
    setOdometer("");
    setDate(todayIso());
    setError(null);
  };

  const submit = () => {
    setError(null);
    const litresN = Number(litres);
    const costN = Number(cost);
    const odoN = Number(odometer);
    if (!plate) return setError(t("admin.trucks.valTruck"));
    if (!(litresN > 0)) return setError(t("admin.trucks.valLitres"));
    if (!(costN > 0)) return setError(t("admin.trucks.valCost"));
    if (!(odoN > 0)) return setError(t("admin.trucks.valOdometer"));

    logFuel.mutate(
      { plate, litres: litresN, cost_rm: costN, odometer_km: odoN, logged_at: date },
      {
        onSuccess: () => {
          reset();
          onClose();
        },
        onError: (err) => setError(apiErrorMessage(err, t("admin.trucks.logSaveFailed"))),
      }
    );
  };

  if (!open) return null;
  const selected = (trucks.data ?? []).find((tr) => tr.plate === plate);

  return (
    <Modal open onClose={onClose} title={t("admin.trucks.logTitle")} width={420}>
      <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 6, color: colors.text }}>{t("admin.trucks.colTruck")}</Text>
      <Pressable
        onPress={() => setPickerOpen(true)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: 11,
          paddingHorizontal: 13,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.card,
          marginBottom: 14,
        }}
      >
        <Text style={{ fontSize: font.md, color: selected ? colors.text : colors.textFaint }}>
          {selected ? `${selected.plate} — ${selected.type}` : t("admin.trucks.selectTruck")}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>

      <Input label={t("admin.trucks.litres")} value={litres} onChange={setLitres} type="number" placeholder="e.g. 120.5" />
      <Input label={t("admin.trucks.costRm")} value={cost} onChange={setCost} type="number" placeholder="e.g. 380.00" />
      <Input label={t("admin.trucks.odometerKm")} value={odometer} onChange={setOdometer} type="number" placeholder="e.g. 152340" />
      <DateField label={t("admin.trucks.colDate")} value={date} onChange={setDate} />

      {error && <Text style={{ color: colors.red, fontSize: font.md, marginBottom: 12 }}>{error}</Text>}

      <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
        <Button variant="ghost" onPress={onClose} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button onPress={submit} disabled={logFuel.isPending} style={{ flex: 1 }}>
          {logFuel.isPending ? t("admin.trucks.saving") : t("admin.trucks.saveLog")}
        </Button>
      </View>

      <OptionsModal
        visible={pickerOpen}
        title={t("admin.trucks.colTruck")}
        options={(trucks.data ?? []).map((tr) => ({ label: `${tr.plate} — ${tr.type}`, value: tr.plate }))}
        selectedValue={plate}
        onSelect={setPlate}
        onClose={() => setPickerOpen(false)}
      />
    </Modal>
  );
}
