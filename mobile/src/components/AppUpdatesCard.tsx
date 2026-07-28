// "App & updates" — OTA ground truth + manual update pull + API reachability,
// for EVERY role (28 Jul owner ask): drivers and requestors are the ones on
// phones in the field who actually need to pull a fix, so the card moved out
// of admin Settings into this shared component. Same behaviour everywhere:
// version / runtime / channel / the PLATFORM-specific active update id
// (compare against the "Android update ID" line of `eas update` output, not
// the group id; null/embedded = no OTA ever applied), plus a check → fetch →
// reload button so nobody depends on the two-cold-launch background flow.
//
// Styled with the MAIN theme so it renders in both navigation trees (the
// AccountModals / FeedbackModal rule). Strings reuse the existing
// admin.settings.* keys (already in en/ms/zh) — the "admin" prefix is
// historical, the strings are role-neutral.
import React, { useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useTranslation } from "react-i18next";
import { colors, radius, shadow } from "../theme";
import { Button } from "./Button";
import { api } from "../services/api";

export function AppUpdatesCard({ style }: { style?: object }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One /health ping on mount — reachability + latency. The field question
  // "is it me or the server?" deserves a visible answer on every role.
  const [apiStatus, setApiStatus] = useState<{ ok: boolean; ms: number } | null>(null);
  React.useEffect(() => {
    let mounted = true;
    (async () => {
      const started = Date.now();
      try {
        await api.get("/health", { timeout: 8000 });
        if (mounted) setApiStatus({ ok: true, ms: Date.now() - started });
      } catch {
        if (mounted) setApiStatus({ ok: false, ms: Date.now() - started });
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const updatesUsable = Updates.isEnabled && Platform.OS !== "web";
  const running =
    !Updates.isEnabled
      ? t("admin.settings.updDisabled")
      : Updates.isEmbeddedLaunch || !Updates.updateId
        ? t("admin.settings.updEmbedded")
        : Updates.updateId;
  const publishedAt =
    Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.createdAt
      ? new Date(Updates.createdAt).toLocaleString()
      : null;

  const check = async () => {
    setBusy(true);
    try {
      setStatus(t("admin.settings.updChecking"));
      const res = await Updates.checkForUpdateAsync();
      if (!res.isAvailable) {
        setStatus(t("admin.settings.updUpToDate"));
        return;
      }
      setStatus(t("admin.settings.updDownloading"));
      await Updates.fetchUpdateAsync();
      setStatus(t("admin.settings.updRestarting"));
      await Updates.reloadAsync();
    } catch (e) {
      setStatus(t("admin.settings.updError", { msg: (e as Error)?.message ?? String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const rows: { label: string; value: string }[] = [
    {
      label: t("admin.settings.apiRow"),
      value:
        apiStatus === null
          ? "…"
          : apiStatus.ok
            ? t("admin.settings.apiOk", { ms: apiStatus.ms })
            : t("admin.settings.apiDown"),
    },
    { label: t("admin.settings.appVersion"), value: (Constants.expoConfig?.version as string) ?? "—" },
    {
      label: t("admin.settings.runtime"),
      value: Updates.runtimeVersion || ((Constants.expoConfig?.runtimeVersion as string) ?? "—"),
    },
    { label: t("admin.settings.channel"), value: Updates.channel ?? "—" },
  ];

  return (
    <View style={[styles.card, style]}>
      <Text style={styles.title}>{t("admin.settings.aboutTitle")}</Text>
      <View style={styles.table}>
        {rows.map((r, i) => (
          <View key={r.label} style={[styles.row, i > 0 && styles.rowDivider]}>
            <Text style={styles.rowLabel}>{r.label}</Text>
            <Text style={styles.rowValue}>{r.value}</Text>
          </View>
        ))}
        <View style={[styles.updateRow, styles.rowDivider]}>
          <Text style={styles.rowLabel}>{t("admin.settings.updateRow")}</Text>
          <Text selectable style={styles.updateId}>
            {running}
          </Text>
          {publishedAt ? (
            <Text style={styles.publishedAt}>{t("admin.settings.updPublishedAt", { when: publishedAt })}</Text>
          ) : null}
        </View>
      </View>
      {updatesUsable ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <Button title={t("admin.settings.updCheckBtn")} variant="outline" onPress={check} disabled={busy} />
          {status ? <Text style={styles.status}>{status}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderRadius: radius.md, padding: 16, ...shadow.card },
  title: { fontSize: 12, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 10 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.bg },
  rowLabel: { fontSize: 13, color: colors.textMuted },
  rowValue: { fontSize: 13, fontWeight: "700", color: colors.navy },
  updateRow: { paddingVertical: 12, paddingHorizontal: 14 },
  updateId: { fontSize: 11, fontWeight: "700", color: colors.navy, marginTop: 3 },
  publishedAt: { fontSize: 11, color: colors.textFaint, marginTop: 2 },
  status: { fontSize: 13, color: colors.textMuted },
});
