import React, { useMemo, useState } from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { RequestorTabParamList } from "../../navigation/types";
import { useRouteTypes, useConsignees, useCreateTrip } from "../../hooks/queries";
import { apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { Button } from "../../components/Button";
import { FieldLabel, PressableField } from "../../components/Field";
import { OptionsModal } from "../../components/OptionsModal";
import { NewConsigneeModal } from "../../components/NewConsigneeModal";
import { LoadingState } from "../../components/States";
import { formatDate, formatTime } from "../../lib/format";
import { Consignee } from "../../types";

type Nav = BottomTabNavigationProp<RequestorTabParamList>;

const STEPS = ["stepWhere", "stepWhat", "stepWhen", "stepConfirm"] as const;
const PALLET_SIZES = ["4×4", "3×4", "4×8", "5×10", "2×2"];

export function BookingFormScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();

  const { data: routeTypes = [], isLoading: rtLoading } = useRouteTypes();
  const createTrip = useCreateTrip();

  const [step, setStep] = useState(0);
  const [routeTypeId, setRouteTypeId] = useState<string | undefined>();
  const [stops, setStops] = useState<Consignee[]>([]);
  const [cargoType, setCargoType] = useState<"pallet" | "carton" | "others">("pallet");
  const [palletQtys, setPalletQtys] = useState<number[]>([0, 0, 0, 0, 0]);
  const [cartonQty, setCartonQty] = useState(0);
  const [othersText, setOthersText] = useState("");
  const [remarks, setRemarks] = useState("");

  // Date/time chosen from quick pickers (no native datepicker dependency).
  const [dayOffset, setDayOffset] = useState(0);
  const [hour, setHour] = useState(9);
  const [dayOpen, setDayOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);

  const pickupDate = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d;
  }, [dayOffset, hour]);

  const dayOptions = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const label = i === 0 ? `Today · ${formatDate(d)}` : i === 1 ? `Tomorrow · ${formatDate(d)}` : formatDate(d);
        return { label, value: String(i) };
      }),
    []
  );
  const timeOptions = useMemo(
    () =>
      Array.from({ length: 11 }, (_, i) => {
        const h = 8 + i; // 08:00 – 18:00
        const d = new Date();
        d.setHours(h, 0, 0, 0);
        return { label: formatTime(d), value: String(h) };
      }),
    []
  );

  const totalPallets = palletQtys.reduce((a, b) => a + b, 0);

  const isLastStep = step === STEPS.length - 1;

  const resetForm = () => {
    setStep(0);
    setRouteTypeId(undefined);
    setStops([]);
    setCargoType("pallet");
    setPalletQtys([0, 0, 0, 0, 0]);
    setCartonQty(0);
    setOthersText("");
    setRemarks("");
    setDayOffset(0);
    setHour(9);
    setError(null);
  };

  const validateStep = (): string | null => {
    if (step === 0) {
      if (!routeTypeId) return t("booking.selectRouteType");
      if (stops.length === 0) return t("booking.selectConsignee");
    }
    if (step === 1) {
      if (cargoType === "pallet" && totalPallets === 0) return t("booking.addCargo");
      if (cargoType === "carton" && cartonQty === 0) return t("booking.addCargo");
      if (cargoType === "others" && !othersText.trim()) return t("booking.addCargo");
    }
    return null;
  };

  const buildCargo = () => {
    if (cargoType === "carton") {
      return [{ pallet_type: "carton", quantity: cartonQty, cartons: cartonQty, remark: remarks || undefined }];
    }
    if (cargoType === "others") {
      return [{ pallet_type: "custom", quantity: 1, custom_size: othersText.trim(), remark: remarks || undefined }];
    }
    return PALLET_SIZES.map((size, i) => ({ pallet_type: size, quantity: palletQtys[i] }))
      .filter((c) => c.quantity > 0)
      .map((c, idx) => (idx === 0 && remarks ? { ...c, remark: remarks } : c));
  };

  const onNext = async () => {
    const err = validateStep();
    if (err) return setError(err);
    setError(null);
    if (!isLastStep) {
      setStep(step + 1);
      return;
    }
    // Submit
    try {
      const trip = await createTrip.mutateAsync({
        route_type_id: routeTypeId!,
        pickup_datetime: pickupDate.toISOString(),
        stops: stops.map((c) => ({ consignee_id: c.id })),
        cargo_details: buildCargo(),
      });
      setTicket(trip.ticket_number);
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  };

  const onBack = () => {
    setError(null);
    if (step === 0) navigation.navigate("Home");
    else setStep(step - 1);
  };

  if (rtLoading) return <View style={styles.fill}><LoadingState /></View>;

  return (
    <View style={styles.fill}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={onBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t("booking.newRequest")}</Text>
      </View>

      {/* Step indicator */}
      <View style={styles.stepBar}>
        {STEPS.map((s, i) => (
          <View key={s} style={styles.stepItem}>
            <View
              style={[
                styles.stepDot,
                i < step && { backgroundColor: colors.green },
                i === step && { backgroundColor: colors.blue },
              ]}
            >
              {i < step ? (
                <Ionicons name="checkmark" size={14} color={colors.white} />
              ) : (
                <Text style={[styles.stepNum, i === step && { color: colors.white }]}>{i + 1}</Text>
              )}
            </View>
            <Text style={[styles.stepLabel, i === step && { color: colors.blue }]}>{t(`booking.${s}`)}</Text>
            {i < STEPS.length - 1 ? (
              <View style={[styles.stepConn, i < step && { backgroundColor: colors.green }]} />
            ) : null}
          </View>
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {step === 0 && (
          <StepWhere
            routeTypes={routeTypes}
            routeTypeId={routeTypeId}
            setRouteTypeId={setRouteTypeId}
            stops={stops}
            setStops={setStops}
          />
        )}
        {step === 1 && (
          <StepWhat
            cargoType={cargoType}
            setCargoType={setCargoType}
            palletQtys={palletQtys}
            setPalletQtys={setPalletQtys}
            cartonQty={cartonQty}
            setCartonQty={setCartonQty}
            othersText={othersText}
            setOthersText={setOthersText}
            totalPallets={totalPallets}
          />
        )}
        {step === 2 && (
          <>
            <PressableField
              label={t("booking.pickupDate")}
              leftIcon="calendar-outline"
              value={formatDate(pickupDate)}
              onPress={() => setDayOpen(true)}
            />
            <PressableField
              label={t("booking.pickupTime")}
              leftIcon="time-outline"
              value={formatTime(pickupDate)}
              onPress={() => setTimeOpen(true)}
            />
            <FieldLabel>{t("booking.remarks")}</FieldLabel>
            <TextInput
              value={remarks}
              onChangeText={setRemarks}
              placeholder={t("booking.remarksPlaceholder")}
              placeholderTextColor={colors.textFaint}
              multiline
              style={styles.textarea}
            />
          </>
        )}
        {step === 3 && (
          <StepConfirm
            routeTypeName={routeTypes.find((r) => r.id === routeTypeId)?.name}
            stops={stops}
            cargoSummaryText={
              cargoType === "pallet"
                ? `${totalPallets} ${t("booking.pallet")}`
                : cargoType === "carton"
                  ? `${cartonQty} ${t("booking.carton")}`
                  : othersText
            }
            pickupDate={pickupDate}
            onEditStep={setStep}
          />
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {/* Bottom buttons */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          {step > 0 ? (
            <Button title={t("common.back")} variant="outline" onPress={onBack} style={{ flex: 1 }} />
          ) : null}
          <Button
            title={isLastStep ? t("booking.submit") : t("common.next")}
            onPress={onNext}
            loading={createTrip.isPending}
            variant={isLastStep ? "accent" : "primary"}
            style={{ flex: step > 0 ? 2 : 1 }}
            icon={
              isLastStep ? (
                <Ionicons name="checkmark" size={18} color={colors.navy} />
              ) : (
                <Ionicons name="arrow-forward" size={18} color={colors.white} />
              )
            }
          />
        </View>
      </View>

      {/* Pickers */}
      <OptionsModal
        visible={dayOpen}
        title={t("booking.pickupDate")}
        options={dayOptions}
        selectedValue={String(dayOffset)}
        onSelect={(v) => setDayOffset(Number(v))}
        onClose={() => setDayOpen(false)}
      />
      <OptionsModal
        visible={timeOpen}
        title={t("booking.pickupTime")}
        options={timeOptions}
        selectedValue={String(hour)}
        onSelect={(v) => setHour(Number(v))}
        onClose={() => setTimeOpen(false)}
      />

      {/* Success modal */}
      <Modal visible={ticket !== null} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons name="checkmark" size={32} color={colors.navy} />
            </View>
            <Text style={styles.modalTitle}>{t("booking.submittedTitle")}</Text>
            <Text style={styles.modalTicket}>{ticket}</Text>
            <View style={styles.pendingChip}>
              <Text style={styles.pendingChipText}>{t("trip.statusPending")}</Text>
            </View>
            <Text style={styles.modalBody}>{t("booking.submittedMessage")}</Text>
            <Button
              title={t("trip.backToDashboard")}
              onPress={() => {
                setTicket(null);
                resetForm();
                navigation.navigate("Home");
              }}
              style={{ alignSelf: "stretch", marginTop: 16 }}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ── Step 1: Where (route type + multi-stop consignees) ───────────────────
function StepWhere({
  routeTypes,
  routeTypeId,
  setRouteTypeId,
  stops,
  setStops,
}: {
  routeTypes: { id: string; name: string }[];
  routeTypeId?: string;
  setRouteTypeId: (id: string) => void;
  stops: Consignee[];
  setStops: React.Dispatch<React.SetStateAction<Consignee[]>>;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const { data: results = [], isFetching } = useConsignees(search);
  const [newOpen, setNewOpen] = useState(false);

  const addStop = (c: Consignee) => {
    setStops((prev) => (prev.find((s) => s.id === c.id) ? prev : [...prev, c]));
    setSearch("");
  };
  const removeStop = (id: string) => setStops((prev) => prev.filter((s) => s.id !== id));

  return (
    <View>
      <FieldLabel>{t("booking.routeType")}</FieldLabel>
      <View style={styles.routeGrid}>
        {routeTypes.map((r) => {
          const active = routeTypeId === r.id;
          return (
            <TouchableOpacity
              key={r.id}
              style={[styles.routeCard, active && styles.routeCardActive]}
              onPress={() => setRouteTypeId(r.id)}
            >
              <Text style={[styles.routeCardText, active && { color: colors.blue }]}>{r.name}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <FieldLabel>{t("booking.consignee")}</FieldLabel>
      {/* Selected stops */}
      {stops.map((c, i) => (
        <View key={c.id} style={styles.stopChip}>
          <View style={styles.stopSeq}>
            <Text style={styles.stopSeqText}>{i + 1}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.stopChipName}>{c.company_name}</Text>
            <Text style={styles.stopChipArea}>
              {[c.area, c.zone?.name ?? c.zone_code].filter(Boolean).join(" · ")}
            </Text>
          </View>
          <TouchableOpacity onPress={() => removeStop(c.id)} hitSlop={10}>
            <Ionicons name="close-circle" size={22} color={colors.textFaint} />
          </TouchableOpacity>
        </View>
      ))}

      {/* Search */}
      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.textFaint} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={t("booking.searchConsignee")}
          placeholderTextColor={colors.textFaint}
          style={styles.searchInput}
        />
        {isFetching ? <Ionicons name="ellipsis-horizontal" size={18} color={colors.textFaint} /> : null}
      </View>

      {search.length > 0 ? (
        <View style={styles.results}>
          {results.slice(0, 8).map((c) => (
            <TouchableOpacity key={c.id} style={styles.resultRow} onPress={() => addStop(c)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.resultName}>{c.company_name}</Text>
                <Text style={styles.resultArea}>
                  {[c.area, c.zone?.name ?? c.zone_code].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <Ionicons name="add-circle" size={22} color={colors.blue} />
            </TouchableOpacity>
          ))}
          {results.length === 0 && !isFetching ? (
            <Text style={styles.noResult}>{t("booking.noConsigneeFound")}</Text>
          ) : null}
        </View>
      ) : null}

      <TouchableOpacity style={styles.addNew} onPress={() => setNewOpen(true)}>
        <Ionicons name="add" size={18} color={colors.blue} />
        <Text style={styles.addNewText}>{stops.length > 0 ? t("booking.addStop") : t("booking.addNewConsignee")}</Text>
      </TouchableOpacity>

      <NewConsigneeModal visible={newOpen} onClose={() => setNewOpen(false)} onCreated={addStop} />
    </View>
  );
}

// ── Step 2: What (cargo) ─────────────────────────────────────────────────
function StepWhat({
  cargoType,
  setCargoType,
  palletQtys,
  setPalletQtys,
  cartonQty,
  setCartonQty,
  othersText,
  setOthersText,
  totalPallets,
}: {
  cargoType: "pallet" | "carton" | "others";
  setCargoType: (v: "pallet" | "carton" | "others") => void;
  palletQtys: number[];
  setPalletQtys: React.Dispatch<React.SetStateAction<number[]>>;
  cartonQty: number;
  setCartonQty: React.Dispatch<React.SetStateAction<number>>;
  othersText: string;
  setOthersText: (v: string) => void;
  totalPallets: number;
}) {
  const { t } = useTranslation();
  const updateQty = (i: number, delta: number) =>
    setPalletQtys((prev) => prev.map((q, idx) => (idx === i ? Math.max(0, q + delta) : q)));

  return (
    <View>
      <FieldLabel>{t("booking.cargoType")}</FieldLabel>
      <View style={styles.cargoTabs}>
        {(["pallet", "carton", "others"] as const).map((type) => {
          const active = cargoType === type;
          return (
            <TouchableOpacity
              key={type}
              style={[styles.cargoTab, active && styles.cargoTabActive]}
              onPress={() => setCargoType(type)}
            >
              <Text style={[styles.cargoTabText, active && { color: colors.navy }]}>
                {t(`booking.${type}`)}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {cargoType === "pallet" && (
        <>
          <FieldLabel>{t("booking.palletSizeQty")}</FieldLabel>
          <View style={styles.palletList}>
            {PALLET_SIZES.map((size, i) => (
              <View key={size} style={[styles.palletRow, i < PALLET_SIZES.length - 1 && styles.palletDivider]}>
                <Text style={styles.palletSize}>Pallet {size}</Text>
                <View style={styles.stepper}>
                  <TouchableOpacity style={styles.stepBtnMinus} onPress={() => updateQty(i, -1)}>
                    <Text style={styles.stepBtnMinusText}>−</Text>
                  </TouchableOpacity>
                  <Text style={styles.stepVal}>{palletQtys[i]}</Text>
                  <TouchableOpacity style={styles.stepBtnPlus} onPress={() => updateQty(i, 1)}>
                    <Text style={styles.stepBtnPlusText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))}
          </View>
          <View style={styles.totalPill}>
            <Ionicons name="cube" size={16} color={colors.blue} />
            <Text style={styles.totalPillText}>{t("booking.totalPallets", { count: totalPallets })}</Text>
          </View>
        </>
      )}

      {cargoType === "carton" && (
        <>
          <FieldLabel>{t("booking.numCartons")}</FieldLabel>
          <View style={[styles.palletRow, { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md }]}>
            <Text style={styles.palletSize}>{t("booking.carton")}</Text>
            <View style={styles.stepper}>
              <TouchableOpacity style={styles.stepBtnMinus} onPress={() => setCartonQty((q) => Math.max(0, q - 1))}>
                <Text style={styles.stepBtnMinusText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{cartonQty}</Text>
              <TouchableOpacity style={styles.stepBtnPlus} onPress={() => setCartonQty((q) => q + 1)}>
                <Text style={styles.stepBtnPlusText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {cargoType === "others" && (
        <>
          <FieldLabel>{t("booking.describeCargo")}</FieldLabel>
          <TextInput
            value={othersText}
            onChangeText={setOthersText}
            placeholder={t("booking.cargoPlaceholder")}
            placeholderTextColor={colors.textFaint}
            multiline
            style={styles.textarea}
          />
        </>
      )}
    </View>
  );
}

// ── Step 4: Confirm ──────────────────────────────────────────────────────
function StepConfirm({
  routeTypeName,
  stops,
  cargoSummaryText,
  pickupDate,
  onEditStep,
}: {
  routeTypeName?: string;
  stops: Consignee[];
  cargoSummaryText: string;
  pickupDate: Date;
  onEditStep: (s: number) => void;
}) {
  const { t } = useTranslation();
  const Section = ({ title, editStep, children }: { title: string; editStep: number; children: React.ReactNode }) => (
    <View style={styles.confirmCard}>
      <View style={styles.confirmHead}>
        <Text style={styles.confirmTitle}>{title}</Text>
        <TouchableOpacity onPress={() => onEditStep(editStep)}>
          <Text style={styles.editLink}>{t("booking.edit")}</Text>
        </TouchableOpacity>
      </View>
      {children}
    </View>
  );
  const Row = ({ k, v }: { k: string; v: string }) => (
    <View style={styles.confirmRow}>
      <Text style={styles.confirmKey}>{k}</Text>
      <Text style={styles.confirmVal}>{v}</Text>
    </View>
  );

  return (
    <View>
      <View style={styles.reviewHint}>
        <Ionicons name="information-circle-outline" size={18} color={colors.blue} />
        <Text style={styles.reviewHintText}>{t("booking.reviewHint")}</Text>
      </View>

      <Section title={t("booking.route")} editStep={0}>
        <Row k={t("booking.routeType")} v={routeTypeName ?? "—"} />
        {stops.map((c, i) => (
          <Row key={c.id} k={t("booking.stopN", { n: i + 1 })} v={c.company_name} />
        ))}
      </Section>

      <Section title={t("booking.stepWhat")} editStep={1}>
        <Row k={t("trip.cargo")} v={cargoSummaryText} />
      </Section>

      <Section title={t("booking.schedule")} editStep={2}>
        <Row k={t("booking.pickupDate")} v={formatDate(pickupDate)} />
        <Row k={t("booking.pickupTime")} v={formatTime(pickupDate)} />
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  headerTitle: { color: colors.white, fontSize: 18, fontWeight: "700" },
  stepBar: { flexDirection: "row", backgroundColor: colors.white, paddingHorizontal: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  stepItem: { flex: 1, alignItems: "center", justifyContent: "flex-start" },
  stepDot: { width: 28, height: 28, borderRadius: 14, backgroundColor: "#e8ecf4", alignItems: "center", justifyContent: "center" },
  stepNum: { fontSize: 12, fontWeight: "700", color: colors.textFaint },
  stepLabel: { fontSize: 11, fontWeight: "700", color: colors.textFaint, marginTop: 4, textTransform: "uppercase" },
  stepConn: { position: "absolute", top: 14, right: -50, width: 100, height: 2, backgroundColor: "#e8ecf4", zIndex: -1 },
  body: { padding: 16, paddingBottom: 24 },

  routeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  routeCard: { width: "48%", borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, padding: 14, backgroundColor: colors.white },
  routeCardActive: { borderColor: colors.blue, borderWidth: 2, backgroundColor: colors.tintBlue },
  routeCardText: { fontSize: 13, fontWeight: "700", color: colors.navy },

  stopChip: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: radius.md, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.borderLight },
  stopSeq: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  stopSeqText: { color: colors.white, fontSize: 12, fontWeight: "800" },
  stopChipName: { fontSize: 14, fontWeight: "700", color: colors.navy },
  stopChipArea: { fontSize: 12, color: colors.textFaint, marginTop: 2 },

  searchBox: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 14, minHeight: 50 },
  searchInput: { flex: 1, fontSize: 15, color: colors.navy, paddingVertical: 12 },
  results: { backgroundColor: colors.white, borderRadius: radius.md, marginTop: 8, overflow: "hidden", ...shadow.card },
  resultRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.bg },
  resultName: { fontSize: 14, fontWeight: "600", color: colors.navy },
  resultArea: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
  noResult: { padding: 14, fontSize: 13, color: colors.textMuted },
  addNew: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 12, paddingVertical: 12, borderRadius: radius.md, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.blue },
  addNewText: { fontSize: 14, fontWeight: "700", color: colors.blue },

  cargoTabs: { flexDirection: "row", gap: 8, marginBottom: 20 },
  cargoTab: { flex: 1, height: 44, borderRadius: radius.md, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  cargoTabActive: { borderColor: colors.yellow, backgroundColor: colors.yellow },
  cargoTabText: { fontSize: 13, fontWeight: "700", color: colors.textMuted },
  palletList: { backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, overflow: "hidden" },
  palletRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14 },
  palletDivider: { borderBottomWidth: 1, borderBottomColor: colors.bg },
  palletSize: { fontSize: 14, fontWeight: "700", color: colors.navy },
  stepper: { flexDirection: "row", alignItems: "center", gap: 14 },
  stepBtnMinus: { width: 32, height: 32, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.fieldBg, alignItems: "center", justifyContent: "center" },
  stepBtnMinusText: { fontSize: 20, fontWeight: "700", color: colors.textMuted },
  stepBtnPlus: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  stepBtnPlusText: { fontSize: 20, fontWeight: "700", color: colors.white },
  stepVal: { fontSize: 16, fontWeight: "800", color: colors.navy, minWidth: 24, textAlign: "center" },
  totalPill: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.tintBlue, borderRadius: radius.sm, padding: 12, marginTop: 10 },
  totalPillText: { fontSize: 12, fontWeight: "700", color: colors.blue },
  textarea: { minHeight: 90, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, padding: 14, fontSize: 14, color: colors.navy, backgroundColor: colors.white, textAlignVertical: "top" },

  confirmCard: { backgroundColor: colors.white, borderRadius: radius.md, padding: 16, marginBottom: 12, borderWidth: 1.5, borderColor: colors.borderLight },
  confirmHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  confirmTitle: { fontSize: 12, fontWeight: "700", color: colors.blue, textTransform: "uppercase", letterSpacing: 0.6 },
  editLink: { fontSize: 12, fontWeight: "700", color: colors.blue },
  confirmRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  confirmKey: { fontSize: 13, color: colors.textFaint },
  confirmVal: { fontSize: 13, fontWeight: "600", color: colors.navy, flex: 1, textAlign: "right", marginLeft: 12 },
  reviewHint: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.tintBlue, borderRadius: radius.md, padding: 14, marginBottom: 16 },
  reviewHintText: { flex: 1, fontSize: 12, fontWeight: "600", color: colors.blue },

  error: { color: colors.red, fontSize: 13, fontWeight: "600", marginTop: 14 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.borderLight },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 28, alignItems: "center", width: "100%" },
  modalIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 20, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalTicket: { fontSize: 13, fontWeight: "700", color: colors.blue, letterSpacing: 0.6, marginBottom: 8 },
  pendingChip: { backgroundColor: "#fffbeb", paddingHorizontal: 14, paddingVertical: 4, borderRadius: radius.pill },
  pendingChipText: { color: "#d97706", fontSize: 12, fontWeight: "800" },
  modalBody: { fontSize: 13, color: colors.textMuted, textAlign: "center", marginTop: 16, lineHeight: 19 },
});
