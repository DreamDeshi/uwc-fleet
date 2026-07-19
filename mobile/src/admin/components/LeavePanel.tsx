// Driver-leave manager — date-based availability: a driver on leave for a
// trip's pickup date is excluded from auto-dispatch and blocked in the dispatch
// panel for that date, while keeping their login and their trips on other
// dates. Extracted from DriversScreen (2026-07-19) onto the shared Calendar
// screen. Data/hooks/logic unchanged — only the location moved.
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useAddLeave, useDeleteLeave, useLeaves } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import {
  Button,
  Card,
  ErrorState,
  Input,
  Loading,
  Modal,
  SectionTitle,
  TableCell,
  TableHeader,
  TableRow,
} from "./ui";
import { DateField } from "../platform/datePicker";
import { OptionsModal } from "../../components/OptionsModal";
import { apiErrorMessage } from "../services/api";
import { formatDate } from "../lib/format";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { DriverLeaveEntry, DriverPerf } from "../types";

export function LeavePanel({ drivers }: { drivers: DriverPerf[] }) {
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
        // Narrow: stacked leave rows.
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
