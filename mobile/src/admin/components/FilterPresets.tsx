// Saved trip-board filter presets ("my views"). Fully self-contained: stores
// named filter combos in AsyncStorage (device-local, no server/schema) and
// renders a compact chip row + a save dialog. Additive to the trip board.
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { colors, font, radius } from "../theme";
import { Button, Input, Modal } from "./ui";

export interface TripFilterPreset {
  name: string;
  status: string;
  driverId: string;
  zone: string;
  dateFrom: string;
  dateTo: string;
}

const KEY = "admin.tripFilterPresets.v1";

async function load(): Promise<TripFilterPreset[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as TripFilterPreset[]) : [];
  } catch {
    return [];
  }
}
async function persist(list: TripFilterPreset[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* device storage best-effort */
  }
}

export function FilterPresets({
  current,
  onApply,
}: {
  current: Omit<TripFilterPreset, "name">;
  onApply: (p: TripFilterPreset) => void;
}) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<TripFilterPreset[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    load().then(setPresets);
  }, []);

  const save = async () => {
    const clean = name.trim();
    if (!clean) return;
    // Replace a same-named preset rather than duplicate it.
    const next = [...presets.filter((p) => p.name !== clean), { name: clean, ...current }];
    setPresets(next);
    await persist(next);
    setName("");
    setSaveOpen(false);
  };

  const remove = async (n: string) => {
    const next = presets.filter((p) => p.name !== n);
    setPresets(next);
    await persist(next);
  };

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: "center" }}>
        {presets.map((p) => (
          <Pressable
            key={p.name}
            onPress={() => onApply(p)}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border }}
          >
            <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.text }}>{p.name}</Text>
            <Pressable onPress={() => remove(p.name)} hitSlop={8}>
              <Ionicons name="close" size={13} color={colors.textFaint} />
            </Pressable>
          </Pressable>
        ))}
        <Pressable
          onPress={() => setSaveOpen(true)}
          style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.blue }}
        >
          <Ionicons name="bookmark-outline" size={13} color={colors.blue} />
          <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.blue }}>{t("admin.trips.savePreset")}</Text>
        </Pressable>
      </ScrollView>

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title={t("admin.trips.savePresetTitle")}>
        <Input label={t("admin.trips.presetName")} value={name} onChange={setName} placeholder={t("admin.trips.presetNamePlaceholder")} />
        <Button onPress={save} disabled={!name.trim()} style={{ marginTop: 12 }}>
          {t("admin.trips.savePreset")}
        </Button>
      </Modal>
    </View>
  );
}
