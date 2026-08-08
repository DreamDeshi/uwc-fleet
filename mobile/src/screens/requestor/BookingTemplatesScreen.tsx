import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RequestorStackParamList } from "../../navigation/types";
import { colors, layout, radius, shadow } from "../../theme";
import { Header } from "../../components/Header";
import { Button } from "../../components/Button";
import { useToast } from "../../components/Toast";
import {
  loadTemplates,
  persistTemplates,
  removeTemplate,
  type BookingTemplate,
} from "../../lib/bookingTemplates";

/**
 * Saved booking templates, as a screen (design frame 12's "Booking Templates").
 *
 * Templates have always existed — they were only reachable as chips inside step
 * one of the booking form, which meant the only way to delete one was to start
 * a booking you did not want. Nothing about how they are STORED changes: still
 * device-local AsyncStorage, still no API.
 *
 * ⚠ Device-local is the whole caveat, and the screen says so rather than
 * letting a requestor discover it by changing phones.
 */
export function BookingTemplatesScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RequestorStackParamList>>();
  const toast = useToast();
  const [templates, setTemplates] = useState<BookingTemplate[] | null>(null);

  useEffect(() => {
    loadTemplates().then(setTemplates);
  }, []);

  const onDelete = async (name: string) => {
    const next = removeTemplate(templates ?? [], name);
    setTemplates(next);
    await persistTemplates(next);
    toast(t("account.templateDeleted"), "success");
  };

  const list = templates ?? [];

  return (
    <View style={styles.fill}>
      <Header title={t("account.bookingTemplates")} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]}>
        <View style={styles.note}>
          <Ionicons name="phone-portrait-outline" size={18} color={colors.blue} />
          <Text style={styles.noteText}>{t("account.templatesDeviceOnly")}</Text>
        </View>

        {templates === null ? null : list.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="repeat-outline" size={30} color={colors.blue} />
            </View>
            <Text style={styles.emptyTitle}>{t("account.noTemplates")}</Text>
            <Text style={styles.emptyBody}>{t("account.noTemplatesBody")}</Text>
          </View>
        ) : (
          <View style={styles.card}>
            {list.map((tpl, i) => (
              <View key={tpl.name} style={[styles.row, i < list.length - 1 && styles.divider]}>
                <Ionicons name="bookmark" size={18} color={colors.blue} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>
                    {tpl.name}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {t("account.templateStops", { count: tpl.stops.length })}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => onDelete(tpl.name)}
                  hitSlop={10}
                  accessibilityLabel={t("booking.deleteTemplate", { name: tpl.name })}
                >
                  <Ionicons name="trash-outline" size={19} color={colors.textFaint} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* The form is where a template is USED and SAVED, so this is the only
            action that belongs here — the screen manages them, it does not
            duplicate the wizard. */}
        <Button
          title={t("tabs.newBooking")}
          onPress={() => navigation.navigate("NewBooking")}
          style={{ marginTop: 20 }}
          icon={<Ionicons name="add" size={18} color={colors.white} />}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 16, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  note: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.tintBlue, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 14 },
  noteText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "600", color: colors.blue },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.borderLight, ...shadow.card },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  divider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  rowTitle: { fontSize: 15, fontWeight: "700", color: colors.navy },
  rowMeta: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  empty: { alignItems: "center", gap: 12, paddingVertical: 40, paddingHorizontal: 24 },
  emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 17, fontWeight: "800", color: colors.navy, textAlign: "center" },
  emptyBody: { fontSize: 14, color: colors.textMuted, lineHeight: 20, textAlign: "center", maxWidth: 300 },
});
