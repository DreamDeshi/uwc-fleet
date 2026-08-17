// Admin Settings — the in-app admin's preferences hub, reached from the PC
// sidebar's "System" group and the phone MORE tab.
//
// ⚠ ON A PHONE THIS IS THE SAME SHELL AS THE DRIVER/REQUESTOR PROFILE
// (screens/shared/ProfileScreen), by owner instruction 9 Aug 2026: "they are
// not the same, but they have to look similar". Identity on the blue header,
// a read-only facts card, action rows, an inline LANGUAGE SEGMENT, App &
// Updates, then Log Out. Only the CONTENT differs — the admin keeps its
// system rows and the feedback inbox, and has no truck plate.
//
// It previously diverged in four visible ways, all fixed here: no blue
// identity header (a small white avatar card instead), no facts card at all,
// language as a VERTICAL RADIO LIST rather than the segment, and sign-out as a
// quiet row rather than the danger button every other role gets.
//
// Language switching reuses the SAME mechanism the Profile screen uses —
// useAuth().setLanguage → i18n.changeLanguage (live re-render across every
// screen via react-i18next) + PATCH /users/me (persisted per account,
// re-applied on next login by AuthContext.fetchMe). No parallel i18n.
import React, { useState } from "react";
import { Image, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NavigationProp, ParamListBase } from "@react-navigation/native";
import { useAuth } from "../../context/AuthContext";
import { colors, font, radius, shadow } from "../theme";
import { Button, Card, ConfirmDialog, SectionTitle } from "../components/ui";
import { Button as AppButton } from "../../components/Button";
import { api } from "../services/api";
import { useLayoutMode } from "../hooks/useLayoutMode";
import { initials } from "../../lib/format";
import { AppLanguage } from "../../types";
import { EditProfileModal, ChangePasswordModal } from "../../components/AccountModals";
import { FeedbackModal } from "../../components/FeedbackModal";
import { AppUpdatesCard } from "../../components/AppUpdatesCard";
import { BiometricUnlockRow } from "../../components/BiometricUnlockRow";

// Language display names are the native endonyms (English / Bahasa Malaysia /
// 简体中文) — identical in every locale — so they reuse the existing
// profile.* keys the driver/requestor picker already ships.
const LANGUAGES: { code: AppLanguage; labelKey: string }[] = [
  { code: "en", labelKey: "profile.english" },
  { code: "ms", labelKey: "profile.malay" },
  { code: "zh", labelKey: "profile.chinese" },
];

export function AdminSettingsScreen() {
  const { t, i18n } = useTranslation();
  const { user, logout, setLanguage } = useAuth();
  const insets = useSafeAreaInsets();
  const mode = useLayoutMode();
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  const [editOpen, setEditOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const narrow = mode !== "wide";

  const current: AppLanguage = (["en", "ms", "zh"] as const).includes(i18n.language as AppLanguage)
    ? (i18n.language as AppLanguage)
    : "en";

  const accountRows: { key: string; labelKey: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void }[] = [
    { key: "edit", labelKey: "account.editProfile", icon: "create-outline", onPress: () => setEditOpen(true) },
    { key: "password", labelKey: "account.changePassword", icon: "lock-closed-outline", onPress: () => setPwOpen(true) },
    { key: "feedback", labelKey: "feedback.title", icon: "megaphone-outline", onPress: () => setFeedbackOpen(true) },
  ];

  // Role · Department · Employee number as one line, exactly as the shared
  // Profile builds it. Empty parts drop out rather than leaving separators.
  const subtitle = [t("admin.roleLabel"), user?.department?.name, user?.employee_number]
    .filter(Boolean)
    .join(" · ");

  const facts: { label: string; value: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { label: t("profile.phone"), value: user?.phone ?? "—", icon: "call-outline" },
    { label: t("profile.employeeNumber"), value: user?.employee_number ?? "—", icon: "id-card-outline" },
    { label: t("profile.department"), value: user?.department?.name ?? "—", icon: "business-outline" },
  ];

  return (
    <>
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Identity ON the blue — phone only; on wide the sidebar carries it.
          Same block as the driver/requestor Profile. */}
      {narrow ? (
        <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
          <View style={styles.identityRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initials(user?.name ?? "")}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.name} numberOfLines={2}>{user?.name ?? "—"}</Text>
              {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
          </View>
        </View>
      ) : null}

      {mode === "wide" ? (
        /* ── DESKTOP: A REAL TWO-COLUMN LAYOUT ────────────────────────────
           Design handoff, 17 Aug 2026: this screen was a 680px-wide mobile
           column parked in the middle of a 1440px window, with the admin's own
           identity — the thing the page is about — nowhere on it, because the
           narrow layout puts that in the blue header and the wide layout
           dropped the header.

           Left rail: who you are. Right: what you can change, two cards abreast
           so ACCOUNT and SYSTEM stop stacking into a single ribbon of white.

           ⚠ ONE DELIBERATE OMISSION from the frame: its left rail also carries
           a section nav (Account / System / Language / Feedback / App). Every
           section is on screen at once here, so that list would be a jump menu
           with nothing to jump to — decoration in the exact dead space the
           handoff asked us to fill. The identity card is the half that carries
           information. */
        <View style={{ flexDirection: "row", gap: 20, paddingVertical: 24, paddingHorizontal: 28, alignItems: "flex-start" }}>
          <View style={{ width: 300, flexGrow: 0, flexShrink: 0 }}>
            <View style={styles.identityCard}>
              <View style={styles.identityAvatar}>
                <Text style={styles.identityAvatarText}>{initials(user?.name ?? "")}</Text>
              </View>
              <Text style={styles.identityName} numberOfLines={2}>{user?.name ?? "—"}</Text>
              {subtitle ? <Text style={styles.identitySubtitle} numberOfLines={2}>{subtitle}</Text> : null}
              <View style={{ alignSelf: "stretch", gap: 8, marginTop: 16 }}>
                {facts.map((f) => (
                  <View key={f.label} style={styles.identityFact}>
                    <Ionicons name={f.icon} size={15} color={colors.textFaint} />
                    <Text style={styles.identityFactValue} numberOfLines={1}>{f.value}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>

          <View style={{ flex: 1, minWidth: 0, gap: 16, maxWidth: 980 }}>
            <View style={{ flexDirection: "row", gap: 16, alignItems: "flex-start" }}>
              <View style={{ flex: 1, minWidth: 0 }}>
        {/* Account — self-service profile + password (any role, incl. admin) */}
        <Text style={styles.sectionLabel}>{t("account.section")}</Text>
        <View style={styles.card}>
          {accountRows.map((r, i) => (
            <TouchableOpacity
              key={r.key}
              onPress={r.onPress}
              style={[styles.row, i < accountRows.length - 1 && styles.rowDivider]}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Ionicons name={r.icon} size={19} color={colors.blue} />
              <Text style={styles.actionLabel}>{t(r.labelKey)}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          ))}
        </View>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
        {/* System — admin-only, and the reason this screen is not just Profile.
            Audit log lives here (moved out of the top-level nav). */}
        <Text style={styles.sectionLabel}>{t("admin.navGroups.system")}</Text>
        <View style={styles.card}>
          <TouchableOpacity
            onPress={() => navigation.navigate("AdminAudit")}
            style={styles.row}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Ionicons name="receipt-outline" size={19} color={colors.blue} />
            <View style={{ flex: 1 }}>
              <Text style={styles.actionLabel}>{t("admin.audit.navLabel")}</Text>
              <Text style={styles.actionSub}>{t("admin.audit.subtitle")}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        </View>

        {/* One inline segmented control, not three stacked radio rows — the
            shared Profile's control, and the reason this screen used to look
            like a different app. See ProfileScreen for why the buttons size
            from content (flexBasis "auto") instead of equal thirds: at 320px
            an equal third starves "Bahasa Malaysia" and it wraps. */}
        <Text style={styles.sectionLabel}>{t("profile.language")}</Text>
        <View style={styles.segment}>
          {LANGUAGES.map((l) => {
            const active = current === l.code;
            return (
              <TouchableOpacity
                key={l.code}
                style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                onPress={() => setLanguage(l.code)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
                  {t(l.labelKey)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
              </View>
            </View>
        {/* User feedback inbox (28 Jul 2026) — what drivers / requestors /
            admins submitted through "Report a problem or idea". This is the
            owner's dev-planning inbox; embedded here per the no-new-screens
            rule. Admin-only, so it keeps its own panel look. */}
        <View style={{ marginTop: 20 }}>
          <FeedbackInboxCard />
        </View>

        {/* App & updates — OTA ground truth (27 Jul 2026). Shows WHICH update
            this install is actually running (the platform update id, null on
            the embedded bundle) so "did the phone get the update?" is a fact,
            not a guess — plus a manual check that downloads and restarts in
            one tap, replacing the two-cold-launch dance. */}
        <AppUpdatesCard style={{ marginTop: 20 }} />
          </View>
        </View>
      ) : (
      <View style={{ padding: 16 }}>
        {narrow ? (
          <View style={styles.card}>
            {facts.map((f, i) => (
              <View key={f.label} style={[styles.row, i < facts.length - 1 && styles.rowDivider]}>
                <Ionicons name={f.icon} size={18} color={colors.textFaint} />
                <Text style={styles.rowLabel}>{f.label}</Text>
                <Text style={styles.rowValue} numberOfLines={1}>{f.value}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Account — self-service profile + password (any role, incl. admin) */}
        <Text style={styles.sectionLabel}>{t("account.section")}</Text>
        <View style={styles.card}>
          {accountRows.map((r, i) => (
            <TouchableOpacity
              key={r.key}
              onPress={r.onPress}
              style={[styles.row, i < accountRows.length - 1 && styles.rowDivider]}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              <Ionicons name={r.icon} size={19} color={colors.blue} />
              <Text style={styles.actionLabel}>{t(r.labelKey)}</Text>
              <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
            </TouchableOpacity>
          ))}
        </View>

        {/* System — admin-only, and the reason this screen is not just Profile.
            Audit log lives here (moved out of the top-level nav). */}
        <Text style={styles.sectionLabel}>{t("admin.navGroups.system")}</Text>
        <View style={styles.card}>
          <TouchableOpacity
            onPress={() => navigation.navigate("AdminAudit")}
            style={styles.row}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <Ionicons name="receipt-outline" size={19} color={colors.blue} />
            <View style={{ flex: 1 }}>
              <Text style={styles.actionLabel}>{t("admin.audit.navLabel")}</Text>
              <Text style={styles.actionSub}>{t("admin.audit.subtitle")}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </TouchableOpacity>
        </View>

        {/* One inline segmented control, not three stacked radio rows — the
            shared Profile's control, and the reason this screen used to look
            like a different app. See ProfileScreen for why the buttons size
            from content (flexBasis "auto") instead of equal thirds: at 320px
            an equal third starves "Bahasa Malaysia" and it wraps. */}
        <Text style={styles.sectionLabel}>{t("profile.language")}</Text>
        <View style={styles.segment}>
          {LANGUAGES.map((l) => {
            const active = current === l.code;
            return (
              <TouchableOpacity
                key={l.code}
                style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                onPress={() => setLanguage(l.code)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
                  {t(l.labelKey)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* User feedback inbox (28 Jul 2026) — what drivers / requestors /
            admins submitted through "Report a problem or idea". This is the
            owner's dev-planning inbox; embedded here per the no-new-screens
            rule. Admin-only, so it keeps its own panel look. */}
        <View style={{ marginTop: 20 }}>
          <FeedbackInboxCard />
        </View>

        {/* App & updates — OTA ground truth (27 Jul 2026). Shows WHICH update
            this install is actually running (the platform update id, null on
            the embedded bundle) so "did the phone get the update?" is a fact,
            not a guess — plus a manual check that downloads and restarts in
            one tap, replacing the two-cold-launch dance. */}
        <BiometricUnlockRow style={{ marginTop: 20 }} />
        <AppUpdatesCard style={{ marginTop: 20 }} />

        {/* Sign out — phone only, and the same DANGER BUTTON every other role
            gets. It used to be a quiet row, which made the one irreversible
            action on the screen the least prominent thing on it. (On desktop
            the sidebar carries Sign Out.) */}
        <AppButton
          title={t("admin.signOut")}
          variant="danger"
          onPress={() => setConfirmOut(true)}
          style={{ marginTop: 20 }}
          icon={<Ionicons name="log-out-outline" size={18} color="#fff" />}
        />
      </View>
      )}
    </ScrollView>

    <EditProfileModal visible={editOpen} onClose={() => setEditOpen(false)} />
    <ChangePasswordModal visible={pwOpen} onClose={() => setPwOpen(false)} />
    <FeedbackModal visible={feedbackOpen} screen="admin-settings" onClose={() => setFeedbackOpen(false)} />
    {confirmOut ? (
      <ConfirmDialog
        title={t("admin.signOut")}
        body={t("profile.logoutConfirm")}
        confirmLabel={t("admin.signOut")}
        onClose={() => setConfirmOut(false)}
        onConfirm={logout}
      />
    ) : null}
    </>
  );
}

// Mirrors screens/shared/ProfileScreen's stylesheet so the two screens read as
// one family. Values are the ADMIN theme's tokens — navy, blue and yellow are
// identical across both themes; only the greys differ by a shade.
const styles = StyleSheet.create({
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 22 },
  identityRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  // Desktop identity card — the left rail's whole job.
  identityCard: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 20,
    alignItems: "center",
  },
  identityAvatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.navy,
    borderWidth: 2,
    borderColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  identityAvatarText: { color: colors.yellow, fontSize: 24, fontWeight: "800" },
  identityName: { marginTop: 12, fontSize: font.lg, fontWeight: "800", color: colors.text, textAlign: "center" },
  identitySubtitle: { marginTop: 4, fontSize: font.sm, color: colors.textMuted, textAlign: "center" },
  identityFact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.panel,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  identityFactValue: { flex: 1, fontSize: font.sm, color: colors.text, fontWeight: "600" },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.navy,
    borderWidth: 2,
    borderColor: colors.yellow,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: colors.yellow, fontSize: 22, fontWeight: "800" },
  name: { color: "#fff", fontSize: 20, fontWeight: "800", lineHeight: 25 },
  subtitle: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginTop: 2 },

  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, ...shadow.card },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.divider },
  rowLabel: { fontSize: font.md, color: colors.textMuted },
  rowValue: { marginLeft: "auto", fontSize: font.md, fontWeight: "700", color: colors.text, flexShrink: 1 },
  actionLabel: { flex: 1, fontSize: 15, fontWeight: "700", color: colors.text },
  actionSub: { fontSize: font.xs, color: colors.textMuted, marginTop: 2 },

  sectionLabel: {
    fontSize: font.xs,
    fontWeight: "700",
    color: colors.textFaint,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 8,
  },

  segment: {
    flexDirection: "row",
    gap: 4,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 4,
    ...shadow.card,
  },
  // flexBasis "auto" + flexGrow, NOT flex: 1 — equal thirds starve the longest
  // label and "Bahasa Malaysia" wraps at 320px. See ProfileScreen for the full
  // reasoning; the selected state changes COLOUR ONLY for the same reason.
  segmentBtn: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    height: 44,
    paddingHorizontal: 6,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentBtnActive: { backgroundColor: colors.blue },
  segmentText: { fontSize: font.md, fontWeight: "700", color: colors.textMuted },
  segmentTextActive: { color: "#fff" },
});

// The owner's feedback inbox — everything submitted through "Report a
// problem or idea" (any role), newest first. Reads GET /feedback (admin-only,
// AuditLog-backed). Refresh is manual: feedback is a planning surface, not a
// live feed, so no poll.
function FeedbackInboxCard() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<
    {
      id: string;
      category: string;
      message: string;
      /** Freshly-signed URL of the sender's screenshot, or null. */
      image_url?: string | null;
      user_name: string;
      role: string;
      at: string;
    }[] | null
  >(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.get("/feedback");
      setRows(res.data.feedback ?? []);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const catStyle: Record<string, { bg: string; fg: string }> = {
    bug: { bg: colors.redTint, fg: colors.red },
    idea: { bg: colors.blueTint, fg: colors.blue },
    other: { bg: colors.bg, fg: colors.textMuted },
  };
  const catLabel: Record<string, string> = {
    bug: t("feedback.categoryBug"),
    idea: t("feedback.categoryIdea"),
    other: t("feedback.categoryOther"),
  };

  return (
    <Card>
      {/* Refresh goes through SectionTitle's `right` SLOT — never a second
          wrapper row. SectionTitle's root is itself a full-width row, so
          nesting it beside a sibling pushed the button off the card edge on
          native (the 28-Jul admin-mobile clipped-Refresh bug). */}
      <SectionTitle
        title={t("admin.settings.feedbackTitle")}
        right={
          <Button variant="outline" size="sm" onPress={() => void load()} disabled={busy}>
            {t("common.refresh")}
          </Button>
        }
      />
      {failed ? (
        <Text style={{ fontSize: font.sm, color: colors.red, marginTop: 8 }}>
          {t("admin.settings.feedbackLoadFailed")}
        </Text>
      ) : rows === null ? (
        <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 8 }}>{t("common.loading")}</Text>
      ) : rows.length === 0 ? (
        <Text style={{ fontSize: font.sm, color: colors.textMuted, marginTop: 8 }}>
          {t("admin.settings.feedbackEmpty")}
        </Text>
      ) : (
        <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden", marginTop: 8 }}>
          {rows.slice(0, 50).map((r, i) => {
            const cat = catStyle[r.category] ?? catStyle.other;
            return (
              <View
                key={r.id}
                style={{
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                  backgroundColor: colors.card,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: colors.divider,
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <View style={{ backgroundColor: cat.bg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 }}>
                    <Text style={{ fontSize: font.xs, fontWeight: "800", color: cat.fg }}>
                      {catLabel[r.category] ?? r.category}
                    </Text>
                  </View>
                  <Text style={{ fontSize: font.xs, fontWeight: "700", color: colors.text }}>
                    {r.user_name} · {r.role}
                  </Text>
                  <Text style={{ fontSize: font.xs, color: colors.textFaint, marginLeft: "auto" }}>
                    {new Date(r.at).toLocaleString()}
                  </Text>
                </View>
                <Text style={{ fontSize: font.sm, color: colors.text, marginTop: 6, lineHeight: 19 }}>{r.message}</Text>
                {/* The sender's screenshot. The URL is signed per read (the
                    asset is private), so it is only valid for this response —
                    never cache or store it. Tap to open full size. */}
                {r.image_url ? (
                  <TouchableOpacity
                    onPress={() => Linking.openURL(r.image_url!)}
                    activeOpacity={0.85}
                    style={{ marginTop: 8, alignSelf: "flex-start" }}
                  >
                    <Image
                      source={{ uri: r.image_url }}
                      style={{ width: 148, height: 148, borderRadius: radius.sm, backgroundColor: colors.bg }}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}
