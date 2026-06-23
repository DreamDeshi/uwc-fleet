import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { TextField, PressableField } from "./Field";
import { Button } from "./Button";
import { OptionsModal } from "./OptionsModal";
import { useCreateConsignee } from "../hooks/queries";
import { apiErrorMessage } from "../services/api";
import { Consignee } from "../types";

// The 7 UWC zones (Development Brief §4). Used here and in the booking form.
export const ZONES: { code: string; name: string }[] = [
  { code: "P1", name: "Penang Island" },
  { code: "P2", name: "Juru & Perai" },
  { code: "P3", name: "Tasek Gelugor" },
  { code: "K1", name: "Kulim" },
  { code: "K2", name: "Sungai Petani / Kuala Ketil" },
  { code: "A1", name: "Taiping" },
  { code: "A2", name: "Ipoh" },
];

export function NewConsigneeModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (c: Consignee) => void;
}) {
  const { t } = useTranslation();
  const createConsignee = useCreateConsignee();
  const [company, setCompany] = useState("");
  const [zone, setZone] = useState<string | undefined>();
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [area, setArea] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCompany(""); setZone(undefined); setContact(""); setPhone(""); setArea(""); setError(null);
  };

  const submit = async () => {
    setError(null);
    if (!company.trim() || !zone) {
      setError(t("booking.companyName"));
      return;
    }
    try {
      const c = await createConsignee.mutateAsync({
        company_name: company.trim(),
        zone_code: zone,
        contact_person: contact.trim() || undefined,
        phone: phone.trim() || undefined,
        area: area.trim() || undefined,
      });
      onCreatedDone(c);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const onCreatedDone = (c: Consignee) => {
    onCreated(c);
    reset();
    onClose();
  };

  const zoneName = ZONES.find((z) => z.code === zone)?.name;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>{t("booking.newConsigneeTitle")}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <Ionicons name="close" size={22} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled">
            <TextField label={t("booking.companyName")} value={company} onChangeText={setCompany} placeholder="Sdn Bhd…" />
            <PressableField
              label={t("booking.zone")}
              value={zoneName}
              placeholder={t("register.departmentPlaceholder")}
              onPress={() => setZoneOpen(true)}
            />
            <TextField label={t("booking.contactPerson")} value={contact} onChangeText={setContact} />
            <TextField label={t("booking.phone")} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <TextField label={t("booking.area")} value={area} onChangeText={setArea} />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button
              title={t("booking.addConsigneeBtn")}
              onPress={submit}
              loading={createConsignee.isPending}
              style={{ marginTop: 4, marginBottom: 12 }}
            />
          </ScrollView>
        </View>
      </View>

      <OptionsModal
        visible={zoneOpen}
        title={t("booking.zone")}
        options={ZONES.map((z) => ({ label: `${z.code} — ${z.name}`, value: z.code }))}
        selectedValue={zone}
        onSelect={setZone}
        onClose={() => setZoneOpen(false)}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.white, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: 20, maxHeight: "88%" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  title: { fontSize: 17, fontWeight: "800", color: colors.navy },
  error: { color: colors.red, fontSize: 13, fontWeight: "600", marginBottom: 8 },
});
