// Audit-log viewer (admin, read-only). Renders the AuditLog trail written across
// the app — who changed what, and when — with a table filter and keyset "load
// more". No mutations: this screen only reads.
import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useAuditLog, useAuditFilters } from "../hooks/queries";
import { colors, font, radius } from "../theme";
import { Button, Card, EmptyState, ErrorState, Loading } from "../components/ui";

function fmtTs(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function AuditLogScreen() {
  const { t } = useTranslation();
  const [table, setTable] = useState<string | undefined>(undefined);
  const filters = useAuditFilters();
  const q = useAuditLog({ table });

  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.rows), [q.data]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, maxWidth: 900, width: "100%", alignSelf: "center" }}>
      <Card pad={0} style={{ overflow: "hidden" }}>
        <View style={{ paddingVertical: 14, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
          <Text style={{ fontSize: font.md, fontWeight: "800", color: colors.text }}>{t("admin.audit.title")}</Text>
          <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>{t("admin.audit.subtitle")}</Text>
        </View>

        {/* Table filter chips (from the distinct table_name values). */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, padding: 12 }}>
          <Chip label={t("admin.audit.allTables")} active={table === undefined} onPress={() => setTable(undefined)} />
          {(filters.data?.tables ?? []).map((tbl) => (
            <Chip key={tbl} label={tbl} active={table === tbl} onPress={() => setTable(tbl)} />
          ))}
        </ScrollView>
      </Card>

      {q.isLoading ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState message={t("admin.audit.loadError")} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState message={t("admin.audit.empty")} />
      ) : (
        <Card pad={0} style={{ overflow: "hidden" }}>
          {rows.map((r, i) => (
            <View
              key={r.id}
              style={{ paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: i === rows.length - 1 ? 0 : 1, borderBottomColor: colors.divider }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
                <Text style={{ fontSize: font.md, fontWeight: "700", color: colors.text, flex: 1 }}>{r.action}</Text>
                <Text style={{ fontSize: font.sm, color: colors.textFaint }}>{fmtTs(r.timestamp)}</Text>
              </View>
              <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 2 }}>
                {r.table_name} · {r.record_id}
              </Text>
              <Text style={{ fontSize: font.sm, color: colors.blue, marginTop: 2 }}>
                {r.user ? `${r.user.name} (${r.user.role})` : t("admin.audit.systemActor")}
              </Text>
            </View>
          ))}
          {q.hasNextPage && (
            <View style={{ padding: 12 }}>
              <Button variant="outline" onPress={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? t("admin.audit.loadingMore") : t("admin.audit.loadMore")}
              </Button>
            </View>
          )}
        </Card>
      )}
    </ScrollView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: radius.pill,
        backgroundColor: active ? colors.blue : colors.panel,
        borderWidth: 1,
        borderColor: active ? colors.blue : colors.border,
      }}
    >
      <Text style={{ fontSize: font.sm, fontWeight: "700", color: active ? "#fff" : colors.textMuted }}>{label}</Text>
    </Pressable>
  );
}
