// Incentive Rate Management — RN port of admin/src/pages/IncentivesPage.tsx
// (Phase 4, PC-first). MONEY RULES: rate/staging MATH is API-side and
// untouched — this is a UI port on the verbatim ported hooks. The next-day
// staging DISPLAY is preserved exactly: every edit modal warns that changes
// take effect tomorrow (MYT), and staged edits render the amber ⏳ pending
// note (old rate stays live today) so an admin is never misled into thinking
// a new rate is live immediately.
import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { LinearGradient } from "expo-linear-gradient";
import {
  useDestinationRates,
  useRateAudit,
  useResetTruckRates,
  useTrucks,
  useUpdateDestinationRate,
  useUpdateTruckRates,
} from "../hooks/queries";
import { colors, font, gradients, radius } from "../theme";
import { Button, Card, ChipGrid, ErrorState, Input, Loading, Modal, Pill, SectionTitle, TableCell, TableHeader, TableRow } from "../components/ui";
import { formatDate, formatMoney } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DestinationRate, RateAuditEntry, RateResetResult, Truck } from "../types";

// Small muted "last updated by X on DATE" line under a row (audit parity).
function UpdatedNote({ entry }: { entry?: RateAuditEntry }) {
  const { t } = useTranslation();
  if (!entry) return null;
  return (
    <Text style={{ fontSize: font.xs, color: colors.textFaint, marginTop: 3 }}>
      {t("admin.incentives.updatedBy", { name: entry.user_name, date: formatDate(entry.timestamp) })}
    </Text>
  );
}

// A staged rate edit waiting for its next-MYT-day cutoff: today's assignments
// still pay the current (displayed) rates; these values take over on the date.
function PendingRatesNote({ pending }: { pending: Truck["pending_rates"] }) {
  const { t } = useTranslation();
  if (!pending) return null;
  const parts: string[] = [];
  if (pending.entitled_claim_weekday !== null)
    parts.push(t("admin.incentives.pendingWeekday", { value: formatMoney(pending.entitled_claim_weekday) }));
  if (pending.entitled_claim_offpeak !== null)
    parts.push(t("admin.incentives.pendingWeekend", { value: formatMoney(pending.entitled_claim_offpeak) }));
  if (pending.daily_deduction_points !== null)
    parts.push(t("admin.incentives.pendingDeduction", { value: pending.daily_deduction_points }));
  return (
    <Text style={{ fontSize: font.xs, color: colors.amber, fontWeight: "600", marginTop: 3 }}>
      {t("admin.incentives.pendingNote", { parts: parts.join(" · "), date: pending.effective_date })}
    </Text>
  );
}

type Tab = "trucks" | "destinations" | "formula";

export function IncentivesScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [tab, setTab] = useState<Tab>("trucks");
  const wide = mode === "wide";

  const tabs: [Tab, string][] = [
    ["trucks", t("admin.incentives.tabTrucks")],
    ["destinations", t("admin.incentives.tabDestinations")],
    ["formula", t("admin.incentives.tabFormula")],
  ];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      {/* Narrow: even 2-col grid (no ragged wrap). Wide: the old-admin pill row. */}
      {wide ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {tabs.map(([v, label]) => (
            <Pressable
              key={v}
              onPress={() => setTab(v)}
              style={{
                paddingVertical: 9,
                paddingHorizontal: 18,
                borderRadius: radius.pill,
                borderWidth: 1.5,
                borderColor: tab === v ? colors.blue : colors.border,
                backgroundColor: tab === v ? colors.blue : colors.card,
              }}
            >
              <Text style={{ color: tab === v ? "#fff" : colors.textMuted, fontWeight: "700", fontSize: font.md }}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <ChipGrid options={tabs.map(([v, label]) => ({ value: v, label }))} value={tab} onChange={setTab} columns={2} />
      )}

      {tab === "trucks" && <TruckRatesTab />}
      {tab === "destinations" && <DestinationPointsTab />}
      {tab === "formula" && <FormulaTab />}
    </ScrollView>
  );
}

// ── Truck claim rates ─────────────────────────────────────────────────
function TruckRatesTab() {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const trucks = useTrucks();
  const audit = useRateAudit();
  const [editing, setEditing] = useState<Truck | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetResult, setResetResult] = useState<RateResetResult | null>(null);

  const auditByPlate = useMemo(() => {
    const m = new Map<string, RateAuditEntry>();
    for (const a of audit.data ?? []) if (a.table_name === "Truck") m.set(a.record_id, a);
    return m;
  }, [audit.data]);

  if (trucks.isLoading) return <Loading />;
  if (trucks.isError) return <ErrorState message={t("admin.trucks.loadError")} onRetry={() => trucks.refetch()} />;

  return (
    <Card pad={0}>
      <View style={{ padding: narrow ? 14 : 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        {narrow ? (
          // Stacked on phones — the title and the Reset button don't fight
          // for one row (the crushed-title bug).
          <View style={{ gap: 10 }}>
            <SectionTitle
              title={t("admin.incentives.truckRatesTitle")}
              subtitle={t("admin.dashboard.trucksCount", { count: trucks.data!.length })}
            />
            <Button variant="outline" size="sm" onPress={() => setConfirmingReset(true)} style={{ alignSelf: "flex-start" }}>
              {t("admin.incentives.resetToSpec")}
            </Button>
          </View>
        ) : (
          <SectionTitle
            title={t("admin.incentives.truckRatesTitle")}
            subtitle={t("admin.dashboard.trucksCount", { count: trucks.data!.length })}
            right={
              <Button variant="outline" size="sm" onPress={() => setConfirmingReset(true)}>
                {t("admin.incentives.resetToSpec")}
              </Button>
            }
          />
        )}
        {resetResult && <ResetResultBanner result={resetResult} onDismiss={() => setResetResult(null)} />}
      </View>
      {narrow ? (
        // TABLE→CARD (standing rule): one card per truck, same labeled rate
        // boxes as the Truck Management cards.
        <View style={{ padding: 12, gap: 10 }}>
          {trucks.data!.map((tr) => (
            <View key={tr.plate} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>{tr.plate}</Text>
                  <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
                    {tr.type} · {t("admin.trucks.palletsCount", { count: tr.max_pallets })}
                  </Text>
                </View>
                <Button variant="outline" size="sm" onPress={() => setEditing(tr)}>
                  {t("admin.consignees.edit")}
                </Button>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <RateBox label={t("admin.trucks.rateWeekday")} value={formatMoney(tr.entitled_claim_weekday)} fg={colors.blue} bg={colors.blueTint} />
                <RateBox label={t("admin.trucks.rateWeekend")} value={formatMoney(tr.entitled_claim_offpeak)} fg={colors.amber} bg={colors.yellowTint} />
                <RateBox label={t("admin.trucks.rateDeduction")} value={t("admin.trucks.pts", { count: tr.daily_deduction_points })} fg={colors.red} bg={colors.redTint} />
              </View>
              <UpdatedNote entry={auditByPlate.get(tr.plate)} />
              <PendingRatesNote pending={tr.pending_rates} />
            </View>
          ))}
        </View>
      ) : (
        <>
          <TableHeader style={{ borderRadius: 0 }}>
            <TableCell flex={1.6} header>{t("admin.trucks.colTruck")}</TableCell>
            <TableCell flex={1} header>{t("admin.trucks.colType")}</TableCell>
            <TableCell flex={0.9} header>{t("admin.incentives.colMaxLoad")}</TableCell>
            <TableCell flex={1} header>{t("admin.incentives.colWeekdayRate")}</TableCell>
            <TableCell flex={1} header>{t("admin.incentives.colWeekendRate")}</TableCell>
            <TableCell flex={1} header>{t("admin.incentives.colDeduction")}</TableCell>
            <TableCell flex={0.7} header>{""}</TableCell>
          </TableHeader>
          {trucks.data!.map((tr) => (
            <TableRow key={tr.plate}>
              <TableCell flex={1.6}>
                <View>
                  <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>{tr.plate}</Text>
                  <UpdatedNote entry={auditByPlate.get(tr.plate)} />
                  <PendingRatesNote pending={tr.pending_rates} />
                </View>
              </TableCell>
              <TableCell flex={1}>{tr.type}</TableCell>
              <TableCell flex={0.9}>{t("admin.trucks.palletsCount", { count: tr.max_pallets })}</TableCell>
              <TableCell flex={1}><Pill bg={colors.blueTint} fg={colors.blue}>{formatMoney(tr.entitled_claim_weekday)}</Pill></TableCell>
              <TableCell flex={1}><Pill bg={colors.yellowTint} fg={colors.amber}>{formatMoney(tr.entitled_claim_offpeak)}</Pill></TableCell>
              <TableCell flex={1}><Pill bg={colors.redTint} fg={colors.red}>{t("admin.trucks.pts", { count: tr.daily_deduction_points })}</Pill></TableCell>
              <TableCell flex={0.7}>
                <Button variant="ghost" size="sm" onPress={() => setEditing(tr)}>
                  {t("admin.consignees.edit")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </>
      )}
      {editing && <EditTruckModal truck={editing} onClose={() => setEditing(null)} />}
      {confirmingReset && (
        <ResetRatesConfirm
          onClose={() => setConfirmingReset(false)}
          onDone={(r) => {
            setResetResult(r);
            setConfirmingReset(false);
          }}
        />
      )}
    </Card>
  );
}

// Labeled tinted rate box — the Truck Management card's rate visual, reused
// for the narrow claim-rates cards.
function RateBox({ label, value, fg, bg }: { label: string; value: string; fg: string; bg: string }) {
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 4, alignItems: "center" }}>
      <Text numberOfLines={1} style={{ fontSize: 12, fontWeight: "800", letterSpacing: 0.5, color: fg, textTransform: "uppercase" }}>
        {label}
      </Text>
      <Text numberOfLines={1} style={{ fontSize: font.md, fontWeight: "800", color: fg, marginTop: 2 }}>{value}</Text>
    </View>
  );
}

// Confirm dialog for the spec reset — overwrites all truck rate values.
function ResetRatesConfirm({ onClose, onDone }: { onClose: () => void; onDone: (r: RateResetResult) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const reset = useResetTruckRates();

  async function doReset() {
    setError(null);
    try {
      onDone(await reset.mutateAsync());
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentives.resetFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.incentives.resetTitle")} width={420}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <Text style={{ fontSize: font.md, color: colors.text, lineHeight: 22, marginBottom: 14 }}>{t("admin.incentives.resetBody")}</Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button variant="ghost" onPress={onClose} disabled={reset.isPending} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" onPress={doReset} disabled={reset.isPending} style={{ flex: 1 }}>
          {reset.isPending ? t("admin.incentives.resetting") : t("admin.incentives.reset")}
        </Button>
      </View>
    </Modal>
  );
}

// Brief result summary after a reset ("3 trucks reset · 4 already at spec").
function ResetResultBanner({ result, onDismiss }: { result: RateResetResult; onDismiss: () => void }) {
  const { t } = useTranslation();
  const parts = [
    t("admin.incentives.resetUpdated", { count: result.updated.length }),
    t("admin.incentives.resetAtSpec", { count: result.already_at_spec.length }),
  ];
  if (result.skipped.length > 0) parts.push(t("admin.incentives.resetSkipped", { count: result.skipped.length }));
  if (result.updated.length > 0 && result.rates_effective_date) {
    parts.push(t("admin.incentives.resetEffective", { date: result.rates_effective_date }));
  }
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        marginTop: 12,
        backgroundColor: colors.greenTint,
        borderRadius: radius.md,
        paddingVertical: 9,
        paddingHorizontal: 13,
      }}
    >
      <Text style={{ flex: 1, color: colors.green, fontSize: font.sm, fontWeight: "600" }}>✓ {parts.join(" · ")}</Text>
      <Pressable onPress={onDismiss} hitSlop={8}>
        <Text style={{ color: colors.green, fontSize: font.md, fontWeight: "700" }}>×</Text>
      </Pressable>
    </View>
  );
}

function EditTruckModal({ truck, onClose }: { truck: Truck; onClose: () => void }) {
  const { t } = useTranslation();
  const [weekday, setWeekday] = useState(String(truck.entitled_claim_weekday));
  const [weekend, setWeekend] = useState(String(truck.entitled_claim_offpeak));
  const [deduction, setDeduction] = useState(String(truck.daily_deduction_points));
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateTruckRates();

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({
        plate: truck.plate,
        entitled_claim_weekday: Number(weekday),
        entitled_claim_offpeak: Number(weekend),
        daily_deduction_points: Number(deduction),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentives.rateSaveFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.incentives.editRatesTitle", { plate: truck.plate })}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      {/* The staging rule, stated where the admin is about to type. */}
      <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
        <Text style={{ color: colors.amber, fontSize: font.sm, fontWeight: "500" }}>{t("admin.incentives.stagingWarning")}</Text>
      </View>
      <Input label={t("admin.incentives.weekdayRateRm")} value={weekday} onChange={setWeekday} type="number" />
      <Input label={t("admin.incentives.weekendRateRm")} value={weekend} onChange={setWeekend} type="number" />
      <Input label={t("admin.incentives.deductionPoints")} value={deduction} onChange={setDeduction} type="number" />
      <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
        <Button variant="ghost" onPress={onClose} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={update.isPending} onPress={save} style={{ flex: 1 }}>
          {update.isPending ? t("admin.trucks.saving") : t("admin.incentives.saveChanges")}
        </Button>
      </View>
    </Modal>
  );
}

// ── Destination points ────────────────────────────────────────────────
const MAX_POINTS = 8;
function tierOf(points: number) {
  if (points <= 1) return { key: "admin.incentives.tierLocal", color: colors.green };
  if (points <= 3) return { key: "admin.incentives.tierNearby", color: colors.blue };
  if (points <= 5) return { key: "admin.incentives.tierMedium", color: colors.amber };
  if (points <= 6) return { key: "admin.incentives.tierFar", color: colors.orange };
  return { key: "admin.incentives.tierLong", color: colors.red };
}

function DestinationPointsTab() {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const rates = useDestinationRates();
  const audit = useRateAudit();
  const [editing, setEditing] = useState<DestinationRate | null>(null);

  const auditById = useMemo(() => {
    const m = new Map<string, RateAuditEntry>();
    for (const a of audit.data ?? []) if (a.table_name === "DestinationRate") m.set(a.record_id, a);
    return m;
  }, [audit.data]);

  if (rates.isLoading) return <Loading />;
  if (rates.isError) return <ErrorState message={t("admin.incentives.ratesLoadError")} onRetry={() => rates.refetch()} />;

  if (narrow) {
    // TABLE→CARD: name + zone left, points + tier right, Edit on the row.
    return (
      <Card pad={0}>
        <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <SectionTitle
            title={t("admin.incentives.destTitle")}
            subtitle={t("admin.incentives.destSub", { count: rates.data!.length })}
          />
        </View>
        <View style={{ padding: 12, gap: 10 }}>
          {rates.data!.map((r) => {
            const ti = tierOf(r.points);
            return (
              <View key={r.id} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>{r.location_name}</Text>
                    <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 1 }}>{r.zone_code ?? "—"}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Text style={{ fontSize: font.lg, fontWeight: "800", color: colors.text }}>
                      {r.points} <Text style={{ fontSize: font.xs, fontWeight: "600", color: colors.textFaint }}>{t("admin.incentives.colPoints")}</Text>
                    </Text>
                    <Pill bg={`${ti.color}1a`} fg={ti.color}>{t(ti.key)}</Pill>
                  </View>
                  <Button variant="ghost" size="sm" onPress={() => setEditing(r)}>
                    {t("admin.consignees.edit")}
                  </Button>
                </View>
                <UpdatedNote entry={auditById.get(r.id)} />
                {r.pending_points_effective !== null && r.pending_points !== null && (
                  <Text style={{ fontSize: font.xs, color: colors.amber, fontWeight: "600" }}>
                    {t("admin.incentives.pendingPoints", { points: r.pending_points, date: r.pending_points_effective })}
                  </Text>
                )}
              </View>
            );
          })}
        </View>
        {editing && <EditPointsModal rate={editing} onClose={() => setEditing(null)} />}
      </Card>
    );
  }

  return (
    <Card pad={0}>
      <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <SectionTitle
          title={t("admin.incentives.destTitle")}
          subtitle={t("admin.incentives.destSub", { count: rates.data!.length })}
        />
      </View>
      <TableHeader style={{ borderRadius: 0 }}>
        <TableCell flex={1.8} header>{t("admin.incentives.colDestination")}</TableCell>
        <TableCell flex={0.7} header>{t("admin.drivers.statZone" /* Zone */)}</TableCell>
        <TableCell flex={1.3} header>{t("admin.incentives.colPoints")}</TableCell>
        <TableCell flex={1} header>{t("admin.incentives.colTier")}</TableCell>
        <TableCell flex={0.7} header>{""}</TableCell>
      </TableHeader>
      {rates.data!.map((r) => {
        const ti = tierOf(r.points);
        return (
          <TableRow key={r.id}>
            <TableCell flex={1.8}>
              <View>
                <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>{r.location_name}</Text>
                <UpdatedNote entry={auditById.get(r.id)} />
                {/* Staged next-day points edit (same cutoff as truck rates). */}
                {r.pending_points_effective !== null && r.pending_points !== null && (
                  <Text style={{ fontSize: font.xs, color: colors.amber, fontWeight: "600", marginTop: 3 }}>
                    {t("admin.incentives.pendingPoints", { points: r.pending_points, date: r.pending_points_effective })}
                  </Text>
                )}
              </View>
            </TableCell>
            <TableCell flex={0.7}>{r.zone_code ?? "—"}</TableCell>
            <TableCell flex={1.3}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1, maxWidth: 90, height: 8, backgroundColor: colors.divider, borderRadius: radius.pill, overflow: "hidden" }}>
                  <View style={{ width: `${(r.points / MAX_POINTS) * 100}%`, height: "100%", backgroundColor: ti.color }} />
                </View>
                <Text style={{ fontWeight: "700", fontSize: font.md, color: colors.text }}>{r.points}</Text>
              </View>
            </TableCell>
            <TableCell flex={1}>
              <Pill bg={`${ti.color}1a`} fg={ti.color}>{t(ti.key)}</Pill>
            </TableCell>
            <TableCell flex={0.7}>
              <Button variant="ghost" size="sm" onPress={() => setEditing(r)}>
                {t("admin.consignees.edit")}
              </Button>
            </TableCell>
          </TableRow>
        );
      })}
      {editing && <EditPointsModal rate={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function EditPointsModal({ rate, onClose }: { rate: DestinationRate; onClose: () => void }) {
  const { t } = useTranslation();
  const [points, setPoints] = useState(String(rate.points));
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateDestinationRate();

  async function save() {
    setError(null);
    try {
      await update.mutateAsync({ id: rate.id, points: Number(points) });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentives.pointsSaveFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.incentives.editPointsTitle", { name: rate.location_name })} width={380}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
        <Text style={{ color: colors.amber, fontSize: font.sm, fontWeight: "500" }}>
          {t("admin.incentives.pointsStagingWarning")}
          {rate.zone_code ? ` ${t("admin.incentives.zoneWideNote")}` : ""}
        </Text>
      </View>
      <Input label={t("admin.incentives.destPoints")} value={points} onChange={setPoints} type="number" />
      <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
        <Button variant="ghost" onPress={onClose} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" disabled={update.isPending} onPress={save} style={{ flex: 1 }}>
          {update.isPending ? t("admin.trucks.saving") : t("common.save")}
        </Button>
      </View>
    </Modal>
  );
}

// ── Formula explainer ─────────────────────────────────────────────────
function FormulaTab() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const wide = mode === "wide";
  const rules: string[] = t("admin.incentives.rules", { returnObjects: true }) as unknown as string[];
  return (
    <View style={{ gap: 16 }}>
      <LinearGradient
        colors={gradients.blue}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ borderRadius: radius.xl, padding: 26, alignItems: "center" }}
      >
        <Text style={{ fontSize: font.sm, letterSpacing: 1, color: "rgba(255,255,255,0.7)", textTransform: "uppercase", marginBottom: 10 }}>
          {t("admin.incentives.formulaTitle")}
        </Text>
        <Text style={{ fontSize: 19, fontWeight: "700", color: "#fff", textAlign: "center" }}>
          {t("admin.incentives.formulaLine1")} <Text style={{ color: colors.yellow }}>{t("admin.incentives.formulaPoints")}</Text>
        </Text>
        <Text style={{ fontSize: font.md, marginTop: 8, color: "rgba(255,255,255,0.85)", textAlign: "center" }}>
          {t("admin.incentives.formulaLine2Pre")}{" "}
          <Text style={{ color: colors.yellow, fontWeight: "700" }}>{t("admin.incentives.formulaDeduction")}</Text>{" "}
          {t("admin.incentives.formulaLine2Post")}
        </Text>
      </LinearGradient>

      <View style={{ flexDirection: wide ? "row" : "column", gap: 16 }}>
        <View style={{ flex: wide ? 1 : undefined }}>
          <Card>
            <SectionTitle title={t("admin.incentives.rulesTitle")} />
            <View style={{ gap: 6 }}>
              {Array.isArray(rules) &&
                rules.map((r, i) => (
                  <View key={i} style={{ flexDirection: "row", gap: 8 }}>
                    <Text style={{ color: colors.text, fontSize: font.md }}>•</Text>
                    <Text style={{ color: colors.text, fontSize: font.md, lineHeight: 22, flex: 1 }}>{r}</Text>
                  </View>
                ))}
            </View>
          </Card>
        </View>
        <View style={{ flex: wide ? 1 : undefined }}>
          <Card>
            <SectionTitle title={t("admin.incentives.timeRatesTitle")} />
            <View style={{ gap: 10 }}>
              <View style={{ backgroundColor: colors.blueTint, borderRadius: radius.md, padding: 14 }}>
                <Text style={{ fontSize: font.sm, color: colors.blue, fontWeight: "700", textTransform: "uppercase" }}>
                  {t("admin.incentives.weekdayCardTitle")}
                </Text>
                <Text style={{ fontSize: font.md, color: colors.textMuted, marginTop: 4 }}>{t("admin.incentives.weekdayCardBody")}</Text>
              </View>
              <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.md, padding: 14 }}>
                <Text style={{ fontSize: font.sm, color: colors.amber, fontWeight: "700", textTransform: "uppercase" }}>
                  {t("admin.incentives.weekendCardTitle")}
                </Text>
                <Text style={{ fontSize: font.md, color: colors.textMuted, marginTop: 4 }}>{t("admin.incentives.weekendCardBody")}</Text>
              </View>
            </View>
          </Card>
        </View>
      </View>
    </View>
  );
}
