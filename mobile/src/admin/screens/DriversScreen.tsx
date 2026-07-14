// Driver Management — RN port of admin/src/pages/DriversPage.tsx (PC-first:
// the wide layout mirrors the old web admin at 1440px; narrow is functional
// single-column, polished in the dedicated mobile pass). Same hooks: driver
// board + performance badges + the leave calendar manager (leave affects
// dispatch availability only — never login).
import React, { useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { useAddLeave, useDeleteLeave, useDrivers, useDriverPerformance, useLeaves } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Modal,
  Pill,
  SearchInput,
  SectionTitle,
  SegmentedFilter,
  TableCell,
  TableHeader,
  TableRow,
} from "../components/ui";
import { DateField } from "../platform/datePicker";
import { formatDate, formatMoney } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { OptionsModal } from "../../components/OptionsModal";
import type { DriverLeaveEntry, DriverPerf, DriverPerformance, DriverStatus } from "../types";

// Driver status wears the same badge language as trip statuses.
const STATUS_META: Record<DriverStatus, { labelKey: string; bg: string; fg: string; dot: string }> = {
  on_trip: { labelKey: "admin.drivers.statusOnTrip", bg: colors.blueTint, fg: colors.blue, dot: "#2563EB" },
  available: { labelKey: "admin.drivers.statusAvailable", bg: colors.greenTint, fg: "#2E7D32", dot: colors.green },
  off_duty: { labelKey: "admin.drivers.statusOffDuty", bg: "#f3f4f6", fg: "#4B5563", dot: "#9CA3AF" },
};

function scoreColor(score: number): { bg: string; fg: string } {
  if (score >= 75) return { bg: colors.greenTint, fg: colors.green };
  if (score >= 50) return { bg: colors.yellowTint, fg: colors.amber };
  return { bg: colors.redTint, fg: colors.red };
}

type Filter = "all" | DriverStatus;

export function DriversScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const drivers = useDrivers();
  const performance = useDriverPerformance();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const perfById = useMemo(() => {
    const map = new Map<string, DriverPerformance>();
    for (const p of performance.data ?? []) map.set(p.id, p);
    return map;
  }, [performance.data]);

  const counts = useMemo(() => {
    const list = drivers.data ?? [];
    return {
      all: list.length,
      on_trip: list.filter((d) => d.status === "on_trip").length,
      available: list.filter((d) => d.status === "available").length,
      off_duty: list.filter((d) => d.status === "off_duty").length,
    };
  }, [drivers.data]);

  if (drivers.isLoading) return <Loading />;
  if (drivers.isError) return <ErrorState message={t("admin.drivers.loadError")} onRetry={() => drivers.refetch()} />;

  const wide = mode === "wide";
  const filtered = (drivers.data ?? [])
    .filter((d) => filter === "all" || d.status === filter)
    .filter((d) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return d.name.toLowerCase().includes(q) || d.phone.includes(q) || (d.assigned_truck?.plate ?? "").toLowerCase().includes(q);
    });

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={wide ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={drivers.isRefetching} onRefresh={() => drivers.refetch()} />}
    >
      {/* Narrow stacks: an unconstrained row lets the chips run off-screen. */}
      <View
        style={
          wide
            ? { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }
            : { flexDirection: "column", alignItems: "stretch", gap: 12 }
        }
      >
        <SegmentedFilter<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("admin.drivers.filterAll"), count: counts.all },
            { value: "on_trip", label: t("admin.drivers.statusOnTrip"), count: counts.on_trip },
            { value: "available", label: t("admin.drivers.statusAvailable"), count: counts.available },
            { value: "off_duty", label: t("admin.drivers.statusOffDuty"), count: counts.off_duty },
          ]}
        />
        <SearchInput value={search} onChange={setSearch} placeholder={t("admin.drivers.searchPlaceholder")} style={!wide && { minWidth: 0, alignSelf: "stretch" }} />
      </View>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.drivers.noMatch")} />
        </Card>
      ) : (
        // Wide: the web admin's 2-column card grid; narrow: single column.
        <View style={{ flexDirection: wide ? "row" : "column", flexWrap: wide ? "wrap" : "nowrap", gap: 16 }}>
          {filtered.map((d) => (
            <View key={d.id} style={wide ? { width: "48.9%", flexGrow: 1 } : undefined}>
              <DriverCard driver={d} perf={perfById.get(d.id)} />
            </View>
          ))}
        </View>
      )}

      <LeaveManager drivers={drivers.data ?? []} />
    </ScrollView>
  );
}

function DriverCard({ driver: d, perf }: { driver: DriverPerf; perf?: DriverPerformance }) {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const mode = useLayoutMode();
  const meta = STATUS_META[d.status];
  // Wide: Performance is a drawer sibling. Narrow: it lives in the MORE
  // tab's stack (bottom-bar shell), pushed with a back button.
  const openPerformance = () =>
    mode === "wide"
      ? navigation.navigate("AdminPerformance")
      : navigation.navigate("AdminMore", { screen: "AdminPerformance", initial: false });
  return (
    <Card style={{ borderLeftWidth: 5, borderLeftColor: meta.dot }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <Avatar name={d.name} size={46} />
        <View style={{ flex: 1, minWidth: 120 }}>
          <Text style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{d.name}</Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted }}>
            {d.phone}
            {d.assigned_truck ? ` · ${d.assigned_truck.plate}` : ""}
          </Text>
        </View>
        {perf && <ScoreBadge perf={perf} onPress={openPerformance} />}
        {/* Leave is date-scoped — a badge alongside status, not a status. */}
        {d.on_leave_today && (
          <Pill bg={colors.yellowTint} fg={colors.amber} dot={colors.orange}>
            {t("admin.drivers.onLeave")}
          </Pill>
        )}
        <Pill bg={meta.bg} fg={meta.fg} dot={meta.dot}>
          {t(meta.labelKey)}
        </Pill>
      </View>

      <View style={{ flexDirection: "row", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.divider, borderRadius: radius.md, overflow: "hidden" }}>
        <Stat label={t("admin.drivers.statTripsTotal")} value={String(d.trips_total)} />
        <Stat label={t("admin.drivers.statThisMonth")} value={String(d.trips_this_month)} divider />
        <Stat label={t("admin.drivers.statEarnedMo")} value={formatMoney(d.incentive_this_month)} divider />
      </View>

      {d.current_route && (
        <View style={{ marginTop: 12, backgroundColor: colors.blueTint, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 12, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name="location-outline" size={12} color={colors.blue} />
          <Text style={{ color: colors.blue, fontSize: font.sm, fontWeight: "600" }}>
            {t("admin.drivers.enRoute", { route: d.current_route })}
          </Text>
        </View>
      )}

      {/* Scheduled (assigned-but-not-started) trips explain an "Available"
          driver who already holds work — only in_progress marks On Trip. */}
      {d.scheduled_trips > 0 && (
        <View style={{ marginTop: d.current_route ? 8 : 12, backgroundColor: colors.panel, borderRadius: radius.pill, paddingVertical: 6, paddingHorizontal: 12, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Ionicons name="calendar-outline" size={12} color={colors.textMuted} />
          <Text style={{ color: colors.textMuted, fontSize: font.sm, fontWeight: "600" }}>
            {t("admin.drivers.scheduledTrips", { count: d.scheduled_trips })}
          </Text>
        </View>
      )}
    </Card>
  );
}

function Stat({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <View style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 8, borderLeftWidth: divider ? 1 : 0, borderLeftColor: colors.divider, alignItems: "center" }}>
      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{value}</Text>
      {/* Two-line wrap beats "TRIPS (TOT…" on phones. */}
      <Text numberOfLines={2} style={{ fontSize: 10.5, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2, textAlign: "center" }}>
        {label}
      </Text>
    </View>
  );
}

// FR-FM7 — clickable performance score badge; grey "No data" until the
// driver has completed trips (never a misleading red 0.0).
function ScoreBadge({ perf, onPress }: { perf: DriverPerformance; onPress: () => void }) {
  const { t } = useTranslation();
  if (perf.total_completed === 0) {
    return (
      <View style={{ backgroundColor: "#f3f4f6", paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill }}>
        <Text style={{ color: "#6b7280", fontSize: font.xs, fontWeight: "700" }}>{t("admin.drivers.noData")}</Text>
      </View>
    );
  }
  const c = scoreColor(perf.total_score);
  return (
    <Pressable onPress={onPress} style={{ backgroundColor: c.bg, paddingVertical: 4, paddingHorizontal: 10, borderRadius: radius.pill }}>
      <Text style={{ color: c.fg, fontSize: font.sm, fontWeight: "800" }}>
        {perf.total_score.toFixed(1)}
        <Text style={{ fontSize: 10.5, fontWeight: "700", opacity: 0.75 }}>/100</Text>
      </Text>
    </Pressable>
  );
}

// ── Driver leave (tracker #4) ─────────────────────────────────────────
// Date-based availability: a driver on leave for a trip's pickup date is
// excluded from auto-dispatch and blocked in the dispatch panel for that
// date, while keeping their login and their trips on other dates.
function LeaveManager({ drivers }: { drivers: DriverPerf[] }) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const leaves = useLeaves();
  const [deleting, setDeleting] = useState<DriverLeaveEntry | null>(null);
  const wide = mode === "wide";

  return (
    <Card pad={0}>
      <View style={{ padding: 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <SectionTitle title={t("admin.drivers.leaveTitle")} subtitle={t("admin.drivers.leaveSub")} />
        <AddLeaveForm drivers={drivers} />
      </View>
      {leaves.isLoading ? (
        <View style={{ padding: 18 }}>
          <Loading />
        </View>
      ) : leaves.isError ? (
        <View style={{ padding: 18 }}>
          <ErrorState message={t("admin.drivers.leaveLoadError")} onRetry={() => leaves.refetch()} />
        </View>
      ) : (leaves.data ?? []).length === 0 ? (
        <Text style={{ padding: 20, fontSize: font.md, color: colors.textMuted }}>{t("admin.drivers.leaveEmpty")}</Text>
      ) : wide ? (
        // Wide: the web admin's leave table.
        <View>
          <TableHeader style={{ borderRadius: 0 }}>
            <TableCell flex={1.6} header>{t("admin.drivers.colDriver")}</TableCell>
            <TableCell flex={1} header>{t("admin.drivers.from")}</TableCell>
            <TableCell flex={1} header>{t("admin.drivers.colTo")}</TableCell>
            <TableCell flex={1.4} header>{t("admin.drivers.colNote")}</TableCell>
            <TableCell flex={0.8} header>{""}</TableCell>
          </TableHeader>
          {leaves.data!.map((l) => (
            <TableRow key={l.id}>
              <TableCell flex={1.6}>
                <Text style={{ fontSize: font.md, color: colors.text }}>
                  <Text style={{ fontWeight: "700" }}>{l.driver.name}</Text>
                  {l.driver.assigned_truck_plate ? ` · ${l.driver.assigned_truck_plate}` : ""}
                </Text>
              </TableCell>
              <TableCell flex={1}>{formatDate(l.start_date)}</TableCell>
              <TableCell flex={1}>{l.end_date === l.start_date ? "—" : formatDate(l.end_date)}</TableCell>
              <TableCell flex={1.4} textStyle={{ color: colors.textMuted }}>{l.note ?? ""}</TableCell>
              <TableCell flex={0.8}>
                <Button variant="ghost" size="sm" onPress={() => setDeleting(l)} style={{ alignSelf: "flex-end" }}>
                  {t("admin.drivers.remove")}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </View>
      ) : (
        // Narrow (functional, pre-polish): stacked leave rows.
        <View>
          {leaves.data!.map((l, i) => (
            <View
              key={l.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 12,
                paddingHorizontal: 16,
                borderBottomWidth: i === leaves.data!.length - 1 ? 0 : 1,
                borderBottomColor: colors.divider,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>
                  {l.driver.name}
                  {l.driver.assigned_truck_plate ? ` · ${l.driver.assigned_truck_plate}` : ""}
                </Text>
                <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
                  {l.end_date === l.start_date ? formatDate(l.start_date) : `${formatDate(l.start_date)} – ${formatDate(l.end_date)}`}
                  {l.note ? ` · ${l.note}` : ""}
                </Text>
              </View>
              <Button variant="ghost" size="sm" onPress={() => setDeleting(l)}>
                {t("admin.drivers.remove")}
              </Button>
            </View>
          ))}
        </View>
      )}
      {deleting && <DeleteLeaveConfirm leave={deleting} onClose={() => setDeleting(null)} />}
    </Card>
  );
}

function AddLeaveForm({ drivers }: { drivers: DriverPerf[] }) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [driverId, setDriverId] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const add = useAddLeave();
  const wide = mode === "wide";

  const selected = drivers.find((d) => d.id === driverId);

  async function submit() {
    setError(null);
    if (!driverId || !start) {
      setError(t("admin.drivers.addLeaveValidation"));
      return;
    }
    try {
      await add.mutateAsync({
        driver_id: driverId,
        start_date: start,
        end_date: end || undefined,
        note: note.trim() || undefined,
      });
      setDriverId("");
      setStart("");
      setEnd("");
      setNote("");
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.drivers.addLeaveFailed")));
    }
  }

  return (
    <View style={{ marginTop: 12 }}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 10 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <View style={{ flexDirection: wide ? "row" : "column", gap: 10, alignItems: wide ? "flex-end" : "stretch", flexWrap: "wrap" }}>
        <View style={wide ? { minWidth: 220 } : undefined}>
          <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 6, color: colors.text }}>{t("admin.drivers.colDriver")}</Text>
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
              marginBottom: wide ? 14 : 0,
            }}
          >
            <Text style={{ fontSize: font.md, color: selected ? colors.text : colors.textFaint }}>
              {selected ? `${selected.name}${selected.assigned_truck ? ` (${selected.assigned_truck.plate})` : ""}` : t("admin.drivers.selectDriver")}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
        <View style={wide ? { width: 170 } : undefined}>
          <DateField label={t("admin.drivers.from")} value={start} onChange={setStart} />
        </View>
        <View style={wide ? { width: 170 } : undefined}>
          <DateField label={t("admin.drivers.toOptional")} value={end} onChange={setEnd} />
        </View>
        <View style={wide ? { flex: 1, minWidth: 160 } : undefined}>
          <Input label={t("admin.drivers.noteOptional")} value={note} onChange={setNote} placeholder={t("admin.drivers.notePlaceholder")} />
        </View>
        <View style={wide ? { marginBottom: 14 } : undefined}>
          <Button variant="primary" onPress={submit} disabled={add.isPending} full={!wide}>
            {add.isPending ? t("admin.drivers.adding") : t("admin.drivers.addLeave")}
          </Button>
        </View>
      </View>
      <OptionsModal
        visible={pickerOpen}
        title={t("admin.drivers.colDriver")}
        options={drivers.map((d) => ({
          label: `${d.name}${d.assigned_truck ? ` (${d.assigned_truck.plate})` : ""}`,
          value: d.id,
        }))}
        selectedValue={driverId}
        onSelect={setDriverId}
        onClose={() => setPickerOpen(false)}
      />
    </View>
  );
}

// Removing leave puts the driver straight back into the dispatch pool for
// those dates — confirm before firing (audit-logged server-side).
function DeleteLeaveConfirm({ leave, onClose }: { leave: DriverLeaveEntry; onClose: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const del = useDeleteLeave();

  async function doDelete() {
    setError(null);
    try {
      await del.mutateAsync(leave.id);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.drivers.removeFailed")));
    }
  }

  const range =
    leave.end_date === leave.start_date
      ? formatDate(leave.start_date)
      : `${formatDate(leave.start_date)} – ${formatDate(leave.end_date)}`;

  return (
    <Modal open onClose={onClose} title={t("admin.drivers.removeTitle")} width={420}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <Text style={{ fontSize: font.md, color: colors.text, lineHeight: 22, marginBottom: 14 }}>
        {t("admin.drivers.removeBody", { name: leave.driver.name, range })}
      </Text>
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button variant="ghost" onPress={onClose} disabled={del.isPending} style={{ flex: 1 }}>
          {t("common.cancel")}
        </Button>
        <Button variant="danger" onPress={doDelete} disabled={del.isPending} style={{ flex: 1 }}>
          {del.isPending ? t("admin.drivers.removing") : t("admin.drivers.remove")}
        </Button>
      </View>
    </Modal>
  );
}
