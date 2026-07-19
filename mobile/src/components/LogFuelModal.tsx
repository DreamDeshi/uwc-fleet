// Driver fuel fill-up form. The truck is fixed to the driver's assigned truck.
// Extracted from ProfileScreen (2026-07-19) when fuel logging moved to the
// driver Home as a quick-action — a driver logs a fill-up often, so it belongs
// on the dashboard, not buried in Settings. Self-contained; shared so any
// driver surface can open it.
import React, { useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { Button } from "./Button";
import { TextField } from "./Field";
import { useToast } from "./Toast";
import { useLogFuel, useMyTruckFuel } from "../hooks/queries";
import { apiErrorMessage } from "../services/api";
import { formatDate, formatMoney } from "../lib/format";

export function LogFuelModal({
  visible,
  onClose,
  truckPlate,
  truckLabel,
}: {
  visible: boolean;
  onClose: () => void;
  truckPlate: string | null;
  truckLabel: string | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const logFuel = useLogFuel();
  // Recent fills + efficiency for this truck (display only). Fetched while the
  // modal is open so a just-logged fill shows immediately (mutation invalidates).
  const fuel = useMyTruckFuel(visible ? truckPlate : null);
  const recent = (fuel.data?.logs ?? []).slice(0, 3);
  const eff = fuel.data?.summary;
  const [litres, setLitres] = useState("");
  const [cost, setCost] = useState("");
  const [odometer, setOdometer] = useState("");

  const submit = () => {
    if (!truckPlate) {
      toast(t("fuel.noTruck"), "error");
      return;
    }
    const litresN = Number(litres);
    const costN = Number(cost);
    const odoN = Number(odometer);
    if (!(litresN > 0) || !(costN > 0) || !(odoN > 0)) {
      toast(t("fuel.invalid"), "error");
      return;
    }
    logFuel.mutate(
      { plate: truckPlate, litres: litresN, cost_rm: costN, odometer_km: odoN },
      {
        onSuccess: () => {
          setLitres("");
          setCost("");
          setOdometer("");
          onClose();
          toast(t("fuel.saved"), "success");
        },
        onError: (err) => toast(apiErrorMessage(err, t("fuel.error")), "error"),
      }
    );
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.modal}>
          <Text style={styles.modalTitle}>{t("fuel.title")}</Text>

          <View style={styles.truckBox}>
            <MaterialCommunityIcons name="truck" size={16} color={colors.blue} />
            <Text style={styles.truckBoxText}>{truckLabel ?? t("fuel.noTruck")}</Text>
          </View>

          <View style={{ marginTop: 16 }}>
            <TextField
              label={t("fuel.litres")}
              keyboardType="decimal-pad"
              value={litres}
              onChangeText={setLitres}
              placeholder={t("fuel.litresPlaceholder")}
              leftIcon="water-outline"
            />
            <TextField
              label={t("fuel.cost")}
              keyboardType="decimal-pad"
              value={cost}
              onChangeText={setCost}
              placeholder={t("fuel.costPlaceholder")}
              leftIcon="cash-outline"
            />
            <TextField
              label={t("fuel.odometer")}
              keyboardType="number-pad"
              value={odometer}
              onChangeText={setOdometer}
              placeholder={t("fuel.odometerPlaceholder")}
              leftIcon="speedometer-outline"
            />
          </View>

          <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
            <Button title={t("common.cancel")} variant="outline" onPress={onClose} style={{ flex: 1 }} />
            <Button
              title={t("fuel.submit")}
              onPress={submit}
              loading={logFuel.isPending}
              disabled={!truckPlate}
              style={{ flex: 1 }}
            />
          </View>

          {/* Recent fills + efficiency (display only — never touches pay). */}
          {recent.length > 0 && (
            <View style={styles.history}>
              <View style={styles.historyHead}>
                <Text style={styles.historyTitle}>{t("fuel.recentTitle")}</Text>
                {eff?.litres_per_100km != null ? (
                  <Text style={styles.effText}>{t("fuel.efficiency", { l: eff.litres_per_100km.toFixed(1) })}</Text>
                ) : null}
              </View>
              {recent.map((l) => (
                <View key={l.id} style={styles.histRow}>
                  <Text style={styles.histDate}>{formatDate(l.logged_at)}</Text>
                  <Text style={styles.histMeta} numberOfLines={1}>
                    {t("fuel.litresShort", { n: l.liters })} · {formatMoney(l.cost)}
                    {l.odometer != null ? ` · ${l.odometer} km` : ""}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: colors.white, borderRadius: 20, padding: 24, width: "100%" },
  modalTitle: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
  truckBox: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 16, backgroundColor: colors.tintBlue, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12 },
  truckBoxText: { color: colors.blue, fontSize: 14, fontWeight: "700" },

  history: { marginTop: 18, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 14 },
  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  historyTitle: { fontSize: 13, fontWeight: "800", color: colors.navy, textTransform: "uppercase", letterSpacing: 0.4 },
  effText: { fontSize: 12, fontWeight: "700", color: colors.blue },
  histRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 5, gap: 10 },
  histDate: { fontSize: 13, color: colors.textMuted },
  histMeta: { fontSize: 13, fontWeight: "600", color: colors.navy, flexShrink: 1 },
});
