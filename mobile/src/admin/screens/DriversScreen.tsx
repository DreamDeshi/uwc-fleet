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
import {
  useAssignDriverTruck,
  useCreateDriver,
  useDepartments,
  useDrivers,
  useDriverPerformance,
  useSetDriverStatus,
  useTrucks,
} from "../hooks/queries";
import { colors, font, radius } from "../theme";
import {
  Avatar,
  Button,
  Card,
  ChipGrid,
  ConfirmDialog,
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
import { formatMoney } from "../lib/format";
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { OptionsModal } from "../../components/OptionsModal";
import type { DriverPerf, DriverPerformance, DriverStatus, Truck } from "../types";

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
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<DriverPerf | null>(null);

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
      {/* Filters left, search + Add on the right — one row on wide. Add a
          driver = create account + optionally bind a truck. */}
      {(() => {
        const filterOptions = [
          { value: "all" as Filter, label: t("admin.drivers.filterAll"), count: counts.all },
          { value: "on_trip" as Filter, label: t("admin.drivers.statusOnTrip"), count: counts.on_trip },
          { value: "available" as Filter, label: t("admin.drivers.statusAvailable"), count: counts.available },
          { value: "off_duty" as Filter, label: t("admin.drivers.statusOffDuty"), count: counts.off_duty },
        ];
        const addBtn = (
          <Button variant="primary" size="sm" onPress={() => setAdding(true)}>
            {`+ ${t("admin.drivers.addDriver")}`}
          </Button>
        );
        return wide ? (
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <SegmentedFilter<Filter> value={filter} onChange={setFilter} options={filterOptions} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <SearchInput value={search} onChange={setSearch} placeholder={t("admin.drivers.searchPlaceholder")} />
              {addBtn}
            </View>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>{addBtn}</View>
            <ChipGrid<Filter> value={filter} onChange={setFilter} options={filterOptions} columns={2} />
            <SearchInput value={search} onChange={setSearch} placeholder={t("admin.drivers.searchPlaceholder")} style={{ minWidth: 0, alignSelf: "stretch" }} />
          </View>
        );
      })()}

      {filtered.length === 0 ? (
        <Card>
          <EmptyState message={t("admin.drivers.noMatch")} />
        </Card>
      ) : (
        // Wide: the web admin's 2-column card grid; narrow: single column.
        <View style={{ flexDirection: wide ? "row" : "column", flexWrap: wide ? "wrap" : "nowrap", gap: 16 }}>
          {filtered.map((d) => (
            <View key={d.id} style={wide ? { width: "48.9%", flexGrow: 1 } : undefined}>
              <DriverCard driver={d} perf={perfById.get(d.id)} onManage={() => setManaging(d)} />
            </View>
          ))}
        </View>
      )}

      {adding ? <AddDriverModal onClose={() => setAdding(false)} /> : null}
      {managing ? <ManageDriverModal driver={managing} onClose={() => setManaging(null)} /> : null}
    </ScrollView>
  );
}

function DriverCard({ driver: d, perf, onManage }: { driver: DriverPerf; perf?: DriverPerformance; onManage: () => void }) {
  const { t } = useTranslation();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const mode = useLayoutMode();
  const meta = STATUS_META[d.status];
  const disabled = d.account_status === "disabled";
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
        {disabled ? (
          <Pill bg={colors.redTint} fg={colors.red} dot={colors.red}>
            {t("admin.users.statusDisabled")}
          </Pill>
        ) : (
          <Pill bg={meta.bg} fg={meta.fg} dot={meta.dot}>
            {t(meta.labelKey)}
          </Pill>
        )}
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

      <View style={{ marginTop: 14 }}>
        <Button variant="outline" size="sm" full onPress={onManage}>
          {t("admin.drivers.manage")}
        </Button>
      </View>
    </Card>
  );
}

function Stat({ label, value, divider }: { label: string; value: string; divider?: boolean }) {
  return (
    <View style={{ flex: 1, paddingVertical: 10, paddingHorizontal: 8, borderLeftWidth: divider ? 1 : 0, borderLeftColor: colors.divider, alignItems: "center" }}>
      <Text numberOfLines={1} style={{ fontSize: 15, fontWeight: "700", color: colors.text }}>{value}</Text>
      {/* Two-line wrap beats "TRIPS (TOT…" on phones. */}
      <Text numberOfLines={2} style={{ fontSize: 12, color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 2, textAlign: "center" }}>
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
        <Text style={{ fontSize: 12, fontWeight: "700", opacity: 0.75 }}>/100</Text>
      </Text>
    </Pressable>
  );
}

// ── Fleet CRUD: add / manage a driver ───────────────────────────────────
const SECTION = { fontSize: font.md, fontWeight: "800" as const, color: colors.text, marginTop: 18, marginBottom: 10 };

function Banner({ text, kind }: { text: string; kind: "error" | "success" }) {
  const c = kind === "error" ? colors.red : colors.green;
  return (
    <View style={{ backgroundColor: `${c}14`, borderRadius: radius.md, padding: 11, marginBottom: 12 }}>
      <Text style={{ color: c, fontSize: font.sm, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}

function PickerField({ label, value, placeholder, onPress }: { label: string; value: string | null; placeholder: string; onPress: () => void }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 6, color: colors.text }}>{label}</Text>
      <Pressable
        onPress={onPress}
        style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 11, paddingHorizontal: 13, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}
      >
        <Text style={{ fontSize: font.md, color: value ? colors.text : colors.textFaint }}>{value ?? placeholder}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

// Free trucks a driver can be bound to: no current driver, not retired.
function freeTrucksOf(trucks: Truck[] | undefined): Truck[] {
  return (trucks ?? []).filter((tr) => !tr.driver && !tr.retired_at);
}

function AddDriverModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const departments = useDepartments();
  const trucks = useTrucks();
  const create = useCreateDriver();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [employeeNo, setEmployeeNo] = useState("");
  const [password, setPassword] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [plate, setPlate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deptPicker, setDeptPicker] = useState(false);
  const [truckPicker, setTruckPicker] = useState(false);

  const freeTrucks = freeTrucksOf(trucks.data);
  const deptName = departments.data?.find((d) => d.id === departmentId)?.name ?? null;

  async function submit() {
    setError(null);
    if (!name.trim() || !phone.trim() || !employeeNo.trim() || password.length < 6 || !departmentId) {
      setError(t("admin.drivers.createValidation"));
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        phone: phone.trim(),
        employee_number: employeeNo.trim(),
        password,
        department_id: departmentId,
        ...(plate ? { assigned_truck_plate: plate } : {}),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.drivers.createFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.drivers.addDriverTitle")} width={480}>
      {error ? <Banner text={error} kind="error" /> : null}
      <Input label={t("admin.drivers.fieldName")} value={name} onChange={setName} />
      <Input label={t("admin.drivers.fieldPhone")} value={phone} onChange={setPhone} placeholder="12-345 6789" />
      <Input label={t("admin.drivers.fieldEmployeeNo")} value={employeeNo} onChange={setEmployeeNo} />
      <Input label={t("admin.drivers.fieldPassword")} value={password} onChange={setPassword} />
      <PickerField label={t("admin.drivers.fieldDepartment")} value={deptName} placeholder={t("admin.drivers.fieldDepartment")} onPress={() => setDeptPicker(true)} />
      <PickerField label={t("admin.drivers.fieldTruck")} value={plate} placeholder={t("admin.drivers.assignLater")} onPress={() => setTruckPicker(true)} />
      <Button variant="primary" full disabled={create.isPending} onPress={submit}>
        {create.isPending ? t("admin.drivers.creating") : t("admin.drivers.create")}
      </Button>

      <OptionsModal
        visible={deptPicker}
        title={t("admin.drivers.fieldDepartment")}
        options={(departments.data ?? []).map((d) => ({ label: d.name, value: d.id }))}
        selectedValue={departmentId}
        onSelect={setDepartmentId}
        onClose={() => setDeptPicker(false)}
      />
      <OptionsModal
        visible={truckPicker}
        title={t("admin.drivers.fieldTruck")}
        options={[
          { label: t("admin.drivers.assignLater"), value: "" },
          ...freeTrucks.map((tr) => ({ label: `${tr.plate} · ${tr.type}`, value: tr.plate })),
        ]}
        selectedValue={plate ?? ""}
        onSelect={(v) => setPlate(v || null)}
        onClose={() => setTruckPicker(false)}
      />
    </Modal>
  );
}

function ManageDriverModal({ driver, onClose }: { driver: DriverPerf; onClose: () => void }) {
  const { t } = useTranslation();
  const trucks = useTrucks();
  const assignTruck = useAssignDriverTruck();
  const setStatus = useSetDriverStatus();

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [truckPicker, setTruckPicker] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);

  const disabled = driver.account_status === "disabled";
  const freeTrucks = freeTrucksOf(trucks.data);
  const clear = () => {
    setError(null);
    setNotice(null);
  };

  const changeTruck = (plate: string | null) => {
    clear();
    assignTruck.mutate(
      { id: driver.id, plate },
      {
        onSuccess: () => setNotice(t("admin.drivers.truckUpdated")),
        onError: (e) => setError(apiErrorMessage(e, t("admin.drivers.truckUpdateFailed"))),
      }
    );
  };
  const changeStatus = (status: "active" | "disabled") => {
    clear();
    setStatus.mutate(
      { id: driver.id, status },
      {
        onSuccess: () => {
          setNotice(status === "active" ? t("admin.drivers.reactivatedNotice") : t("admin.drivers.retiredNotice"));
          setConfirmRetire(false);
        },
        onError: (e) => {
          setError(apiErrorMessage(e, t("common.errorGeneric")));
          setConfirmRetire(false);
        },
      }
    );
  };

  return (
    <Modal open onClose={onClose} title={t("admin.drivers.manageTitle", { name: driver.name })} width={480}>
      {error ? <Banner text={error} kind="error" /> : null}
      {notice ? <Banner text={notice} kind="success" /> : null}

      {/* Assigned truck */}
      <Text style={SECTION}>{t("admin.drivers.sectionTruck")}</Text>
      <Text style={{ fontSize: font.md, color: colors.textMuted, marginBottom: 12 }}>
        {driver.assigned_truck ? t("admin.drivers.currentTruck", { plate: driver.assigned_truck.plate }) : t("admin.drivers.noTruck")}
      </Text>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Button variant="outline" size="sm" disabled={assignTruck.isPending || freeTrucks.length === 0} onPress={() => setTruckPicker(true)}>
          {t("admin.drivers.changeTruck")}
        </Button>
        {driver.assigned_truck ? (
          <Button variant="ghost" size="sm" disabled={assignTruck.isPending} onPress={() => changeTruck(null)}>
            {t("admin.drivers.freeTruck")}
          </Button>
        ) : null}
      </View>
      {freeTrucks.length === 0 && !driver.assigned_truck ? (
        <Text style={{ fontSize: font.sm, color: colors.textFaint, marginTop: 8 }}>{t("admin.drivers.noFreeTrucks")}</Text>
      ) : null}

      {/* Account status */}
      <Text style={SECTION}>{t("admin.drivers.sectionAccount")}</Text>
      {disabled ? (
        <>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginBottom: 10 }}>{t("admin.drivers.statusRetiredNote")}</Text>
          <Button variant="success" size="sm" disabled={setStatus.isPending} onPress={() => changeStatus("active")}>
            {t("admin.drivers.reactivate")}
          </Button>
        </>
      ) : (
        <Button variant="danger" size="sm" disabled={setStatus.isPending} onPress={() => setConfirmRetire(true)}>
          {t("admin.drivers.retire")}
        </Button>
      )}

      <OptionsModal
        visible={truckPicker}
        title={t("admin.drivers.changeTruck")}
        options={freeTrucks.map((tr) => ({ label: `${tr.plate} · ${tr.type}`, value: tr.plate }))}
        selectedValue={driver.assigned_truck?.plate ?? ""}
        onSelect={(v) => changeTruck(v)}
        onClose={() => setTruckPicker(false)}
      />

      {confirmRetire ? (
        <ConfirmDialog
          title={t("admin.drivers.retireTitle")}
          body={t("admin.drivers.retireBody", { name: driver.name })}
          confirmLabel={t("admin.drivers.retire")}
          pending={setStatus.isPending}
          onClose={() => setConfirmRetire(false)}
          onConfirm={() => changeStatus("disabled")}
        />
      ) : null}
    </Modal>
  );
}
