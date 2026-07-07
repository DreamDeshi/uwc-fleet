import React, { useState } from "react";
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { colors, radius } from "../theme";
import { TextField, PressableField } from "./Field";
import { Button } from "./Button";
import { OptionsModal } from "./OptionsModal";
import { useCreateConsignee } from "../hooks/queries";
import { apiErrorCandidates, apiErrorCode, apiErrorMessage, SimilarConsignee } from "../services/api";
import { useToast } from "./Toast";
import { Consignee } from "../types";

// UWC zones (Development Brief §4 + long-haul Johor/Selangor per spec REQUESTOR
// INTERFACE). Used here and in the booking form.
export function zoneLabel(code: string): string {
  const name = ZONES.find((z) => z.code === code)?.name;
  return name ? `${code} — ${name}` : code;
}

export const ZONES: { code: string; name: string }[] = [
  { code: "P1", name: "Penang Island" },
  { code: "P2", name: "Juru & Perai" },
  { code: "P3", name: "Tasek Gelugor" },
  { code: "K1", name: "Kulim" },
  { code: "K2", name: "Sungai Petani / Kuala Ketil" },
  { code: "A1", name: "Taiping" },
  { code: "A2", name: "Ipoh" },
  { code: "JH", name: "Johor" },
  { code: "SL", name: "Selangor" },
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
  const toast = useToast();
  const createConsignee = useCreateConsignee();
  const [company, setCompany] = useState("");
  const [zone, setZone] = useState<string | undefined>();
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [area, setArea] = useState("");
  const [stateName, setStateName] = useState("");
  const [postcode, setPostcode] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 409 SIMILAR_EXISTS candidates ("did you mean?") — the requestor can tap an
  // existing entry instead of creating a near-duplicate, or create anyway.
  const [similar, setSimilar] = useState<SimilarConsignee[] | null>(null);

  const reset = () => {
    setCompany(""); setZone(undefined); setContact(""); setPhone(""); setArea("");
    setStateName(""); setPostcode(""); setError(null); setSimilar(null);
  };

  const submit = async (force = false) => {
    setError(null);
    if (!force) setSimilar(null);
    if (!company.trim() || !zone) {
      setError(t("booking.consigneeRequired"));
      return;
    }
    try {
      const c = await createConsignee.mutateAsync({
        company_name: company.trim(),
        zone_code: zone,
        contact_person: contact.trim() || undefined,
        phone: phone.trim() || undefined,
        area: area.trim() || undefined,
        // State + postcode enrich search/dedupe and give the admin a locality
        // datum to sanity-check the guessed zone against (audit 4.4).
        state: stateName.trim() || undefined,
        postal_code: postcode.trim() || undefined,
        force,
      });
      onCreatedDone(c);
    } catch (err) {
      if (apiErrorCode(err) === "SIMILAR_EXISTS") {
        setSimilar(apiErrorCandidates(err));
        return;
      }
      setError(apiErrorMessage(err));
    }
  };

  // Tapping a candidate uses the EXISTING consignee (no duplicate created).
  const useExisting = (c: SimilarConsignee) => {
    onCreatedDone({
      id: c.id,
      company_name: c.company_name,
      area: c.area,
      state: c.state,
      zone_code: c.zone_code,
    });
  };

  const onCreatedDone = (c: Consignee) => {
    onCreated(c);
    toast(t("booking.consigneeAdded"), "success");
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
            {/* The zone drives BOTH auto-dispatch and driver pay, chosen by the
                one persona who doesn't know what a zone is — so the field must
                say what it wants (the old placeholder wrongly reused the
                department picker's copy) and echo the code + area name. */}
            <PressableField
              label={t("booking.zone")}
              value={zone ? `${zone} — ${zoneName}` : undefined}
              placeholder={t("booking.zonePlaceholder")}
              onPress={() => setZoneOpen(true)}
            />
            <Text style={styles.zoneHint}>{t("booking.zoneHint")}</Text>
            <TextField label={t("booking.contactPerson")} value={contact} onChangeText={setContact} />
            <TextField label={t("booking.phone")} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <TextField label={t("booking.area")} value={area} onChangeText={setArea} />
            <TextField label={t("booking.state")} value={stateName} onChangeText={setStateName} />
            <TextField
              label={t("booking.postalCode")}
              value={postcode}
              onChangeText={setPostcode}
              keyboardType="number-pad"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {similar && similar.length > 0 && (
              <View style={styles.similarBox}>
                <Text style={styles.similarTitle}>{t("booking.similarTitle")}</Text>
                {similar.map((c) => (
                  <TouchableOpacity key={c.id} style={styles.similarRow} onPress={() => useExisting(c)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.similarName}>{c.company_name}</Text>
                      <Text style={styles.similarSub}>
                        {/* Human-readable zone ("K1 — Kulim"), not the bare code a
                            requestor can't evaluate when deciding "is this mine?". */}
                        {[c.area, c.state, zoneLabel(c.zone_code)].filter(Boolean).join(" · ")}
                      </Text>
                    </View>
                    <Text style={styles.similarUse}>{t("booking.similarUse")}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Button
              title={similar ? t("booking.similarCreateAnyway") : t("booking.addConsigneeBtn")}
              onPress={() => submit(!!similar)}
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
  error: { color: colors.red, fontSize: 14, fontWeight: "600", marginBottom: 8 },
  similarBox: { backgroundColor: "#FFF8E1", borderRadius: radius.md, padding: 12, marginBottom: 10 },
  similarTitle: { fontSize: 14, fontWeight: "800", color: "#B26A00", marginBottom: 8 },
  similarRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#E6D9A8" },
  similarName: { fontSize: 14, fontWeight: "700", color: colors.navy },
  similarSub: { fontSize: 13, color: colors.textMuted, marginTop: 1 },
  similarUse: { fontSize: 13, fontWeight: "800", color: colors.blue, marginLeft: 10 },
  zoneHint: { fontSize: 12, color: colors.textMuted, marginTop: -6, marginBottom: 10 },
});
