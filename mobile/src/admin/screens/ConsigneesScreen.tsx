// Consignee directory management — RN port of admin/src/pages/ConsigneesPage.tsx.
// The correction path for wrong-zone self-adds: fix the zone, rename, or
// deactivate (deactivated consignees can't be booked; reactivate via the
// "include deactivated" toggle). Corrections affect FUTURE bookings only —
// past pay is protected by the assignment/finalization snapshots. Same hooks
// (useConsignees/useUpdateConsignee), same 409 force-save flow
// (SIMILAR_EXISTS / CONSIGNEE_IN_USE → "Save anyway" re-submits force=true).
import React, { useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import { useConsignees, useCreateConsignee, useUpdateConsignee } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Button, Card, EmptyState, ErrorState, Input, Loading, Modal, Pill, SearchInput } from "../components/ui";
import { apiErrorCode, apiErrorMessage } from "../services/api";
import { ZONES } from "../lib/zones";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { OptionsModal } from "../../components/OptionsModal";
import type { Consignee } from "../types";

export function ConsigneesScreen() {
  const { t } = useTranslation();
  const mode = useLayoutMode();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<Consignee | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const consignees = useConsignees(debouncedQ, includeInactive);

  if (consignees.isLoading) return <Loading />;
  if (consignees.isError)
    return <ErrorState message={t("admin.consignees.loadError")} onRetry={() => consignees.refetch()} />;

  const rows = consignees.data ?? [];

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={mode === "wide" ? { paddingVertical: 24, paddingHorizontal: 28, gap: 16 } : { padding: 14, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={consignees.isRefetching} onRefresh={() => consignees.refetch()} />}
    >
      <Card pad={12} style={{ gap: 12 }}>
        <SearchInput value={q} onChange={setQ} placeholder={t("admin.consignees.searchPlaceholder")} style={{ minWidth: 0 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Switch
              value={includeInactive}
              onValueChange={setIncludeInactive}
              trackColor={{ true: colors.blue, false: colors.border }}
              thumbColor="#fff"
            />
            <Text style={{ fontSize: font.sm, color: colors.textMuted }}>{t("admin.consignees.includeDeactivated")}</Text>
          </View>
          <Text style={{ fontSize: font.sm, color: colors.textFaint, flex: 1, textAlign: "right" }}>
            {t("admin.consignees.showing", { count: rows.length })}
          </Text>
          <Button size="sm" variant="primary" onPress={() => setAdding(true)}>
            {t("admin.consignees.add")}
          </Button>
        </View>
      </Card>

      <Card pad={0}>
        {rows.length === 0 ? (
          <EmptyState message={t("admin.consignees.noMatch")} />
        ) : (
          <View>
            {rows.map((c, i) => (
              <View
                key={c.id}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingVertical: 13,
                  paddingHorizontal: 16,
                  borderBottomWidth: i === rows.length - 1 ? 0 : 1,
                  borderBottomColor: colors.divider,
                  opacity: c.is_active === false ? 0.55 : 1,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text, flexShrink: 1 }}>
                      {c.company_name}
                    </Text>
                    {c.is_active === false && (
                      <Pill bg="#F3F4F6" fg="#4B5563" border="#E5E7EB" dot="#9CA3AF">
                        {t("admin.consignees.deactivated")}
                      </Pill>
                    )}
                  </View>
                  <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
                    {[c.area, c.state].filter(Boolean).join(" · ") || "—"}
                  </Text>
                </View>
                <Pill bg={colors.blueTint} fg={colors.blue} border="#BBD2F5">
                  {c.zone_code}
                </Pill>
                <Button size="sm" variant="outline" onPress={() => setEditing(c)}>
                  {t("admin.consignees.edit")}
                </Button>
              </View>
            ))}
          </View>
        )}
      </Card>

      {editing && <EditConsigneeModal consignee={editing} onClose={() => setEditing(null)} />}
      {adding && <AddConsigneeModal onClose={() => setAdding(false)} />}
    </ScrollView>
  );
}

// Admin add — Mr. Teh 16 Jul: "can help to let admin add new consignee,
// address, postcode". Same POST (and SIMILAR_EXISTS force flow) as the
// requestor self-add, plus the address fields the admin directory owns.
function AddConsigneeModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const create = useCreateConsignee();
  const [name, setName] = useState("");
  const [zone, setZone] = useState(ZONES[0]?.code ?? "P1");
  const [address1, setAddress1] = useState("");
  const [address2, setAddress2] = useState("");
  const [postal, setPostal] = useState("");
  const [zoneOpen, setZoneOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsForce, setNeedsForce] = useState(false);

  const save = async (force = false) => {
    setError(null);
    if (!name.trim()) {
      setError(t("admin.consignees.nameRequired"));
      return;
    }
    try {
      await create.mutateAsync({
        company_name: name.trim(),
        zone_code: zone,
        ...(address1.trim() ? { address_1: address1.trim() } : {}),
        ...(address2.trim() ? { address_2: address2.trim() } : {}),
        ...(postal.trim() ? { postal_code: postal.trim() } : {}),
        ...(force ? { force: true } : {}),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.consignees.saveFailed")));
      setNeedsForce(apiErrorCode(e) === "SIMILAR_EXISTS");
    }
  };

  const zoneInfo = ZONES.find((z) => z.code === zone);

  return (
    <Modal open title={t("admin.consignees.addTitle")} onClose={onClose}>
      <Input label={t("admin.consignees.companyName")} value={name} onChange={setName} />

      <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 6, color: colors.text }}>
        {t("admin.consignees.deliveryZone")}
      </Text>
      <Pressable
        onPress={() => setZoneOpen(true)}
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
        <Text style={{ fontSize: font.md, color: colors.text }}>
          {zone}
          {zoneInfo ? ` — ${zoneInfo.name}` : ""}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>

      <Input label={t("admin.consignees.addressLine1")} value={address1} onChange={setAddress1} />
      <Input label={t("admin.consignees.addressLine2")} value={address2} onChange={setAddress2} />
      <Input label={t("admin.consignees.postalCode")} value={postal} onChange={setPostal} />

      {error ? <Text style={{ color: colors.red, fontSize: font.sm, fontWeight: "600", marginBottom: 10 }}>{error}</Text> : null}

      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
        <Button variant="ghost" onPress={onClose}>
          {t("common.cancel")}
        </Button>
        {needsForce && (
          <Button variant="outline" onPress={() => save(true)} disabled={create.isPending} style={{ borderColor: colors.red }}>
            <Text style={{ color: colors.red, fontWeight: "700", fontSize: font.md }}>{t("admin.consignees.saveAnyway")}</Text>
          </Button>
        )}
        <Button variant="primary" onPress={() => save()} disabled={create.isPending}>
          {create.isPending ? t("admin.consignees.saving") : t("common.save")}
        </Button>
      </View>

      <OptionsModal
        visible={zoneOpen}
        title={t("admin.consignees.deliveryZone")}
        options={ZONES.map((z) => ({ label: `${z.code} — ${z.name}`, value: z.code }))}
        selectedValue={zone}
        onSelect={setZone}
        onClose={() => setZoneOpen(false)}
      />
    </Modal>
  );
}

function EditConsigneeModal({ consignee, onClose }: { consignee: Consignee; onClose: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateConsignee();
  // Edit the FULL legal name — company_name in the list payload is
  // display-stripped ("SDN BHD" removed) and must not be written back.
  const [name, setName] = useState(consignee.company_name_full ?? consignee.company_name);
  const [zone, setZone] = useState(consignee.zone_code);
  const [active, setActive] = useState(consignee.is_active !== false);
  // Address details — admin-amendable (Mr. Teh 16 Jul: "amend the existing
  // address, postal code"). Sent only when actually changed, so the audit row
  // records real edits, not every save.
  const [address1, setAddress1] = useState(consignee.address_1 ?? "");
  const [address2, setAddress2] = useState(consignee.address_2 ?? "");
  const [postal, setPostal] = useState(consignee.postal_code ?? "");
  const [error, setError] = useState<string | null>(null);
  const [zoneOpen, setZoneOpen] = useState(false);
  // A 409 warning from the server (rename would create a near-duplicate /
  // deactivating with active bookings) — shown with a "Save anyway" that
  // re-submits force=true.
  const [needsForce, setNeedsForce] = useState(false);

  const WARN_CODES = ["SIMILAR_EXISTS", "CONSIGNEE_IN_USE"];

  const save = async (force = false) => {
    setError(null);
    const changedDetail = (next: string, current: string | null | undefined) =>
      next.trim() !== (current ?? "").trim() ? next.trim() : undefined;
    try {
      await update.mutateAsync({
        id: consignee.id,
        company_name: name.trim() || undefined,
        zone_code: zone,
        is_active: active,
        address_1: changedDetail(address1, consignee.address_1),
        address_2: changedDetail(address2, consignee.address_2),
        postal_code: changedDetail(postal, consignee.postal_code),
        ...(force ? { force: true } : {}),
      });
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, t("admin.consignees.saveFailed")));
      setNeedsForce(WARN_CODES.includes(apiErrorCode(e) ?? ""));
    }
  };

  const zoneChanged = zone !== consignee.zone_code;
  const zoneInfo = ZONES.find((z) => z.code === zone);

  return (
    <Modal open title={t("admin.consignees.editTitle")} onClose={onClose}>
      <Input label={t("admin.consignees.companyName")} value={name} onChange={setName} />

      <Text style={{ fontSize: font.md, fontWeight: "600", marginBottom: 6, color: colors.text }}>
        {t("admin.consignees.deliveryZone")}
      </Text>
      <Pressable
        onPress={() => setZoneOpen(true)}
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
        <Text style={{ fontSize: font.md, color: colors.text }}>
          {zone}
          {zoneInfo ? ` — ${zoneInfo.name}` : ""}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>

      {zoneChanged && (
        <View style={{ backgroundColor: colors.orangeTint, borderRadius: radius.sm, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 14 }}>
          <Text style={{ fontSize: font.sm, color: colors.orange }}>{t("admin.consignees.zoneChangeNote")}</Text>
        </View>
      )}

      <Input label={t("admin.consignees.addressLine1")} value={address1} onChange={setAddress1} />
      <Input label={t("admin.consignees.addressLine2")} value={address2} onChange={setAddress2} />
      <Input label={t("admin.consignees.postalCode")} value={postal} onChange={setPostal} />

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <Switch
          value={active}
          onValueChange={setActive}
          trackColor={{ true: colors.blue, false: colors.border }}
          thumbColor="#fff"
        />
        <Text style={{ fontSize: font.md, color: colors.text, flex: 1 }}>{t("admin.consignees.activeBookable")}</Text>
      </View>

      {error ? <Text style={{ color: colors.red, fontSize: font.sm, fontWeight: "600", marginBottom: 10 }}>{error}</Text> : null}

      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
        <Button variant="ghost" onPress={onClose}>
          {t("common.cancel")}
        </Button>
        {needsForce && (
          <Button variant="outline" onPress={() => save(true)} disabled={update.isPending} style={{ borderColor: colors.red }}>
            <Text style={{ color: colors.red, fontWeight: "700", fontSize: font.md }}>{t("admin.consignees.saveAnyway")}</Text>
          </Button>
        )}
        <Button variant="primary" onPress={() => save()} disabled={update.isPending}>
          {update.isPending ? t("admin.consignees.saving") : t("common.save")}
        </Button>
      </View>

      <OptionsModal
        visible={zoneOpen}
        title={t("admin.consignees.deliveryZone")}
        options={ZONES.map((z) => ({ label: `${z.code} — ${z.name}`, value: z.code }))}
        selectedValue={zone}
        onSelect={setZone}
        onClose={() => setZoneOpen(false)}
      />
    </Modal>
  );
}
