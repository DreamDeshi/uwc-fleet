// Public-holiday manager — the admin-maintained calendar that drives the
// weekday/off-peak rate decision. Extracted from IncentivesScreen (2026-07-19)
// when holidays + driver leave were gathered onto a single Calendar screen.
// The data/hooks/logic are unchanged — only the location moved.
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAddHoliday, useDeleteHoliday, useHolidays } from "../hooks/queries";
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
import { apiErrorMessage } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import type { PublicHoliday } from "../types";

export function HolidaysPanel({ prefillDate }: { prefillDate?: string } = {}) {
  const { t } = useTranslation();
  const narrow = useLayoutMode() === "narrow";
  const holidays = useHolidays();
  const [deleting, setDeleting] = useState<PublicHoliday | null>(null);

  if (holidays.isLoading) return <Loading />;
  if (holidays.isError) return <ErrorState message={t("admin.incentives.holidaysLoadError")} onRetry={() => holidays.refetch()} />;

  const rows = holidays.data!;
  const weekdayName = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-MY", { weekday: "long", timeZone: "UTC" });
  };

  return (
    <View style={{ gap: 16 }}>
      {/* Off-peak-rate explainer — desktop context, trimmed on phones. */}
      {!narrow && (
        <View style={{ backgroundColor: colors.yellowTint, borderRadius: radius.md, paddingVertical: 11, paddingHorizontal: 15 }}>
          <Text style={{ fontSize: font.sm, color: colors.amber, fontWeight: "500" }}>{t("admin.incentives.holidayBanner")}</Text>
        </View>
      )}
      <AddHolidayForm prefillDate={prefillDate} />
      <Card pad={0}>
        <View style={{ padding: narrow ? 14 : 18, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <SectionTitle title={t("admin.incentives.holidayCalTitle")} subtitle={t("admin.incentives.holidayCalSub", { count: rows.length })} />
        </View>
        {rows.length === 0 ? (
          <Text style={{ padding: 24, fontSize: font.md, color: colors.textMuted }}>{t("admin.incentives.holidayEmpty")}</Text>
        ) : narrow ? (
          // TABLE→CARD: name on top, date · weekday beneath, Remove inline.
          <View>
            {rows.map((h, i) => (
              <View
                key={h.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 14,
                  borderBottomWidth: i < rows.length - 1 ? 1 : 0,
                  borderBottomColor: colors.divider,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={{ fontSize: font.md, fontWeight: "600", color: colors.text }}>{h.name}</Text>
                  <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 1 }}>
                    {h.date} · {weekdayName(h.date)}
                  </Text>
                </View>
                <Button variant="ghost" size="sm" onPress={() => setDeleting(h)}>
                  {t("admin.drivers.remove")}
                </Button>
              </View>
            ))}
          </View>
        ) : (
          <View>
            <TableHeader style={{ borderRadius: 0 }}>
              <TableCell flex={1} header>{t("admin.trucks.colDate")}</TableCell>
              <TableCell flex={1} header>{t("admin.incentives.colDay")}</TableCell>
              <TableCell flex={1.8} header>{t("admin.incentives.colHoliday")}</TableCell>
              <TableCell flex={0.8} header>{""}</TableCell>
            </TableHeader>
            {rows.map((h) => (
              <TableRow key={h.id}>
                <TableCell flex={1} textStyle={{ fontWeight: "700" }}>{h.date}</TableCell>
                <TableCell flex={1}>{weekdayName(h.date)}</TableCell>
                <TableCell flex={1.8}>{h.name}</TableCell>
                <TableCell flex={0.8}>
                  <Button variant="ghost" size="sm" onPress={() => setDeleting(h)} style={{ alignSelf: "flex-end" }}>
                    {t("admin.drivers.remove")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </View>
        )}
      </Card>
      {deleting && <DeleteHolidayConfirm holiday={deleting} onClose={() => setDeleting(null)} />}
    </View>
  );
}

function AddHolidayForm({ prefillDate }: { prefillDate?: string }) {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useAddHoliday();
  const wide = mode === "wide";

  // Seed the date when a day is tapped in the calendar grid above.
  useEffect(() => {
    if (prefillDate) setDate(prefillDate);
  }, [prefillDate]);

  async function submit() {
    setError(null);
    if (!date || !name.trim()) {
      setError(t("admin.incentives.holidayValidation"));
      return;
    }
    try {
      await add.mutateAsync({ date, name: name.trim() });
      setDate("");
      setName("");
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentives.holidayAddFailed")));
    }
  }

  return (
    <Card>
      <SectionTitle title={t("admin.incentives.addHolidayTitle")} />
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <View style={{ flexDirection: wide ? "row" : "column", gap: 10, alignItems: wide ? "flex-end" : "stretch" }}>
        <View style={wide ? { width: 190 } : undefined}>
          <DateField label={t("admin.trucks.colDate")} value={date} onChange={setDate} />
        </View>
        <View style={wide ? { flex: 1 } : undefined}>
          <Input label={t("admin.incentives.holidayName")} value={name} onChange={setName} placeholder={t("admin.incentives.holidayPlaceholder")} />
        </View>
        <View style={wide ? { marginBottom: 14 } : undefined}>
          <Button variant="primary" onPress={submit} disabled={add.isPending} full={!wide}>
            {add.isPending ? t("admin.drivers.adding") : t("admin.incentives.add")}
          </Button>
        </View>
      </View>
    </Card>
  );
}

// Removing a holiday flips that date's not-yet-finalized trips back to the
// weekday rate — ask before firing. Completed trips keep their stored pay.
function DeleteHolidayConfirm({ holiday, onClose }: { holiday: PublicHoliday; onClose: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const del = useDeleteHoliday();

  async function doDelete() {
    setError(null);
    try {
      await del.mutateAsync(holiday.id);
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.incentives.holidayRemoveFailed")));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("admin.incentives.removeHolidayTitle")} width={420}>
      {error && (
        <View style={{ backgroundColor: colors.redTint, borderRadius: radius.md, paddingVertical: 9, paddingHorizontal: 12, marginBottom: 12 }}>
          <Text style={{ color: colors.red, fontSize: font.sm }}>{error}</Text>
        </View>
      )}
      <Text style={{ fontSize: font.md, color: colors.text, lineHeight: 22, marginBottom: 14 }}>
        {t("admin.incentives.removeHolidayBody", { name: holiday.name, date: holiday.date })}
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
