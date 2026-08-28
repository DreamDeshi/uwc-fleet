// Incentive Rate Management — RN port of admin/src/pages/IncentivesPage.tsx
// (Phase 4, PC-first). MONEY RULES: rate/staging MATH is API-side and
// untouched — this is a UI port on the verbatim ported hooks. The next-day
// staging DISPLAY is preserved exactly: every edit modal warns that changes
// take effect tomorrow (MYT), and staged edits render the amber ⏳ pending
// note (old rate stays live today) so an admin is never misled into thinking
// a new rate is live immediately.
import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { LinearGradient } from "expo-linear-gradient";
import {
  useDestinationRates,
  useIncentiveRules,
  useRateAudit,
  useResetTruckRates,
  useTrucks,
  useUpdateDestinationRate,
  useUpdateTruckRates,
  useSettingsList,
  useUpdateSetting,
  useResetSetting,
} from "../hooks/queries";
import type { EffectiveSettingDto } from "../../hooks/queries";
import { colors, font, gradients, radius } from "../theme";
import { Avatar, Button, Card, ChipGrid, ErrorState, Input, Loading, Modal, Pill, SectionTitle, TableCell, TableHeader, TableRow } from "../components/ui";
import { formatDate, formatMoney } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DestinationRate, RateAuditEntry, RateResetResult, Truck } from "../types";
import { formatPalletSpaces } from "../../lib/pallets";
import { TimeOfDayPicker } from "../components/TimeOfDayPicker";

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
    parts.push(t("admin.incentives.pendingPeak", { value: formatMoney(pending.entitled_claim_weekday) }));
  if (pending.entitled_claim_offpeak !== null)
    parts.push(t("admin.incentives.pendingOffPeak", { value: formatMoney(pending.entitled_claim_offpeak) }));
  if (pending.daily_deduction_points !== null)
    parts.push(t("admin.incentives.pendingDeduction", { value: pending.daily_deduction_points }));
  return (
    <Text style={{ fontSize: font.xs, color: colors.amber, fontWeight: "600", marginTop: 3 }}>
      {t("admin.incentives.pendingNote", { parts: parts.join(" · "), date: pending.effective_date })}
    </Text>
  );
}

type Tab = "trucks" | "destinations" | "cutoffs" | "window" | "formula";

export function IncentivesScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [tab, setTab] = useState<Tab>("trucks");
  const wide = mode === "wide";

  const tabs: [Tab, string][] = [
    ["trucks", t("admin.incentives.tabTrucks")],
    ["destinations", t("admin.incentives.tabDestinations")],
    ["cutoffs", t("admin.incentives.tabCutoffs")],
    ["window", t("admin.incentives.tabWindow")],
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
      {tab === "cutoffs" && <BookingCutoffsTab />}
      {tab === "window" && <DispatchWindowTab />}
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
            <View key={tr.plate} style={rateCard.card}>
              {/* Frame 9: the truck's identity sits on a NAVY band with the
                  yellow glyph and Edit INSIDE it — the same band the Trucks and
                  Drivers screens already use (frames 2 and 3). Rates hang under
                  it. This screen had been left as a plain white card, which is
                  what made it look untouched beside the drawing. */}
              <View style={rateCard.idBand}>
                <Avatar size={40} glyph={<Ionicons name="bus" size={18} color={colors.yellow} />} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={rateCard.idPlate}>{tr.plate}</Text>
                  <Text style={rateCard.idMeta}>
                    {tr.type} · {t("admin.trucks.palletsCount", { spaces: formatPalletSpaces(tr.max_pallets) })}
                  </Text>
                </View>
                {/* On the dark band an outline button would disappear, so Edit
                    wears the translucent-white fill the band pills use. */}
                <Pressable onPress={() => setEditing(tr)} style={rateCard.bandEdit} accessibilityRole="button">
                  <Text style={rateCard.bandEditText}>{t("admin.consignees.edit")}</Text>
                </Pressable>
              </View>
              <View style={{ padding: 12, gap: 10 }}>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <RateBox label={t("admin.trucks.ratePeak")} value={formatMoney(tr.entitled_claim_weekday)} fg={colors.blue} bg={colors.blueTint} />
                <RateBox label={t("admin.trucks.rateOffPeak")} value={formatMoney(tr.entitled_claim_offpeak)} fg={colors.amber} bg={colors.yellowTint} />
                <RateBox label={t("admin.trucks.rateDeduction")} value={t("admin.trucks.pts", { count: tr.daily_deduction_points })} fg={colors.red} bg={colors.redTint} />
              </View>
              <UpdatedNote entry={auditByPlate.get(tr.plate)} />
              <PendingRatesNote pending={tr.pending_rates} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <>
          <TableHeader style={{ borderRadius: 0 }}>
            <TableCell flex={1.6} header>{t("admin.trucks.colTruck")}</TableCell>
            <TableCell flex={1} header>{t("admin.trucks.colType")}</TableCell>
            <TableCell flex={0.9} header>{t("admin.incentives.colMaxLoad")}</TableCell>
            <TableCell flex={1} header>{t("admin.incentives.colPeakRate")}</TableCell>
            <TableCell flex={1} header>{t("admin.incentives.colOffPeakRate")}</TableCell>
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
              <TableCell flex={0.9}>{t("admin.trucks.palletsCount", { spaces: formatPalletSpaces(tr.max_pallets) })}</TableCell>
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
      <Input label={t("admin.incentives.peakRateRm")} value={weekday} onChange={setWeekday} type="number" />
      <Input label={t("admin.incentives.offPeakRateRm")} value={weekend} onChange={setWeekend} type="number" />
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
  if (points <= 6) return { key: "admin.incentives.tierFar", color: colors.amberText };
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

// ── Booking cut-offs (27 Aug 2026 — Teh agreed to a flexible B7 cut-off
// time, WhatsApp: "do you want a flexible system for the admin to change
// the time" / "yes") ────────────────────────────────────────────────────
//
// Lives here rather than under the admin's personal Settings, on owner
// instruction (28 Aug 2026) — this is an operating rule, not an account
// preference, and Incentive Rate is already where the fleet's operating
// numbers get tuned. Registry-driven: a future admin-editable setting is
// one CUTOFF_COPY entry, not a new screen.
const CUTOFF_COPY: Record<string, { labelKey: string; descKey: string }> = {
  "booking.morning_cutoff_min": {
    labelKey: "admin.settings.cutoffMorningLabel",
    descKey: "admin.settings.cutoffMorningDesc",
  },
  "booking.afternoon_cutoff_min": {
    labelKey: "admin.settings.cutoffAfternoonLabel",
    descKey: "admin.settings.cutoffAfternoonDesc",
  },
  "booking.session_split_min": {
    labelKey: "admin.settings.cutoffSessionSplitLabel",
    descKey: "admin.settings.cutoffSessionSplitDesc",
  },
};

function formatMinutesHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseMinutesHm(hhmm: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Which "minutes"-typed settings are a CLOCK TIME (10:00) vs a DURATION
// (30 minutes) — the registry's `type` field can't tell the two apart, since
// both are stored as an integer count of minutes. Only the keys listed here
// get the tap-a-time picker; everything else in the Dispatch Window tab is a
// length of time, not a time of day, and gets a plain number + stepper.
const CLOCK_TIME_KEYS = new Set<string>([
  "booking.morning_cutoff_min",
  "booking.afternoon_cutoff_min",
  "booking.session_split_min",
  "dispatch.window_start",
  "dispatch.window_end",
]);

function BookingCutoffsTab() {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const { data, isLoading, isError, refetch } = useSettingsList();
  const [editing, setEditing] = useState<EffectiveSettingDto | null>(null);

  const rows = (data ?? []).filter((s) => s.key.startsWith("booking."));

  if (isLoading) return <Loading />;
  if (isError) return <ErrorState message={t("admin.settings.settingSaveFailed")} onRetry={() => refetch()} />;

  if (narrow) {
    return (
      <Card pad={0}>
        <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <SectionTitle title={t("admin.incentives.cutoffsTitle")} subtitle={t("admin.incentives.cutoffsSub")} />
        </View>
        <View style={{ padding: 12, gap: 10 }}>
          {rows.map((s) => {
            const copy = CUTOFF_COPY[s.key];
            return (
              <View key={s.key} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>
                      {copy ? t(copy.labelKey) : s.label}
                    </Text>
                    <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 1 }}>
                      {copy ? t(copy.descKey) : s.description}
                    </Text>
                  </View>
                  <Text style={{ fontSize: font.lg, fontWeight: "800", color: colors.text }}>
                    {formatMinutesHm(s.value as number)}
                  </Text>
                  <Button variant="ghost" size="sm" onPress={() => setEditing(s)}>
                    {t("admin.consignees.edit")}
                  </Button>
                </View>
                {s.source === "db" ? (
                  <Pill bg={colors.yellowTint} fg={colors.amber}>{t("admin.settings.settingCustomBadge")}</Pill>
                ) : null}
              </View>
            );
          })}
        </View>
        {editing && <EditTimeModal setting={editing} onClose={() => setEditing(null)} />}
      </Card>
    );
  }

  return (
    <Card pad={0}>
      <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <SectionTitle title={t("admin.incentives.cutoffsTitle")} subtitle={t("admin.incentives.cutoffsSub")} />
      </View>
      <TableHeader style={{ borderRadius: 0 }}>
        <TableCell flex={2.2} header>{t("admin.incentives.colCutoff")}</TableCell>
        <TableCell flex={1} header>{t("admin.incentives.colTime")}</TableCell>
        <TableCell flex={1} header>{""}</TableCell>
        <TableCell flex={0.7} header>{""}</TableCell>
      </TableHeader>
      {rows.map((s) => {
        const copy = CUTOFF_COPY[s.key];
        return (
          <TableRow key={s.key}>
            <TableCell flex={2.2}>
              <View>
                <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>
                  {copy ? t(copy.labelKey) : s.label}
                </Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 2 }}>
                  {copy ? t(copy.descKey) : s.description}
                </Text>
              </View>
            </TableCell>
            <TableCell flex={1}>
              <Text style={{ fontWeight: "700", fontSize: font.md, color: colors.text }}>
                {formatMinutesHm(s.value as number)}
              </Text>
            </TableCell>
            <TableCell flex={1}>
              {s.source === "db" ? (
                <Pill bg={colors.yellowTint} fg={colors.amber}>{t("admin.settings.settingCustomBadge")}</Pill>
              ) : null}
            </TableCell>
            <TableCell flex={0.7}>
              <Button variant="ghost" size="sm" onPress={() => setEditing(s)}>
                {t("admin.consignees.edit")}
              </Button>
            </TableCell>
          </TableRow>
        );
      })}
      {editing && <EditTimeModal setting={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

// ── Dispatch window defaults (Phase 2, 28 Aug 2026) — the fleet's FALLBACK
// pickup window, consulted only when a truck carries no operating hours of
// its own. Every truck today HAS its own hours (Trucks screen), and those
// always win over this — see settingsRegistry.ts's own comment on why this
// tab's reach is narrow on purpose, not an oversight.
const WINDOW_COPY: Record<string, { labelKey: string; descKey: string }> = {
  "dispatch.window_start": {
    labelKey: "admin.settings.windowStartLabel",
    descKey: "admin.settings.windowStartDesc",
  },
  "dispatch.window_end": {
    labelKey: "admin.settings.windowEndLabel",
    descKey: "admin.settings.windowEndDesc",
  },
  "dispatch.op_load_min": {
    labelKey: "admin.settings.opLoadMinLabel",
    descKey: "admin.settings.opLoadMinDesc",
  },
  "dispatch.op_unload_min_per_stop": {
    labelKey: "admin.settings.opUnloadMinLabel",
    descKey: "admin.settings.opUnloadMinDesc",
  },
  "dispatch.op_drive_min_per_leg": {
    labelKey: "admin.settings.opDriveMinLabel",
    descKey: "admin.settings.opDriveMinDesc",
  },
  "dispatch.op_drive_points_baseline": {
    labelKey: "admin.settings.opDriveBaselineLabel",
    descKey: "admin.settings.opDriveBaselineDesc",
  },
  "dispatch.assignment_conflict_buffer_min": {
    labelKey: "admin.settings.conflictBufferLabel",
    descKey: "admin.settings.conflictBufferDesc",
  },
};

// Step size the +/- stepper moves by, per duration/points setting. Falls back
// to 1 for anything not listed (a future setting added to this tab).
const NUMBER_STEP: Record<string, number> = {
  "dispatch.op_load_min": 5,
  "dispatch.op_unload_min_per_stop": 5,
  "dispatch.op_drive_min_per_leg": 5,
  "dispatch.op_drive_points_baseline": 1,
  "dispatch.assignment_conflict_buffer_min": 15,
};

function DispatchWindowTab() {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const { data, isLoading, isError, refetch } = useSettingsList();
  const [editing, setEditing] = useState<EffectiveSettingDto | null>(null);

  const rows = (data ?? []).filter((s) => s.key.startsWith("dispatch."));
  // Split by MEANING, not by the registry's `type` (which can't tell a clock
  // time from a duration — both are stored as an integer count of minutes).
  const timeRows = rows.filter((s) => CLOCK_TIME_KEYS.has(s.key));
  const estimateRows = rows.filter((s) => !CLOCK_TIME_KEYS.has(s.key));

  if (isLoading) return <Loading />;
  if (isError) return <ErrorState message={t("admin.settings.settingSaveFailed")} onRetry={() => refetch()} />;

  return (
    <View style={{ gap: 16 }}>
      <SettingsTable
        narrow={narrow}
        title={t("admin.incentives.windowTitle")}
        subtitle={t("admin.incentives.windowSub")}
        columnLabel={t("admin.incentives.colTime")}
        rows={timeRows}
        copyMap={WINDOW_COPY}
        onEdit={setEditing}
      />
      <SettingsTable
        narrow={narrow}
        title={t("admin.incentives.estimateTitle")}
        subtitle={t("admin.incentives.estimateSub")}
        columnLabel={t("admin.incentives.colValue")}
        rows={estimateRows}
        copyMap={WINDOW_COPY}
        onEdit={setEditing}
      />
      {editing &&
        (CLOCK_TIME_KEYS.has(editing.key) ? (
          <EditTimeModal setting={editing} onClose={() => setEditing(null)} />
        ) : (
          <EditNumberModal setting={editing} onClose={() => setEditing(null)} />
        ))}
    </View>
  );
}

// Shared table/card renderer for both halves of the Dispatch Window tab —
// the narrow/wide split is the same shape either way, only the rows, copy
// and column label differ.
function SettingsTable({
  narrow,
  title,
  subtitle,
  columnLabel,
  rows,
  copyMap,
  onEdit,
}: {
  narrow: boolean;
  title: string;
  subtitle: string;
  columnLabel: string;
  rows: EffectiveSettingDto[];
  copyMap: Record<string, { labelKey: string; descKey: string }>;
  onEdit: (s: EffectiveSettingDto) => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;

  if (narrow) {
    return (
      <Card pad={0}>
        <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <SectionTitle title={title} subtitle={subtitle} />
        </View>
        <View style={{ padding: 12, gap: 10 }}>
          {rows.map((s) => {
            const copy = copyMap[s.key];
            return (
              <View key={s.key} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>
                      {copy ? t(copy.labelKey) : s.label}
                    </Text>
                    <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 1 }}>
                      {copy ? t(copy.descKey) : s.description}
                    </Text>
                  </View>
                  <Text style={{ fontSize: font.lg, fontWeight: "800", color: colors.text }}>{String(s.value)}</Text>
                  <Button variant="ghost" size="sm" onPress={() => onEdit(s)}>
                    {t("admin.consignees.edit")}
                  </Button>
                </View>
                {s.source === "db" ? (
                  <Pill bg={colors.yellowTint} fg={colors.amber}>{t("admin.settings.settingCustomBadge")}</Pill>
                ) : null}
              </View>
            );
          })}
        </View>
      </Card>
    );
  }

  return (
    <Card pad={0}>
      <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <SectionTitle title={title} subtitle={subtitle} />
      </View>
      <TableHeader style={{ borderRadius: 0 }}>
        <TableCell flex={2.2} header>{t("admin.incentives.colSetting")}</TableCell>
        <TableCell flex={1} header>{columnLabel}</TableCell>
        <TableCell flex={1} header>{""}</TableCell>
        <TableCell flex={0.7} header>{""}</TableCell>
      </TableHeader>
      {rows.map((s) => {
        const copy = copyMap[s.key];
        return (
          <TableRow key={s.key}>
            <TableCell flex={2.2}>
              <View>
                <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>
                  {copy ? t(copy.labelKey) : s.label}
                </Text>
                <Text style={{ fontSize: font.xs, color: colors.textMuted, marginTop: 2 }}>
                  {copy ? t(copy.descKey) : s.description}
                </Text>
              </View>
            </TableCell>
            <TableCell flex={1}>
              <Text style={{ fontWeight: "700", fontSize: font.md, color: colors.text }}>{String(s.value)}</Text>
            </TableCell>
            <TableCell flex={1}>
              {s.source === "db" ? (
                <Pill bg={colors.yellowTint} fg={colors.amber}>{t("admin.settings.settingCustomBadge")}</Pill>
              ) : null}
            </TableCell>
            <TableCell flex={0.7}>
              <Button variant="ghost" size="sm" onPress={() => onEdit(s)}>
                {t("admin.consignees.edit")}
              </Button>
            </TableCell>
          </TableRow>
        );
      })}
    </Card>
  );
}

// ── Editing a TIME setting — TAP a value, don't type (owner feedback, 28 Aug
// 2026). Works for both representations the registry stores: a "time" setting
// is already an "HH:MM" string; a "minutes" clock-time setting (the B7
// cut-offs) is minutes-since-midnight. Both go through the same HH:MM text
// internally, and typing stays available right below the picker.
function EditTimeModal({ setting, onClose }: { setting: EffectiveSettingDto; onClose: () => void }) {
  const { t } = useTranslation();
  const isRawHmString = setting.type === "time";
  const [text, setText] = useState(
    isRawHmString ? String(setting.value) : formatMinutesHm(setting.value as number)
  );
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateSetting();
  const reset = useResetSetting();
  const copy = CUTOFF_COPY[setting.key] ?? WINDOW_COPY[setting.key];
  const label = copy ? t(copy.labelKey) : setting.label;

  const parsedMinutes = parseMinutesHm(text);
  const hour = parsedMinutes !== null ? Math.floor(parsedMinutes / 60) : 0;
  const minute = parsedMinutes !== null ? parsedMinutes % 60 : 0;

  async function save() {
    setError(null);
    if (parsedMinutes === null) {
      setError(t("admin.settings.settingTimeInvalid"));
      return;
    }
    try {
      await update.mutateAsync({
        key: setting.key,
        value: isRawHmString ? formatMinutesHm(parsedMinutes) : parsedMinutes,
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.settings.settingSaveFailed")));
    }
  }

  async function resetToDefault() {
    setError(null);
    try {
      await reset.mutateAsync(setting.key);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.settings.settingResetFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.settings.settingEditTitle", { label })} width={380}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 8, color: colors.text }}>{label}</Text>
      <TimeOfDayPicker hour={hour} minute={minute} onChange={(h, m) => setText(formatMinutesHm(h * 60 + m))} />
      <View style={{ marginTop: 14 }}>
        <Input
          label={t("admin.settings.orType")}
          value={text}
          onChange={setText}
          placeholder={t("admin.settings.settingTimePlaceholder")}
        />
      </View>
      <Button variant="ghost" size="sm" onPress={resetToDefault} disabled={reset.isPending} style={{ alignSelf: "flex-start", marginBottom: 8 }}>
        {t("admin.settings.settingResetToDefault")}
      </Button>
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

// ── Editing a DURATION/POINTS setting — a +/- stepper, typing still
// available. Not a time of day, so no HH:MM picker here.
function EditNumberModal({ setting, onClose }: { setting: EffectiveSettingDto; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(String(setting.value));
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateSetting();
  const reset = useResetSetting();
  const copy = WINDOW_COPY[setting.key];
  const label = copy ? t(copy.labelKey) : setting.label;
  const step = NUMBER_STEP[setting.key] ?? 1;
  const min = setting.min ?? 0;
  const max = setting.max ?? Number.MAX_SAFE_INTEGER;

  const parsedNum = Number(text);
  const isValid = text.trim() !== "" && Number.isInteger(parsedNum) && parsedNum >= min && parsedNum <= max;

  function bump(delta: number) {
    const current = text.trim() !== "" && Number.isInteger(parsedNum) ? parsedNum : (setting.value as number);
    setText(String(Math.min(max, Math.max(min, current + delta))));
  }

  async function save() {
    setError(null);
    if (!isValid) {
      setError(t("admin.settings.settingNumberInvalid"));
      return;
    }
    try {
      await update.mutateAsync({ key: setting.key, value: parsedNum });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.settings.settingSaveFailed")));
    }
  }

  async function resetToDefault() {
    setError(null);
    try {
      await reset.mutateAsync(setting.key);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.settings.settingResetFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.settings.settingEditTitle", { label })} width={380}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 10, color: colors.text }}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, marginBottom: 14 }}>
        <TouchableOpacity
          onPress={() => bump(-step)}
          accessibilityRole="button"
          accessibilityLabel={t("admin.settings.decrease")}
          style={{ width: 44, height: 44, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text }}>–</Text>
        </TouchableOpacity>
        <Text style={{ fontSize: 28, fontWeight: "800", color: colors.text, minWidth: 70, textAlign: "center" }}>
          {text}
        </Text>
        <TouchableOpacity
          onPress={() => bump(step)}
          accessibilityRole="button"
          accessibilityLabel={t("admin.settings.increase")}
          style={{ width: 44, height: 44, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ fontSize: 22, fontWeight: "700", color: colors.text }}>+</Text>
        </TouchableOpacity>
      </View>
      <Input label={t("admin.settings.orType")} value={text} onChange={setText} type="number" />
      <Button variant="ghost" size="sm" onPress={resetToDefault} disabled={reset.isPending} style={{ alignSelf: "flex-start", marginBottom: 8, marginTop: 4 }}>
        {t("admin.settings.settingResetToDefault")}
      </Button>
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
//
// This panel is what an admin reads to understand what the system pays, so its
// numbers come from GET /incentives/rules — the incentive engine's own exported
// constants — and not from a hand-written sentence. The previous copy had
// drifted into four separate money errors while every test stayed green:
//
//   · "subtract Daily Deduction Points on the first trip of the day" — the
//     pre-aa8d081 rule. It comes off the day TOTAL, once, floored at zero.
//   · "WEEKEND / HOLIDAY — HIGHER RATE" — not the rule. The bands are peak and
//     off-peak; off-peak includes every weekday evening and early morning,
//     which is most of what it actually pays for.
//   · "Malaysian public holidays" — R1 Q5 was explicit that the entitled list is
//     UWC's own Batu Kawan calendar. The Perak Sultan's birthday is a national
//     holiday UWC does not observe, and paying it off-peak would be a money
//     error, not a wording one.
//   · "normal operating window 07:00–02:00" — that is the PICKUP window, not a
//     rate band, and it has no business on a rates panel either way.
//     ⚠ The first version of this comment added "and B6 moved it to midnight",
//     which overstates what is true. B6 is an owner RULING (11 Aug 2026: the
//     window becomes 07:00–00:00, midnight being when the lorry must be BACK)
//     that has NOT been implemented — `PICKUP_WINDOW_END_HOUR` is still 2 here
//     and `DEFAULT_WINDOW_END` is still "02:00" on the server. The ruling is
//     real; the code has not moved. Do not "correct" copy to say midnight
//     until it has, or the app will describe a window it does not offer.
//
// Wording that describes behaviour (rather than a number) is pinned by
// `incentiveFormulaCopy.test.ts`, which fails on the retired phrasings in all
// three locales. Numbers that come from the engine cannot drift by definition.
// Exported for `incentiveFormulaCopy.test.ts`, which renders it against two
// different sets of engine constants — the only way to tell "reads the rules
// from the server" from "prints 08:00 because someone typed 08:00".
export function FormulaTab() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const wide = mode === "wide";
  const rulesQuery = useIncentiveRules();

  if (rulesQuery.isLoading) return <Loading />;
  if (rulesQuery.isError || !rulesQuery.data)
    return <ErrorState message={t("admin.incentives.rulesLoadError")} onRetry={() => rulesQuery.refetch()} />;

  const r = rulesQuery.data;
  const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
  const peakStart = hh(r.peak_start_hour);
  const peakEnd = hh(r.offpeak_cutoff_hour);

  // The rule list is assembled here, from the engine's values, rather than
  // being a static array in the locale files — that array is what silently
  // emptied the card (`admin.incentives.rules` never existed, so `t()` returned
  // the key, `Array.isArray` was false, and the card rendered blank).
  const rules: string[] = [
    t("admin.incentives.ruleZonePoints", { repeat: r.repeat_zone_points }),
    t("admin.incentives.ruleDeduction"),
    t("admin.incentives.rulePay"),
    t("admin.incentives.ruleAnchor"),
    t("admin.incentives.ruleReset", { hour: hh(r.daily_reset_hour) }),
    ...(r.interplant_round_trip_halving ? [t("admin.incentives.ruleInterplant")] : []),
  ];

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
        {/* ( day's points − daily deduction ) × the truck's rate. The deduction
            sits INSIDE the bracket because that is where it acts — on the day
            total, not on a trip. */}
        <Text style={{ fontSize: 19, fontWeight: "700", color: "#fff", textAlign: "center" }}>
          {t("admin.incentives.formulaOpen")}
          <Text style={{ color: colors.yellow }}>{t("admin.incentives.formulaDayPoints")}</Text>
          {t("admin.incentives.formulaMinus")}
          <Text style={{ color: colors.yellow }}>{t("admin.incentives.formulaDeduction")}</Text>
          {t("admin.incentives.formulaClose")}
        </Text>
        <Text style={{ fontSize: font.md, marginTop: 8, color: "rgba(255,255,255,0.85)", textAlign: "center" }}>
          {t("admin.incentives.formulaNote")}
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
                  {t("admin.incentives.peakCardTitle")}
                </Text>
                <Text style={{ fontSize: font.md, color: colors.textMuted, marginTop: 4 }}>
                  {t("admin.incentives.peakCardBody", { start: peakStart, end: peakEnd })}
                </Text>
              </View>
              <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.md, padding: 14 }}>
                <Text style={{ fontSize: font.sm, color: colors.amber, fontWeight: "700", textTransform: "uppercase" }}>
                  {t("admin.incentives.offPeakCardTitle")}
                </Text>
                <Text style={{ fontSize: font.md, color: colors.textMuted, marginTop: 4 }}>
                  {t("admin.incentives.offPeakCardBody", { start: peakStart, end: peakEnd })}
                </Text>
              </View>
              {/* Which of the two is HIGHER is per-truck (off-peak usually, but
                  not universally), so the panel points at the rate table
                  instead of asserting it. */}
              <Text style={{ fontSize: font.sm, color: colors.textFaint, marginTop: 2 }}>
                {t("admin.incentives.ratesPerTruckNote")}
              </Text>
            </View>
          </Card>
        </View>
      </View>
    </View>
  );
}

// Frame 9's truck card: navy identity band, rates beneath. Mirrors
// TrucksScreen's idBand so the two screens read as one family.
const rateCard = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" },
  idBand: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.navy, paddingHorizontal: 12, paddingVertical: 12 },
  idPlate: { fontSize: font.lg, fontWeight: "800", letterSpacing: 0.4, color: "#fff" },
  idMeta: { fontSize: font.xs, color: "#c9d6f0", marginTop: 1 },
  bandEdit: {
    flexShrink: 0,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderRadius: radius.sm,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  bandEditText: { color: "#fff", fontSize: font.sm, fontWeight: "700" },
});
