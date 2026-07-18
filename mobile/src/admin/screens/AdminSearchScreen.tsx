// Global search (admin) — one box across tickets, consignees and people; tap a
// result to jump to the relevant screen. Read-only.
import React, { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import { useGlobalSearch } from "../hooks/queries";
import { colors, font } from "../theme";
import { Card, EmptyState, Loading, SearchInput } from "../components/ui";

export function AdminSearchScreen() {
  const { t } = useTranslation();
  const nav = useNavigation<{ navigate: (r: string) => void }>();
  const [q, setQ] = useState("");
  const res = useGlobalSearch(q);
  const data = res.data;
  const nothing = !!data && data.trips.length === 0 && data.users.length === 0 && data.consignees.length === 0;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 800, width: "100%", alignSelf: "center" }} keyboardShouldPersistTaps="handled">
      <SearchInput value={q} onChange={setQ} placeholder={t("admin.search.placeholder")} style={{ alignSelf: "stretch", minWidth: 0 }} />

      {q.trim().length < 2 ? (
        <EmptyState message={t("admin.search.hint")} />
      ) : res.isLoading ? (
        <Loading />
      ) : nothing ? (
        <EmptyState message={t("admin.search.empty")} />
      ) : (
        <>
          {data!.trips.length > 0 && (
            <Section title={t("admin.search.trips")}>
              {data!.trips.map((tr) => (
                <Row key={tr.id} main={tr.ticket_number} sub={tr.status} onPress={() => nav.navigate("AdminTrips")} />
              ))}
            </Section>
          )}
          {data!.consignees.length > 0 && (
            <Section title={t("admin.search.consignees")}>
              {data!.consignees.map((c) => (
                <Row key={c.id} main={c.company_name} sub={`${c.zone_code}${c.area ? ` · ${c.area}` : ""}`} onPress={() => nav.navigate("AdminConsignees")} />
              ))}
            </Section>
          )}
          {data!.users.length > 0 && (
            <Section title={t("admin.search.people")}>
              {data!.users.map((u) => (
                <Row key={u.id} main={u.name} sub={`${u.role}${u.phone ? ` · ${u.phone}` : ""}`} onPress={() => nav.navigate("AdminUsers")} />
              ))}
            </Section>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card pad={0} style={{ overflow: "hidden" }}>
      <Text style={{ fontSize: font.sm, fontWeight: "800", color: colors.textMuted, letterSpacing: 0.5, padding: 12, paddingBottom: 6, textTransform: "uppercase" }}>{title}</Text>
      {children}
    </Card>
  );
}

function Row({ main, sub, onPress }: { main: string; sub: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ paddingVertical: 12, paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: colors.divider }}>
      <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text }}>{main}</Text>
      <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>{sub}</Text>
    </Pressable>
  );
}
