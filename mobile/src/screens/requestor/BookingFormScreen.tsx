import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { useNavigation, useRoute } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { RequestorTabParamList } from "../../navigation/types";
import {
  useRouteTypes,
  useConsignees,
  useCreateTrip,
  useUpdateTrip,
  useTrip,
  useTrips,
  useUploadTripDocument,
  CONSIGNEE_SEARCH_MIN,
} from "../../hooks/queries";
import { apiErrorMessage } from "../../services/api";
import { colors, layout, radius, shadow } from "../../theme";
import { useWide } from "../../hooks/useWide";
import { Button } from "../../components/Button";
import { FieldLabel, PressableField } from "../../components/Field";
import { OptionsModal } from "../../components/OptionsModal";
import { NewConsigneeModal } from "../../components/NewConsigneeModal";
import { LoadingState } from "../../components/States";
import { useToast } from "../../components/Toast";
import { pickDocumentImage, PickedPhoto } from "../../lib/photo";
import { palletEquivalents, type PalletSize } from "../../lib/pallets";
import { pickupToSlot, tripRemarks } from "../../lib/bookingEdit";
import { formatDate, formatTime } from "../../lib/format";
import { Consignee, Trip } from "../../types";

type Nav = BottomTabNavigationProp<RequestorTabParamList>;

// Grab-style flow: 3 steps. Date/time/remarks (all defaulted) folded into the
// final Confirm step so there's no near-empty "When" page.
const STEPS = ["stepWhere", "stepWhat", "stepConfirm"] as const;
// Display order (commonest first) — deliberately NOT the lib's order; palletQtys
// is indexed by this. Typed as PalletSize so an ASCII "4x4" here fails to
// compile rather than shipping a line the server's enum rejects.
const PALLET_SIZES: PalletSize[] = ["4×4", "3×4", "4×8", "5×10", "2×2"];

// Parse the optional "estimated pallets of space" field for carton/Others cargo:
// a positive whole number, or undefined when blank (→ manual admin assignment).
function parsedEstimate(v: string): number | undefined {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// Soft cap: the largest truck (PLX 2406) holds 16 pallets measured in
// 4×4-EQUIVALENTS — the same units the server enforces (a 5×10 occupies
// ~3 slots, a 2×2 a quarter). We don't hard-block — admin picks the actual
// truck and can split a load — but we warn past this so the requestor knows
// a big order may need more than one truck instead of hitting
// CARGO_EXCEEDS_FLEET at submit.
const LARGEST_TRUCK_PALLETS = 16;

// Recent-consignee chips truncate long company names so they don't overflow the
// chip; the full name still shows once the consignee is selected as a stop.
const RECENT_CHIP_MAX_CHARS = 25;
const truncateName = (name: string) =>
  name.length > RECENT_CHIP_MAX_CHARS ? `${name.slice(0, RECENT_CHIP_MAX_CHARS)}…` : name;

// Default pickup = the NEXT bookable slot, never a fixed "Today 09:00": the
// server rejects past pickups at create, so a fixed morning default would make
// every same-day afternoon booking fail until the user noticed the time field.
// Next full hour inside the 08:00–18:00 picker window; past 17:00, roll to
// tomorrow 08:00.
function nextBookableSlot(): { dayOffset: number; hour: number } {
  const nextHour = new Date().getHours() + 1;
  if (nextHour <= 8) return { dayOffset: 0, hour: 8 };
  if (nextHour <= 18) return { dayOffset: 0, hour: nextHour };
  return { dayOffset: 1, hour: 8 };
}

export function BookingFormScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const wide = useWide();

  // Mounted two ways: as the NewBooking TAB (no params → create) and as the
  // pushed EditBooking stack screen ({ tripId } → edit a still-pending booking).
  const routeParams = useRoute().params as { tripId?: string } | undefined;
  const editTripId = routeParams?.tripId;
  const isEdit = Boolean(editTripId);

  const { data: routeTypes = [], isLoading: rtLoading } = useRouteTypes();
  const { data: trips = [] } = useTrips();
  const { data: editTrip } = useTrip(editTripId ?? "");
  const createTrip = useCreateTrip();
  const updateTrip = useUpdateTrip();
  const uploadDoc = useUploadTripDocument();
  const toast = useToast();

  // Most recent booking drives "Rebook last trip"; its consignees (plus those of
  // earlier trips) become 1-tap "recent" chips so a requestor rarely has to type.
  const sortedTrips = useMemo(
    () => [...trips].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [trips]
  );
  const lastTrip = sortedTrips[0];
  const recentConsignees = useMemo(() => {
    const seen = new Set<string>();
    const out: Consignee[] = [];
    for (const tr of sortedTrips) {
      for (const s of tr.stops ?? []) {
        if (s.consignee && !seen.has(s.consignee.id)) {
          seen.add(s.consignee.id);
          out.push(s.consignee);
        }
      }
    }
    return out.slice(0, 6);
  }, [sortedTrips]);

  const [step, setStep] = useState(0);
  const [routeTypeId, setRouteTypeId] = useState<string | undefined>();
  const [stops, setStops] = useState<Consignee[]>([]);
  const [cargoType, setCargoType] = useState<"pallet" | "carton" | "others">("pallet");
  const [palletQtys, setPalletQtys] = useState<number[]>([0, 0, 0, 0, 0]);
  const [cartonQty, setCartonQty] = useState(0);
  const [othersText, setOthersText] = useState("");
  // Optional 4×4-pallet estimate for carton/Others cargo (blank → manual dispatch).
  const [sizeEstimate, setSizeEstimate] = useState("");
  const [remarks, setRemarks] = useState("");

  // Date/time chosen from quick pickers (no native datepicker dependency).
  const [dayOffset, setDayOffset] = useState(() => nextBookableSlot().dayOffset);
  const [hour, setHour] = useState(() => nextBookableSlot().hour);
  const [dayOpen, setDayOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);

  // Documents (DO / invoice) attached on the review screen. The trip doesn't
  // exist yet, so we hold the picked files here and upload them right after the
  // trip is created (see onNext).
  const [docs, setDocs] = useState<PickedPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);

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
  // Capacity is judged in 4×4-equivalents (mirrors the server): 6× 5×10 is
  // 18.75 slots (warn!), 16× 2×2 only 4 (don't).
  const totalEquivalents = palletEquivalents(
    PALLET_SIZES.map((size, i) => ({ pallet_type: size, quantity: palletQtys[i] }))
  );

  const isLastStep = step === STEPS.length - 1;

  // Running cargo summary — shown on the Confirm step AND (on PC) in the
  // always-visible summary rail. `cargoIsSet` gates the rail's placeholder.
  const cargoIsSet =
    cargoType === "pallet" ? totalPallets > 0 : cargoType === "carton" ? cartonQty > 0 : othersText.trim().length > 0;
  const cargoSummaryText =
    cargoType === "pallet"
      ? `${totalPallets} ${t("booking.pallet")}`
      : cargoType === "carton"
        ? `${cartonQty} ${t("booking.carton")}`
        : othersText;

  const resetForm = () => {
    setStep(0);
    setRouteTypeId(undefined);
    setStops([]);
    setCargoType("pallet");
    setPalletQtys([0, 0, 0, 0, 0]);
    setCartonQty(0);
    setOthersText("");
    setSizeEstimate("");
    setRemarks("");
    const slot = nextBookableSlot();
    setDayOffset(slot.dayOffset);
    setHour(slot.hour);
    setDocs([]);
    setError(null);
  };

  const onAddDoc = async () => {
    setError(null);
    try {
      const photo = await pickDocumentImage();
      if (!photo) return; // cancelled or permission denied
      setDocs((prev) => [...prev, photo]);
    } catch (e) {
      toast(apiErrorMessage(e), "error");
    }
  };

  const onRemoveDoc = (index: number) => setDocs((prev) => prev.filter((_, i) => i !== index));

  // "Rebook last trip" — copy route type, stops and cargo from a past trip and
  // jump straight to Confirm (date/time keep today's defaults).
  const prefillFromTrip = (tr: Trip) => {
    setError(null);
    if (tr.route_type_id) setRouteTypeId(tr.route_type_id);
    setStops((tr.stops ?? []).map((s) => s.consignee).filter((c): c is Consignee => Boolean(c)));

    const lines = tr.cargo_details ?? [];
    const custom = lines.find((l) => l.pallet_type === "custom");
    const carton = lines.find((l) => l.pallet_type === "carton");
    const estLine = custom ?? carton;
    setSizeEstimate(estLine?.estimated_pallets != null ? String(estLine.estimated_pallets) : "");
    if (custom) {
      setCargoType("others");
      setOthersText(custom.custom_size ?? "");
    } else if (carton) {
      setCargoType("carton");
      setCartonQty(carton.cartons ?? carton.quantity ?? 0);
    } else {
      setCargoType("pallet");
      setPalletQtys(PALLET_SIZES.map((size) => lines.find((l) => l.pallet_type === size)?.quantity ?? 0));
    }
    setStep(STEPS.length - 1); // jump to Confirm
  };

  // EDIT mode: seed the wizard from the booking once it loads (cache-first —
  // it's the trip the detail screen just displayed). Reuses the rebook mapping,
  // plus the two things rebook deliberately skips: remarks and the pickup slot.
  // An unrepresentable pickup (drifted past, outside picker buckets) keeps the
  // next-bookable default — visibly a new time on the Confirm step.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isEdit || !editTrip || seededRef.current) return;
    seededRef.current = true;
    prefillFromTrip(editTrip);
    setRemarks(tripRemarks(editTrip.cargo_details));
    const slot = pickupToSlot(editTrip.pickup_datetime, new Date());
    if (slot) {
      setDayOffset(slot.dayOffset);
      setHour(slot.hour);
    }
  }, [isEdit, editTrip]);

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
    const estimate = parsedEstimate(sizeEstimate);
    if (cargoType === "carton") {
      return [{ pallet_type: "carton", quantity: cartonQty, cartons: cartonQty, estimated_pallets: estimate, remark: remarks || undefined }];
    }
    if (cargoType === "others") {
      return [{ pallet_type: "custom", quantity: 1, custom_size: othersText.trim(), estimated_pallets: estimate, remark: remarks || undefined }];
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
    setSubmitting(true);
    try {
      const payload = {
        route_type_id: routeTypeId!,
        pickup_datetime: pickupDate.toISOString(),
        stops: stops.map((c) => ({ consignee_id: c.id })),
        cargo_details: buildCargo(),
      };

      if (isEdit && editTripId) {
        // EDIT: save over the existing pending booking, then return to its
        // detail screen (invalidation re-fetches it). Docs attached during the
        // edit upload against the existing trip, same partial-failure rule as
        // create. A 400/409 (assigned meanwhile) surfaces in the error text.
        await updateTrip.mutateAsync({ tripId: editTripId, input: payload });
        let editDocFailed = false;
        for (const photo of docs) {
          try {
            await uploadDoc.mutateAsync({ tripId: editTripId, photo, type: "other" });
          } catch {
            editDocFailed = true;
          }
        }
        if (editDocFailed) toast(t("booking.docUploadPartial"), "error");
        toast(t("booking.updatedToast"), "success");
        navigation.goBack();
        return;
      }

      const trip = await createTrip.mutateAsync(payload);
      // Upload any documents attached on the review screen against the new trip.
      // A failed upload must not hide the (already created) booking — flag it and
      // let the requestor add it later from the booking details.
      let docFailed = false;
      for (const photo of docs) {
        try {
          await uploadDoc.mutateAsync({ tripId: trip.id, photo, type: "other" });
        } catch {
          docFailed = true;
        }
      }
      setTicket(trip.ticket_number);
      if (docFailed) toast(t("booking.docUploadPartial"), "error");
    } catch (e) {
      setError(apiErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onBack = () => {
    setError(null);
    if (step === 0) {
      // Edit mode is a pushed screen — back returns to the booking's detail.
      if (isEdit) navigation.goBack();
      else navigation.navigate("Home");
    } else setStep(step - 1);
  };

  if (rtLoading || (isEdit && !editTrip)) return <View style={styles.fill}><LoadingState /></View>;

  // ── Shared pieces (composed differently for phone vs PC) ──
  const stepper = (
    <View style={styles.stepBar}>
      <View style={styles.stepBarRow}>
        {STEPS.map((s, i) => (
          <View key={s} style={styles.stepItem}>
            <View
              style={[
                styles.stepDot,
                i < step && { backgroundColor: colors.green, borderColor: colors.green },
                i === step && { backgroundColor: colors.blue, borderColor: colors.blue },
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
    </View>
  );

  const stepContent = (
    <>
      {step === 0 && (
        <StepWhere
          wide={wide}
          routeTypes={routeTypes}
          routeTypeId={routeTypeId}
          setRouteTypeId={setRouteTypeId}
          stops={stops}
          setStops={setStops}
          recent={recentConsignees}
          canRebook={Boolean(lastTrip) && !isEdit}
          onRebook={() => lastTrip && prefillFromTrip(lastTrip)}
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
          sizeEstimate={sizeEstimate}
          setSizeEstimate={setSizeEstimate}
          totalPallets={totalPallets}
          totalEquivalents={totalEquivalents}
        />
      )}
      {step === 2 && (
        <StepConfirm
          routeTypeName={routeTypes.find((r) => r.id === routeTypeId)?.name}
          stops={stops}
          cargoSummaryText={cargoSummaryText}
          pickupDate={pickupDate}
          remarks={remarks}
          setRemarks={setRemarks}
          onPickDate={() => setDayOpen(true)}
          onPickTime={() => setTimeOpen(true)}
          onEditStep={setStep}
          docs={docs}
          onAddDoc={onAddDoc}
          onRemoveDoc={onRemoveDoc}
          uploadingDoc={uploadDoc.isPending}
        />
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );

  const navButtons = (
    <View style={{ flexDirection: "row", gap: 10 }}>
      {step > 0 ? (
        <Button title={t("common.back")} variant="outline" onPress={onBack} style={{ flex: 1 }} />
      ) : null}
      <Button
        title={isLastStep ? t(isEdit ? "booking.saveChanges" : "booking.submit") : t("common.next")}
        onPress={onNext}
        loading={submitting}
        variant={isLastStep ? "accent" : "primary"}
        size="xl"
        style={{ flex: step > 0 ? 2 : 1 }}
        icon={
          isLastStep ? (
            <Ionicons name="checkmark" size={20} color={colors.navy} />
          ) : (
            <Ionicons name="arrow-forward" size={20} color={colors.white} />
          )
        }
      />
    </View>
  );

  return (
    <View style={styles.fill}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <TouchableOpacity onPress={onBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={colors.white} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t(isEdit ? "booking.editTitle" : "booking.newRequest")}</Text>
      </View>

      {wide ? (
        // ── Wide (PC) — a self-contained form card beside a live summary rail ──
        <ScrollView contentContainerStyle={styles.wideScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.wideRow}>
            <View style={styles.formCard}>
              {stepper}
              <View style={styles.formCardBody}>
                {stepContent}
                <View style={styles.formFooter}>{navButtons}</View>
              </View>
            </View>
            <View style={styles.summaryRail}>
              <Text style={styles.summaryTitle}>{t("booking.summary")}</Text>

              <Text style={styles.summaryKey}>{t("booking.routeType")}</Text>
              <Text style={styles.summaryVal}>
                {routeTypes.find((r) => r.id === routeTypeId)?.name ?? "—"}
              </Text>

              <Text style={styles.summaryKey}>{t("booking.consignee")}</Text>
              {stops.length === 0 ? (
                <Text style={styles.summaryMuted}>{t("booking.noStopsYet")}</Text>
              ) : (
                stops.map((c, i) => (
                  <View key={c.id} style={styles.summaryStop}>
                    <View style={styles.summaryStopSeq}>
                      <Text style={styles.summaryStopSeqText}>{i + 1}</Text>
                    </View>
                    <Text style={styles.summaryStopName} numberOfLines={1}>{c.company_name}</Text>
                  </View>
                ))
              )}

              <Text style={styles.summaryKey}>{t("trip.cargo")}</Text>
              <Text style={cargoIsSet ? styles.summaryVal : styles.summaryMuted}>
                {cargoIsSet ? cargoSummaryText : "—"}
              </Text>

              <Text style={styles.summaryKey}>{t("booking.schedule")}</Text>
              <Text style={styles.summaryVal}>
                {formatDate(pickupDate)}, {formatTime(pickupDate)}
              </Text>

              {docs.length > 0 ? (
                <>
                  <Text style={styles.summaryKey}>{t("booking.documents")}</Text>
                  <Text style={styles.summaryVal}>{t("booking.summaryDocs", { count: docs.length })}</Text>
                </>
              ) : null}
            </View>
          </View>
        </ScrollView>
      ) : (
        // ── Narrow (phone) — the shipped stacked wizard, unchanged ──
        <>
          {stepper}
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {stepContent}
          </ScrollView>
          <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>{navButtons}</View>
        </>
      )}

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
  wide,
  routeTypes,
  routeTypeId,
  setRouteTypeId,
  stops,
  setStops,
  recent,
  canRebook,
  onRebook,
}: {
  wide: boolean;
  routeTypes: { id: string; name: string }[];
  routeTypeId?: string;
  setRouteTypeId: (id: string) => void;
  stops: Consignee[];
  setStops: React.Dispatch<React.SetStateAction<Consignee[]>>;
  recent: Consignee[];
  canRebook: boolean;
  onRebook: () => void;
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

  // Recent consignees not already added — surfaced as 1-tap chips.
  const recentAvailable = recent.filter((c) => !stops.some((s) => s.id === c.id));

  return (
    <View>
      {canRebook ? (
        <TouchableOpacity style={styles.rebookBtn} onPress={onRebook} activeOpacity={0.85}>
          <Ionicons name="repeat" size={18} color={colors.white} />
          <Text style={styles.rebookText}>{t("booking.rebookLast")}</Text>
        </TouchableOpacity>
      ) : null}

      <FieldLabel>{t("booking.routeType")}</FieldLabel>
      <View style={styles.routeGrid}>
        {routeTypes.map((r) => {
          const active = routeTypeId === r.id;
          return (
            <TouchableOpacity
              key={r.id}
              style={[styles.routeCard, wide && styles.routeCardWide, active && styles.routeCardActive]}
              onPress={() => setRouteTypeId(r.id)}
            >
              <Text style={[styles.routeCardText, active && { color: colors.blue }]}>{r.name}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <FieldLabel>{t("booking.consignee")}</FieldLabel>

      {/* Recent consignees — tap to add without typing (Grab-style) */}
      {recentAvailable.length > 0 ? (
        <View style={styles.recentWrap}>
          <Text style={styles.recentLabel}>{t("booking.recentConsignees")}</Text>
          <View style={styles.recentChips}>
            {recentAvailable.map((c) => (
              <TouchableOpacity key={c.id} style={styles.recentChip} onPress={() => addStop(c)}>
                <Ionicons name="add" size={14} color={colors.blue} />
                <Text style={styles.recentChipText} numberOfLines={1}>
                  {truncateName(c.company_name)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      ) : null}

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
      <Text style={styles.searchFromLabel}>{t("booking.searchFrom")}</Text>
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

      {search.trim().length >= CONSIGNEE_SEARCH_MIN ? (
        <View style={styles.results}>
          {results.slice(0, 10).map((c) => (
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
      ) : search.trim().length > 0 ? (
        <Text style={styles.searchHint}>{t("booking.searchMinHint", { count: CONSIGNEE_SEARCH_MIN })}</Text>
      ) : null}

      {/* Last-resort manual entry — subtle, below the search results. */}
      <TouchableOpacity style={styles.addNew} onPress={() => setNewOpen(true)}>
        <Ionicons name="create-outline" size={14} color={colors.textMuted} />
        <Text style={styles.addNewText}>{t("booking.addManually")}</Text>
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
  sizeEstimate,
  setSizeEstimate,
  totalPallets,
  totalEquivalents,
}: {
  cargoType: "pallet" | "carton" | "others";
  setCargoType: (v: "pallet" | "carton" | "others") => void;
  palletQtys: number[];
  setPalletQtys: React.Dispatch<React.SetStateAction<number[]>>;
  cartonQty: number;
  setCartonQty: React.Dispatch<React.SetStateAction<number>>;
  othersText: string;
  setOthersText: (v: string) => void;
  sizeEstimate: string;
  setSizeEstimate: (v: string) => void;
  totalPallets: number;
  totalEquivalents: number;
}) {
  const { t } = useTranslation();
  // On react-native-web a single tap on a TouchableOpacity can synthesize several
  // press events (~ms apart), so one press on "+" landed 0→3. Drop any repeat
  // within 60ms — well under a human re-tap (>100ms), so fast deliberate tapping
  // still counts. Combined with the functional setState below (no stale closure),
  // each real press moves the count by exactly one.
  const lastTapRef = useRef(0);
  const oncePerTap = (fn: () => void) => {
    const now = Date.now();
    if (now - lastTapRef.current < 60) return;
    lastTapRef.current = now;
    fn();
  };
  const updateQty = (i: number, delta: number) =>
    oncePerTap(() =>
      setPalletQtys((prev) => prev.map((q, idx) => (idx === i ? Math.max(0, q + delta) : q)))
    );

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
          {totalEquivalents > LARGEST_TRUCK_PALLETS ? (
            <View style={styles.warnNote}>
              <Ionicons name="warning-outline" size={18} color="#b45309" />
              <Text style={styles.warnNoteText}>
                {t("booking.largeLoadWarning", { count: totalEquivalents })}
              </Text>
            </View>
          ) : null}
        </>
      )}

      {cargoType === "carton" && (
        <>
          <FieldLabel>{t("booking.numCartons")}</FieldLabel>
          <View style={[styles.palletRow, { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md }]}>
            <Text style={styles.palletSize}>{t("booking.carton")}</Text>
            <View style={styles.stepper}>
              <TouchableOpacity style={styles.stepBtnMinus} onPress={() => oncePerTap(() => setCartonQty((q) => Math.max(0, q - 1)))}>
                <Text style={styles.stepBtnMinusText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{cartonQty}</Text>
              <TouchableOpacity style={styles.stepBtnPlus} onPress={() => oncePerTap(() => setCartonQty((q) => q + 1))}>
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

      {/* Optional size estimate for carton/Others — lets auto-dispatch size the
          truck. Blank is fine: the booking then goes to manual admin assignment. */}
      {(cargoType === "carton" || cargoType === "others") && (
        <>
          <FieldLabel>{t("booking.estimatedPallets")}</FieldLabel>
          <TextInput
            value={sizeEstimate}
            onChangeText={(v) => setSizeEstimate(v.replace(/[^0-9]/g, ""))}
            keyboardType="number-pad"
            placeholder={t("booking.estimatedPalletsPlaceholder")}
            placeholderTextColor={colors.textFaint}
            style={styles.estimateInput}
          />
          <Text style={styles.estimateHint}>{t("booking.estimatedPalletsHint")}</Text>
        </>
      )}

      {/* Admin makes the final truck call, so reassure the requestor here. */}
      <View style={styles.cargoNote}>
        <Ionicons name="information-circle-outline" size={18} color={colors.blue} />
        <Text style={styles.cargoNoteText}>{t("booking.truckConfirmNote")}</Text>
      </View>
    </View>
  );
}

// ── Step 4: Confirm ──────────────────────────────────────────────────────
function StepConfirm({
  routeTypeName,
  stops,
  cargoSummaryText,
  pickupDate,
  remarks,
  setRemarks,
  onPickDate,
  onPickTime,
  onEditStep,
  docs,
  onAddDoc,
  onRemoveDoc,
  uploadingDoc,
}: {
  routeTypeName?: string;
  stops: Consignee[];
  cargoSummaryText: string;
  pickupDate: Date;
  remarks: string;
  setRemarks: (v: string) => void;
  onPickDate: () => void;
  onPickTime: () => void;
  onEditStep: (s: number) => void;
  docs: PickedPhoto[];
  onAddDoc: () => void;
  onRemoveDoc: (index: number) => void;
  uploadingDoc: boolean;
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

      {/* Schedule is edited inline here (date/time default to today, so the old
          standalone "When" step was just friction). */}
      <View style={styles.confirmCard}>
        <Text style={[styles.confirmTitle, { marginBottom: 10 }]}>{t("booking.schedule")}</Text>
        <PressableField
          label={t("booking.pickupDate")}
          leftIcon="calendar-outline"
          value={formatDate(pickupDate)}
          onPress={onPickDate}
        />
        <PressableField
          label={t("booking.pickupTime")}
          leftIcon="time-outline"
          value={formatTime(pickupDate)}
          onPress={onPickTime}
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
      </View>

      {/* Documents — attach DO / invoice before submitting (optional). Uploaded
          once the booking is created; can also be added later from details. */}
      <View style={styles.confirmCard}>
        <Text style={[styles.confirmTitle, { marginBottom: 6 }]}>{t("booking.documents")}</Text>
        <Text style={styles.docHint}>{t("booking.documentsHint")}</Text>

        {docs.map((d, i) => (
          <View key={`${d.uri}-${i}`} style={styles.docAttachRow}>
            <Ionicons name="document-text-outline" size={18} color={colors.blue} />
            <Text style={styles.docAttachName} numberOfLines={1}>
              {d.name}
            </Text>
            <TouchableOpacity onPress={() => onRemoveDoc(i)} hitSlop={10} disabled={uploadingDoc}>
              <Ionicons name="close-circle" size={20} color={colors.textFaint} />
            </TouchableOpacity>
          </View>
        ))}

        <TouchableOpacity style={styles.addNew} onPress={onAddDoc} disabled={uploadingDoc}>
          <Ionicons name="cloud-upload-outline" size={18} color={colors.blue} />
          <Text style={styles.addNewText}>{t("booking.attachDocument")}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  header: { backgroundColor: colors.blue, paddingHorizontal: 20, paddingBottom: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  headerTitle: { color: colors.white, fontSize: 18, fontWeight: "800" },
  stepBar: { backgroundColor: colors.white, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  stepBarRow: { flexDirection: "row", paddingHorizontal: 12, width: "100%", maxWidth: layout.content, alignSelf: "center" },
  stepItem: { flex: 1, alignItems: "center", justifyContent: "flex-start" },
  // Bigger dots + a thicker connector so the 1-2-3 progress reads instantly;
  // done = green check, current = blue, upcoming = muted (unchanged logic).
  stepDot: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.fieldBg, borderWidth: 1.5, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  stepNum: { fontSize: 14, fontWeight: "800", color: colors.textFaint },
  stepLabel: { fontSize: 12, fontWeight: "700", color: colors.textFaint, marginTop: 5, textTransform: "uppercase", letterSpacing: 0.3 },
  stepConn: { position: "absolute", top: 15, right: -50, width: 100, height: 3, borderRadius: 2, backgroundColor: "#e8ecf4", zIndex: -1 },
  body: { padding: 16, paddingBottom: 24, width: "100%", maxWidth: layout.content, alignSelf: "center" },

  // ── Wide (PC) form scaffold: a form card + a persistent summary rail ──
  // Fills the content area beside the sidebar; the row itself is capped so a
  // form never stretches to an unreadable width on an ultra-wide monitor.
  wideScroll: { width: "100%", paddingHorizontal: 28, paddingVertical: 24 },
  wideRow: { flexDirection: "row", alignItems: "flex-start", gap: 24, width: "100%", maxWidth: 1180 },
  formCard: {
    flex: 1,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    overflow: "hidden",
    ...shadow.card,
  },
  formCardBody: { padding: 24 },
  formFooter: { marginTop: 20, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.borderLight },
  summaryRail: {
    width: 300,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderLight,
    padding: 20,
    ...shadow.card,
  },
  summaryTitle: { fontSize: 13, fontWeight: "800", color: colors.blue, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 },
  summaryKey: { fontSize: 12, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 14 },
  summaryVal: { fontSize: 14, fontWeight: "600", color: colors.navy, marginTop: 4 },
  summaryMuted: { fontSize: 14, color: colors.textFaint, marginTop: 4 },
  summaryStop: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  summaryStopSeq: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  summaryStopSeqText: { color: colors.white, fontSize: 12, fontWeight: "800" },
  summaryStopName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.navy },

  rebookBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.blue,
    borderRadius: radius.md,
    paddingVertical: 14,
    marginBottom: 20,
    ...shadow.card,
  },
  rebookText: { color: colors.white, fontSize: 14, fontWeight: "700" },
  recentWrap: { marginBottom: 12 },
  recentLabel: { fontSize: 12, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 },
  recentChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  recentChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    maxWidth: "100%",
    backgroundColor: colors.tintBlue,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recentChipText: { fontSize: 14, fontWeight: "700", color: colors.blue, flexShrink: 1 },

  routeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  routeCard: { width: "48%", borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, padding: 14, backgroundColor: colors.white },
  routeCardWide: { width: "31.5%" },
  routeCardActive: { borderColor: colors.blue, borderWidth: 2, backgroundColor: colors.tintBlue },
  routeCardText: { fontSize: 14, fontWeight: "700", color: colors.navy },

  stopChip: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: radius.md, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.borderLight },
  stopSeq: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center" },
  stopSeqText: { color: colors.white, fontSize: 13, fontWeight: "800" },
  stopChipName: { fontSize: 14, fontWeight: "700", color: colors.navy },
  stopChipArea: { fontSize: 13, color: colors.textFaint, marginTop: 2 },

  searchBox: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 14, minHeight: 50 },
  searchInput: { flex: 1, fontSize: 15, color: colors.navy, paddingVertical: 12 },
  results: { backgroundColor: colors.white, borderRadius: radius.md, marginTop: 8, overflow: "hidden", ...shadow.card },
  resultRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.bg },
  resultName: { fontSize: 14, fontWeight: "600", color: colors.navy },
  resultArea: { fontSize: 13, color: colors.textFaint, marginTop: 2 },
  noResult: { padding: 14, fontSize: 14, color: colors.textMuted },
  searchHint: { paddingHorizontal: 4, paddingTop: 8, fontSize: 13, color: colors.textFaint },
  searchFromLabel: { paddingHorizontal: 4, marginBottom: 6, fontSize: 12, color: colors.textFaint },
  addNew: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, marginTop: 14, paddingVertical: 8 },
  addNewText: { fontSize: 13, fontWeight: "600", color: colors.textMuted },

  cargoTabs: { flexDirection: "row", gap: 8, marginBottom: 20 },
  cargoTab: { flex: 1, height: 44, borderRadius: radius.md, borderWidth: 2, borderColor: colors.border, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  cargoTabActive: { borderColor: colors.yellow, backgroundColor: colors.yellow },
  cargoTabText: { fontSize: 14, fontWeight: "700", color: colors.textMuted },
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
  totalPillText: { fontSize: 13, fontWeight: "700", color: colors.blue },
  warnNote: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.tintYellow, borderRadius: radius.sm, padding: 12, marginTop: 10, borderWidth: 1, borderColor: "#FCD34D" },
  warnNoteText: { flex: 1, fontSize: 13, fontWeight: "600", color: "#92400e", lineHeight: 17 },
  cargoNote: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.tintBlue, borderRadius: radius.md, padding: 12, marginTop: 20 },
  cargoNoteText: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.blue, lineHeight: 17 },
  textarea: { minHeight: 90, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, padding: 14, fontSize: 14, color: colors.navy, backgroundColor: colors.white, textAlignVertical: "top" },
  estimateInput: { borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.navy, backgroundColor: colors.white },
  estimateHint: { fontSize: 12, color: colors.textFaint, marginTop: 6 },

  confirmCard: { backgroundColor: colors.white, borderRadius: radius.md, padding: 16, marginBottom: 12, borderWidth: 1.5, borderColor: colors.borderLight },
  confirmHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  confirmTitle: { fontSize: 13, fontWeight: "700", color: colors.blue, textTransform: "uppercase", letterSpacing: 0.6 },
  editLink: { fontSize: 13, fontWeight: "700", color: colors.blue },
  confirmRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5 },
  confirmKey: { fontSize: 14, color: colors.textFaint },
  confirmVal: { fontSize: 14, fontWeight: "600", color: colors.navy, flex: 1, textAlign: "right", marginLeft: 12 },
  reviewHint: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.tintBlue, borderRadius: radius.md, padding: 14, marginBottom: 16 },
  reviewHintText: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.blue },
  docHint: { fontSize: 13, color: colors.textMuted, lineHeight: 17, marginBottom: 12 },
  docAttachRow: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.bg, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8 },
  docAttachName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.navy },

  error: { color: colors.red, fontSize: 14, fontWeight: "600", marginTop: 14 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.borderLight, width: "100%", maxWidth: layout.content, alignSelf: "center" },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 28, alignItems: "center", width: "100%" },
  modalIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.yellow, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 20, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalTicket: { fontSize: 14, fontWeight: "700", color: colors.blue, letterSpacing: 0.6, marginBottom: 8 },
  pendingChip: { backgroundColor: "#fffbeb", paddingHorizontal: 14, paddingVertical: 4, borderRadius: radius.pill },
  pendingChipText: { color: "#d97706", fontSize: 13, fontWeight: "800" },
  modalBody: { fontSize: 14, color: colors.textMuted, textAlign: "center", marginTop: 16, lineHeight: 19 },
});
