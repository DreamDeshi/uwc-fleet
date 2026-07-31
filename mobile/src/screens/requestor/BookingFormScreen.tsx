import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { RequestorTabParamList } from "../../navigation/types";
import {
  useRouteTypes,
  useConsignees,
  useCreateTrip,
  useUpdateTrip,
  useRequestTripChange,
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
import {
  palletEquivalents,
  partitionEditableCargo,
  finalizeCargoPayload,
  isValidDimension,
  canonicalCargoSize,
  type BookablePalletSize,
  type OutgoingCargoLine,
} from "../../lib/pallets";
import {
  loadTemplates,
  persistTemplates,
  palletsMap,
  upsertTemplate,
  removeTemplate,
  templateToForm,
  type BookingTemplate,
} from "../../lib/bookingTemplates";
import {
  firstBookingIssue,
  STEP_CONFIRM,
  type BookingDraft,
} from "../../lib/bookingSteps";
import {
  pickupToSlot,
  tripRemarks,
  PICKUP_HOURS,
  PICKUP_WINDOW_START_HOUR,
  PICKUP_WINDOW_END_HOUR,
} from "../../lib/bookingEdit";
import { formatDate, formatTime } from "../../lib/format";
import { uuidv4 } from "../../lib/uuid";
import { Consignee, Trip } from "../../types";
import { changeRequestsEnabled } from "../../lib/featureFlags";

type Nav = BottomTabNavigationProp<RequestorTabParamList>;

// Grab-style flow: 3 steps. Date/time/remarks (all defaulted) folded into the
// final Confirm step so there's no near-empty "When" page.
const STEPS = ["stepWhere", "stepWhat", "stepConfirm"] as const;
// Display order (commonest first, then largest → smallest) — deliberately NOT
// the lib's order; palletQtys is indexed by this. Typed as BookablePalletSize so
// an ASCII "4x4" — or a re-added deprecated 1×1/1×2 (removed per Q1, R1
// 2026-07-24: those are boxes, not pallets) — fails to compile rather than
// shipping a line the server's booking enum now rejects.
const PALLET_SIZES: BookablePalletSize[] = [
  "4×4",
  "3×4",
  "4×8",
  "5×10",
  "5×5",
  "3×3",
  "2×3",
  "2×2",
];

// Soft cap: the largest truck (PLX 2406) holds 16 pallets measured in
// 4×4-EQUIVALENTS — the same units the server enforces (a 5×10 occupies
// ~3 slots, a 2×2 a quarter). We don't hard-block — admin picks the actual
// truck and can split a load — but we warn past this so the requestor knows
// a big order may need more than one truck instead of hitting
// CARGO_EXCEEDS_FLEET at submit.
//
// STAYS 16 after the 28 Jul 2026 revision, deliberately: PLX went interplant
// (out of AUTO dispatch), but the owner-decided booking ceiling is fleet max —
// a 15–16-pallet order is accepted and falls to MANUAL, where the admin may
// cross-assign PLX as backup (email pt 6) or use an external lorry.
const LARGEST_TRUCK_PALLETS = 16;

// A loaded API cargo line → the outgoing shape, preserving every field so a
// legacy line re-appends verbatim on save.
function toOutgoingCargo(l: {
  pallet_type: string;
  quantity: number;
  cartons?: number | null;
  custom_size?: string | null;
  width_ft?: number | null;
  length_ft?: number | null;
  estimated_pallets?: number | null;
}): OutgoingCargoLine {
  return {
    pallet_type: l.pallet_type,
    quantity: l.quantity,
    cartons: l.cartons ?? undefined,
    custom_size: l.custom_size ?? undefined,
    width_ft: l.width_ft ?? undefined,
    length_ft: l.length_ft ?? undefined,
    estimated_pallets: l.estimated_pallets ?? undefined,
  };
}

// Recent-consignee chips truncate long company names so they don't overflow the
// chip; the full name still shows once the consignee is selected as a stop.
const RECENT_CHIP_MAX_CHARS = 25;
const truncateName = (name: string) =>
  name.length > RECENT_CHIP_MAX_CHARS ? `${name.slice(0, RECENT_CHIP_MAX_CHARS)}…` : name;

// Default pickup = the NEXT bookable slot, never a fixed "Today 09:00": the
// server rejects past pickups at create, so a fixed morning default would make
// every same-day afternoon booking fail until the user noticed the time field.
// Next full hour inside the 07:00–02:00 picker window.
//
// The window wraps midnight (item 12), so the roll-forward has three cases
// rather than two. Note 23:00 + 1 = 24:00 is midnight TOMORROW: it stays a
// valid pickup, but as hour 0 on dayOffset 1 — the one case where "the next
// hour" changes the calendar day.
function nextBookableSlot(): { dayOffset: number; hour: number } {
  const nextHour = new Date().getHours() + 1;
  // Small hours (now 00:00–01:59 → next 01:00–02:00): still today's tail of
  // yesterday's shift.
  if (nextHour <= PICKUP_WINDOW_END_HOUR) return { dayOffset: 0, hour: nextHour };
  // The closed gap (now 02:00–05:59 → next 03:00–06:59): wait for today's open.
  if (nextHour <= PICKUP_WINDOW_START_HOUR) return { dayOffset: 0, hour: PICKUP_WINDOW_START_HOUR };
  // Inside the day, up to and including 23:00.
  if (nextHour <= 23) return { dayOffset: 0, hour: nextHour };
  // 23:00 → midnight: hour 0 of the NEXT calendar day, still this shift.
  return { dayOffset: 1, hour: 0 };
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

  const {
    data: routeTypes = [],
    isLoading: rtLoading,
    isError: rtError,
    refetch: refetchRouteTypes,
  } = useRouteTypes();
  const { data: trips = [] } = useTrips();
  const { data: editTrip } = useTrip(editTripId ?? "");
  const createTrip = useCreateTrip();
  const updateTrip = useUpdateTrip();
  const requestChange = useRequestTripChange();
  // ASSIGNED bookings go through the approval queue instead of writing
  // directly (Mr. Teh A19). Derived from the LOADED trip, never from a nav
  // param, so a booking assigned while this screen was open still routes
  // correctly rather than attempting a write the server would refuse.
  const isChangeRequest = changeRequestsEnabled() && isEdit && editTrip?.status === "assigned";
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
  const [cargoType, setCargoType] = useState<"pallet" | "box" | "crate" | "rack" | "custom">("pallet");
  // Index-aligned with PALLET_SIZES — DERIVE the length, never hard-code it.
  // This was [0, 0, 0, 0, 0] when there were five sizes; item 2 took the list
  // to ten and left the array at five, so the five new sizes rendered blank,
  // their +/− did nothing (updateQty's .map can't grow an array), and
  // buildCargo dropped them silently because `undefined > 0` is false.
  const [palletQtys, setPalletQtys] = useState<number[]>(() => PALLET_SIZES.map(() => 0));
  // Deprecated (1×1/1×2) lines carried in from a historical booking on edit. They
  // are NOT selectable/editable via the steppers — kept read-only and re-appended
  // verbatim on save so an unrelated edit can never silently drop them. Removal is
  // possible only via a deliberate per-row action (see the legacy list render).
  // Legacy cargo carried in from a historical booking on edit (deprecated 1×1/1×2,
  // legacy carton, and legacy free-text custom). Read-only; preserved VERBATIM
  // (full line) and re-appended on save so an unrelated edit never drops/rewrites it.
  const [legacyCargo, setLegacyCargo] = useState<OutgoingCargoLine[]>([]);
  // Q10: Box is a count only (no dimensions). Crate/Rack/Custom carry structured
  // width_ft × length_ft (feet) + a count.
  const [boxQty, setBoxQty] = useState(0);
  const [dimW, setDimW] = useState("");
  const [dimL, setDimL] = useState("");
  const [dimQty, setDimQty] = useState(1);
  const [remarks, setRemarks] = useState("");

  // Date/time chosen from quick pickers (no native datepicker dependency).
  const [dayOffset, setDayOffset] = useState(() => nextBookableSlot().dayOffset);
  const [hour, setHour] = useState(() => nextBookableSlot().hour);
  // DG-R7: the NewBooking TAB never unmounts, so these mount-time defaults
  // went stale — hours later the pre-filled slot was in the past and the
  // submit bounced with PICKUP_IN_PAST. Refresh the default every time the
  // screen regains focus, but NEVER over a slot the user (or the edit
  // prefill) explicitly chose.
  const slotTouched = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (isEdit || slotTouched.current) return;
      const slot = nextBookableSlot();
      setDayOffset(slot.dayOffset);
      setHour(slot.hour);
    }, [isEdit])
  );
  const [dayOpen, setDayOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);

  // Documents (DO / invoice) attached on the review screen. The trip doesn't
  // exist yet, so we hold the picked files here and upload them right after the
  // trip is created (see onNext).
  const [docs, setDocs] = useState<PickedPhoto[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // DG-T7 idempotency key for the create below. A ref, not state: it must
  // survive the re-render that re-arms Submit after a timeout WITHOUT itself
  // triggering one, and it must be the SAME value on the retry.
  const requestKey = useRef<string | null>(null);

  // Saved booking templates (device-local "save function"). Loaded once; the
  // name dialog is driven from here so it can be reached from the Confirm step.
  const [templates, setTemplates] = useState<BookingTemplate[]>([]);
  const [templateSaveOpen, setTemplateSaveOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  useEffect(() => {
    loadTemplates().then(setTemplates);
  }, []);

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
  // 07:00…23:00 then 00:00…02:00 — PICKUP_HOURS is already in operating-day
  // order, so the list reads the way the shift runs instead of wrapping back to
  // midnight in the middle.
  const timeOptions = useMemo(
    () =>
      PICKUP_HOURS.map((h) => {
        const d = new Date();
        d.setHours(h, 0, 0, 0);
        return { label: formatTime(d), value: String(h) };
      }),
    []
  );

  const legacyPallets = legacyCargo.reduce((a, c) => a + c.quantity, 0);
  // totalPallets counts the preserved legacy lines too, so a legacy-only edit is
  // "set" and the Confirm summary/count include them.
  const totalPallets = palletQtys.reduce((a, b) => a + b, 0) + legacyPallets;
  // Capacity is judged in 4×4-equivalents (mirrors the server): 6× 5×10 is
  // 18.75 slots (warn!), 16× 2×2 only 4 (don't).
  const totalEquivalents = palletEquivalents([
    ...PALLET_SIZES.map((size, i) => ({ pallet_type: size, quantity: palletQtys[i] })),
    ...legacyCargo, // legacy lines still occupy real slots on the server
  ]);

  const isLastStep = step === STEPS.length - 1;

  // Q10 structured dimensions (feet) for crate/rack/custom.
  const dimWNum = Number(dimW);
  const dimLNum = Number(dimL);
  const dimsOk = isValidDimension(dimWNum) && isValidDimension(dimLNum) && dimQty > 0;

  // Running cargo summary — shown on the Confirm step AND (on PC) in the
  // always-visible summary rail. `cargoIsSet` gates the rail's placeholder.
  const cargoIsSet =
    cargoType === "pallet" ? totalPallets > 0 : cargoType === "box" ? boxQty > 0 : dimsOk;
  // A template is only worth saving once it's a complete, submittable booking —
  // this guarantees a loaded template never drops the requestor onto Confirm
  // with empty cargo the server would reject.
  const canSaveTemplate = Boolean(routeTypeId) && stops.length > 0 && cargoIsSet;
  const cargoSummaryText =
    cargoType === "pallet"
      ? `${totalPallets} ${t("booking.pallet")}`
      : cargoType === "box"
        ? `${boxQty} ${t("booking.box")}`
        : dimsOk
          ? `${dimQty} × ${canonicalCargoSize(dimWNum, dimLNum)}`
          : t(`booking.${cargoType}`);

  const resetForm = () => {
    setStep(0);
    setRouteTypeId(undefined);
    setStops([]);
    setCargoType("pallet");
    setPalletQtys(PALLET_SIZES.map(() => 0));
    setLegacyCargo([]);
    setBoxQty(0);
    setDimW("");
    setDimL("");
    setDimQty(1);
    setRemarks("");
    const slot = nextBookableSlot();
    slotTouched.current = false; // fresh form — the default may auto-refresh again
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
    // Preserve deprecated (1×1/1×2), legacy carton, and legacy free-text custom
    // as read-only lines (full record) — the new form edits only pallets/box and
    // structured crate/rack/custom; everything else is re-appended verbatim.
    const { bookable, legacy } = partitionEditableCargo(lines);
    setLegacyCargo(legacy.map(toOutgoingCargo));
    const box = bookable.find((l) => l.pallet_type === "box");
    const dimLine = bookable.find((l) => l.pallet_type === "crate" || l.pallet_type === "rack" || l.pallet_type === "custom");
    if (box) {
      setCargoType("box");
      setBoxQty(box.quantity ?? 0);
    } else if (dimLine) {
      setCargoType(dimLine.pallet_type as "crate" | "rack" | "custom");
      setDimW(dimLine.width_ft != null ? String(dimLine.width_ft) : "");
      setDimL(dimLine.length_ft != null ? String(dimLine.length_ft) : "");
      setDimQty(dimLine.quantity ?? 1);
    } else {
      setCargoType("pallet");
      setPalletQtys(PALLET_SIZES.map((size) => bookable.find((l) => l.pallet_type === size)?.quantity ?? 0));
    }
    setStep(STEPS.length - 1); // jump to Confirm
  };

  // Load a saved template into the form and jump to Confirm (same fast path as
  // rebook). Pallets are rebuilt from the size→qty map, so a template still maps
  // to the right rows even if PALLET_SIZES is reordered later.
  const applyTemplate = (tpl: BookingTemplate) => {
    // ONE resolver for the values AND for the landing step, so the form cannot
    // show a finished-looking Confirm for a draft it knows is incomplete.
    const form = templateToForm(tpl, PALLET_SIZES);
    if (form.routeTypeId) setRouteTypeId(form.routeTypeId);
    setStops(form.stops);
    setPalletQtys(form.palletQtys);
    setLegacyCargo([]); // templates only carry current bookable sizes
    setBoxQty(form.boxQty);
    setDimW(form.dimW);
    setDimL(form.dimL);
    setDimQty(form.dimQty);
    setCargoType(form.cargoType);
    setRemarks(form.remarks);

    // A template stored before the cargo vocabulary changed can resolve to an
    // UNSUBMITTABLE draft (a free-text "others" size has no width × length; a
    // 1×1/1×2 pallet list is no longer bookable). Land where it can be fixed
    // and say why, instead of on a Confirm the server would reject.
    const loaded: BookingDraft = {
      routeTypeId: form.routeTypeId ?? routeTypeId,
      stopCount: form.stops.length,
      cargoType: form.cargoType,
      totalPallets: form.palletQtys.reduce((a, b) => a + b, 0),
      boxQty: form.boxQty,
      dimsOk:
        isValidDimension(Number(form.dimW)) &&
        isValidDimension(Number(form.dimL)) &&
        form.dimQty > 0,
    };
    const issue = firstBookingIssue(loaded, STEP_CONFIRM);
    setError(issue ? t("booking.templateNeedsUpdate") : null);
    setStep(issue ? issue.step : STEPS.length - 1);
  };

  const saveCurrentTemplate = async () => {
    const clean = templateName.trim();
    if (!clean) return;
    const tpl: BookingTemplate = {
      name: clean,
      routeTypeId,
      stops,
      cargoType,
      pallets: palletsMap(PALLET_SIZES, palletQtys),
      boxQty,
      dimW,
      dimL,
      dimQty,
      remarks,
    };
    const next = upsertTemplate(templates, tpl);
    setTemplates(next);
    await persistTemplates(next);
    setTemplateName("");
    setTemplateSaveOpen(false);
    toast(t("booking.templateSaved"), "success");
  };

  const deleteTemplate = async (name: string) => {
    const next = removeTemplate(templates, name);
    setTemplates(next);
    await persistTemplates(next);
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

  // The live draft, in the shape lib/bookingSteps judges.
  const draft: BookingDraft = {
    routeTypeId,
    stopCount: stops.length,
    cargoType,
    totalPallets,
    boxQty,
    dimsOk,
  };

  // Validate every step UP TO the current one, never just the current one — the
  // template and rebook shortcuts jump straight to Confirm, and the old
  // current-step-only check let them submit past both earlier steps. See the
  // header of lib/bookingSteps.ts.
  const validateStep = (): string | null => {
    const issue = firstBookingIssue(draft, step);
    if (!issue) return null;
    // Send the requestor to the step that can actually fix it — landing on
    // Confirm with a message about cargo is a dead end.
    if (issue.step !== step) setStep(issue.step);
    return t(issue.key);
  };

  const buildCargo = () => {
    // Each branch builds ONLY its current lines; finalizeCargoPayload is the one
    // shared step that appends the preserved legacy cargo — so no cargo type can
    // bypass it and silently drop legacy lines on an edit.
    let current: OutgoingCargoLine[];
    if (cargoType === "box") {
      // Q10: Box is a count only — no dimensions, always manual assignment.
      current = [{ pallet_type: "box", quantity: boxQty }];
    } else if (cargoType === "crate" || cargoType === "rack" || cargoType === "custom") {
      // Q10: structured dimensions in feet + a canonical stored size.
      current = [{
        pallet_type: cargoType,
        quantity: dimQty,
        width_ft: dimWNum,
        length_ft: dimLNum,
        custom_size: canonicalCargoSize(dimWNum, dimLNum),
      }];
    } else {
      current = PALLET_SIZES.map((size, i) => ({ pallet_type: size, quantity: palletQtys[i] })).filter((c) => c.quantity > 0);
    }
    return finalizeCargoPayload(current, legacyCargo, remarks || undefined);
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

      if (isChangeRequest && editTripId) {
        // REQUEST CHANGE: the booking has a lorry, so this is a PROPOSAL for
        // the dispatcher, not a write. Documents are deliberately NOT attached
        // here — the change has not been approved, so there is nothing yet for
        // paperwork to describe.
        await requestChange.mutateAsync({ tripId: editTripId, input: payload });
        toast(t("booking.changeRequestedToast"), "success");
        navigation.goBack();
        return;
      }

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

      // DG-T7: one idempotency key per BOOKING, deliberately NOT per attempt.
      // The 15s timeout below is shorter than a slow-but-successful create, so
      // Submit re-arms (see the `finally`) while the first request may already
      // have committed. Reusing the key makes the server return that original
      // booking instead of creating a second one — which auto-dispatch would
      // answer with a second truck. Regenerated only after a success, so a
      // genuine re-booking of the same cargo still gets its own key.
      if (!requestKey.current) requestKey.current = uuidv4();
      const trip = await createTrip.mutateAsync({
        ...payload,
        client_request_id: requestKey.current,
      });
      requestKey.current = null;
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
      // Both create and edit are pushed over the shell now (New Booking is no
      // longer a tab), so back returns to wherever we came from — the Home hero
      // CTA, the Bookings "+", or the booking's detail on edit. goBack pops that;
      // navigate("Home") only covers a rare no-history case (e.g. a deep link).
      if (navigation.canGoBack()) navigation.goBack();
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
          routeTypesFailed={rtError && !rtLoading}
          onRetryRouteTypes={() => refetchRouteTypes()}
          routeTypeId={routeTypeId}
          setRouteTypeId={setRouteTypeId}
          stops={stops}
          setStops={setStops}
          recent={recentConsignees}
          canRebook={Boolean(lastTrip) && !isEdit}
          onRebook={() => lastTrip && prefillFromTrip(lastTrip)}
          templates={isEdit ? [] : templates}
          onApplyTemplate={applyTemplate}
          onDeleteTemplate={deleteTemplate}
        />
      )}
      {step === 1 && (
        <StepWhat
          cargoType={cargoType}
          setCargoType={setCargoType}
          palletQtys={palletQtys}
          setPalletQtys={setPalletQtys}
          boxQty={boxQty}
          setBoxQty={setBoxQty}
          dimW={dimW}
          setDimW={setDimW}
          dimL={dimL}
          setDimL={setDimL}
          dimQty={dimQty}
          setDimQty={setDimQty}
          legacyCargo={legacyCargo}
          setLegacyCargo={setLegacyCargo}
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
          canSaveTemplate={canSaveTemplate && !isEdit}
          onSaveTemplate={() => setTemplateSaveOpen(true)}
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
        onSelect={(v) => {
          slotTouched.current = true; // user's explicit choice — never auto-refresh over it
          setDayOffset(Number(v));
        }}
        onClose={() => setDayOpen(false)}
      />
      <OptionsModal
        visible={timeOpen}
        title={t("booking.pickupTime")}
        options={timeOptions}
        selectedValue={String(hour)}
        onSelect={(v) => {
          slotTouched.current = true; // user's explicit choice — never auto-refresh over it
          setHour(Number(v));
        }}
        onClose={() => setTimeOpen(false)}
      />

      {/* Save-as-template name dialog */}
      <Modal visible={templateSaveOpen} transparent animationType="fade" onRequestClose={() => setTemplateSaveOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { alignItems: "stretch" }]}>
            <Text style={[styles.modalTitle, { textAlign: "center" }]}>{t("booking.saveTemplateTitle")}</Text>
            <Text style={[styles.docHint, { textAlign: "center", marginBottom: 14 }]}>{t("booking.saveTemplateHint")}</Text>
            <FieldLabel>{t("booking.templateName")}</FieldLabel>
            <TextInput
              value={templateName}
              onChangeText={setTemplateName}
              placeholder={t("booking.templateNamePlaceholder")}
              placeholderTextColor={colors.textFaint}
              autoFocus
              style={styles.estimateInput}
              onSubmitEditing={saveCurrentTemplate}
            />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
              <Button
                title={t("common.cancel")}
                variant="outline"
                onPress={() => {
                  setTemplateName("");
                  setTemplateSaveOpen(false);
                }}
                style={{ flex: 1 }}
              />
              <Button
                title={t("booking.saveTemplate")}
                onPress={saveCurrentTemplate}
                disabled={!templateName.trim()}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        </View>
      </Modal>

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
                // Pushed screen now — pop back to the opener (Home or Bookings);
                // navigate("Home") only if there's no back stack.
                if (navigation.canGoBack()) navigation.goBack();
                else navigation.navigate("Home");
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
  routeTypesFailed,
  onRetryRouteTypes,
  routeTypeId,
  setRouteTypeId,
  stops,
  setStops,
  recent,
  canRebook,
  onRebook,
  templates,
  onApplyTemplate,
  onDeleteTemplate,
}: {
  wide: boolean;
  routeTypes: { id: string; name: string }[];
  routeTypesFailed: boolean;
  onRetryRouteTypes: () => void;
  routeTypeId?: string;
  setRouteTypeId: (id: string) => void;
  stops: Consignee[];
  setStops: React.Dispatch<React.SetStateAction<Consignee[]>>;
  recent: Consignee[];
  canRebook: boolean;
  onRebook: () => void;
  templates: BookingTemplate[];
  onApplyTemplate: (tpl: BookingTemplate) => void;
  onDeleteTemplate: (name: string) => void;
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

      {/* Saved booking templates — 1-tap reload of a named recurring order. */}
      {templates.length > 0 ? (
        <View style={styles.templateWrap}>
          <Text style={styles.recentLabel}>{t("booking.savedTemplates")}</Text>
          <View style={styles.recentChips}>
            {templates.map((tpl) => (
              <View key={tpl.name} style={styles.templateChip}>
                <TouchableOpacity
                  style={styles.templateChipMain}
                  onPress={() => onApplyTemplate(tpl)}
                  activeOpacity={0.85}
                >
                  <Ionicons name="bookmark" size={13} color={colors.blue} />
                  <Text style={styles.templateChipText} numberOfLines={1}>
                    {truncateName(tpl.name)}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => onDeleteTemplate(tpl.name)} hitSlop={8} style={styles.templateChipX}>
                  <Ionicons name="close" size={13} color={colors.textFaint} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <FieldLabel>{t("booking.routeType")}</FieldLabel>
      {/* DG-R8: a failed route-types fetch used to render an EMPTY grid, then
          Next blocked on "choose a route type" with no way forward. Say what
          broke and offer a retry. */}
      {routeTypesFailed && routeTypes.length === 0 ? (
        <View style={styles.routeTypesError}>
          <Ionicons name="cloud-offline-outline" size={18} color={colors.red} />
          <Text style={styles.routeTypesErrorText}>{t("booking.routeTypesFailed")}</Text>
          <TouchableOpacity onPress={onRetryRouteTypes} style={styles.routeTypesRetry}>
            <Text style={styles.routeTypesRetryText}>{t("common.retry")}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
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
  boxQty,
  setBoxQty,
  dimW,
  setDimW,
  dimL,
  setDimL,
  dimQty,
  setDimQty,
  legacyCargo,
  setLegacyCargo,
  totalPallets,
  totalEquivalents,
}: {
  cargoType: "pallet" | "box" | "crate" | "rack" | "custom";
  setCargoType: (v: "pallet" | "box" | "crate" | "rack" | "custom") => void;
  palletQtys: number[];
  setPalletQtys: React.Dispatch<React.SetStateAction<number[]>>;
  boxQty: number;
  setBoxQty: React.Dispatch<React.SetStateAction<number>>;
  dimW: string;
  setDimW: (v: string) => void;
  dimL: string;
  setDimL: (v: string) => void;
  dimQty: number;
  setDimQty: React.Dispatch<React.SetStateAction<number>>;
  legacyCargo: OutgoingCargoLine[];
  setLegacyCargo: React.Dispatch<React.SetStateAction<OutgoingCargoLine[]>>;
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
        {(["pallet", "box", "crate", "rack", "custom"] as const).map((type) => {
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
          <FieldLabel>{t("booking.cargoSizeQty")}</FieldLabel>
          <Text style={styles.cargoSizeHint}>{t("booking.cargoSizeFeetHint")}</Text>
          <View style={styles.palletList}>
            {PALLET_SIZES.map((size, i) => (
              <View key={size} style={[styles.palletRow, i < PALLET_SIZES.length - 1 && styles.palletDivider]}>
                <Text style={styles.palletSize}>{t("booking.cargoSizeRow", { size })}</Text>
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

          {/* Preserved legacy cargo (deprecated 1×1/1×2 from a historical booking).
              Read-only — no steppers, so quantities cannot be changed and cannot be
              dropped accidentally; removal is a deliberate per-row action. */}
          {legacyCargo.length > 0 && (
            <>
              <Text style={styles.legacyLabel}>{t("booking.legacyCargoLabel")}</Text>
              <View style={styles.palletList}>
                {legacyCargo.map((line, i) => (
                  <View key={`${line.pallet_type}-${i}`} style={[styles.palletRow, i < legacyCargo.length - 1 && styles.palletDivider]}>
                    <Text style={styles.palletSize}>{t("booking.legacyCargoRow", { size: line.pallet_type, qty: line.quantity })}</Text>
                    <TouchableOpacity
                      style={styles.legacyRemoveBtn}
                      accessibilityLabel={t("booking.legacyCargoRemove", { size: line.pallet_type })}
                      onPress={() => oncePerTap(() => setLegacyCargo((prev) => prev.filter((_, idx) => idx !== i)))}
                    >
                      <Ionicons name="trash-outline" size={16} color="#b91c1c" />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            </>
          )}

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

      {cargoType === "box" && (
        <>
          <FieldLabel>{t("booking.numBoxes")}</FieldLabel>
          <View style={[styles.palletRow, { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md }]}>
            <Text style={styles.palletSize}>{t("booking.box")}</Text>
            <View style={styles.stepper}>
              <TouchableOpacity style={styles.stepBtnMinus} onPress={() => oncePerTap(() => setBoxQty((q) => Math.max(0, q - 1)))}>
                <Text style={styles.stepBtnMinusText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{boxQty}</Text>
              <TouchableOpacity style={styles.stepBtnPlus} onPress={() => oncePerTap(() => setBoxQty((q) => q + 1))}>
                <Text style={styles.stepBtnPlusText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.estimateHint}>{t("booking.boxManualHint")}</Text>
        </>
      )}

      {(cargoType === "crate" || cargoType === "rack" || cargoType === "custom") && (
        <>
          <FieldLabel>{t("booking.dimensionsFt")}</FieldLabel>
          <View style={styles.dimRow}>
            <TextInput
              value={dimW}
              onChangeText={(v) => setDimW(v.replace(/[^0-9.]/g, ""))}
              keyboardType="decimal-pad"
              placeholder={t("booking.widthFt")}
              placeholderTextColor={colors.textFaint}
              style={[styles.estimateInput, styles.dimInput]}
            />
            <Text style={styles.dimTimes}>×</Text>
            <TextInput
              value={dimL}
              onChangeText={(v) => setDimL(v.replace(/[^0-9.]/g, ""))}
              keyboardType="decimal-pad"
              placeholder={t("booking.lengthFt")}
              placeholderTextColor={colors.textFaint}
              style={[styles.estimateInput, styles.dimInput]}
            />
            <Text style={styles.dimFt}>{t("booking.ft")}</Text>
          </View>
          <FieldLabel>{t("booking.quantity")}</FieldLabel>
          <View style={[styles.palletRow, { backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md }]}>
            <Text style={styles.palletSize}>{t(`booking.${cargoType}`)}</Text>
            <View style={styles.stepper}>
              <TouchableOpacity style={styles.stepBtnMinus} onPress={() => oncePerTap(() => setDimQty((q) => Math.max(1, q - 1)))}>
                <Text style={styles.stepBtnMinusText}>−</Text>
              </TouchableOpacity>
              <Text style={styles.stepVal}>{dimQty}</Text>
              <TouchableOpacity style={styles.stepBtnPlus} onPress={() => oncePerTap(() => setDimQty((q) => q + 1))}>
                <Text style={styles.stepBtnPlusText}>+</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.estimateHint}>{t("booking.dimensionsManualHint")}</Text>
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
  canSaveTemplate,
  onSaveTemplate,
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
  canSaveTemplate: boolean;
  onSaveTemplate: () => void;
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
        {/* Mr. Teh 16 Jul: "Can show the zone area and cargo pickup point after
            requestor select customer name in confirmation page?" — the pickup
            origin (single-origin model today) plus each stop's zone + area. */}
        <Row k={t("booking.pickupPoint")} v="UWC Batu Kawan" />
        {stops.map((c, i) => (
          <Row
            key={c.id}
            k={t("booking.stopN", { n: i + 1 })}
            v={`${c.company_name}\n${[c.zone?.name ? `${c.zone_code} — ${c.zone.name}` : c.zone_code, c.area].filter(Boolean).join(" · ")}`}
          />
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

      {/* Save this booking as a reusable template (device-local). Only offered
          once the booking is complete, so a reloaded template is submittable. */}
      {canSaveTemplate ? (
        <TouchableOpacity style={styles.saveTemplateBtn} onPress={onSaveTemplate} activeOpacity={0.85}>
          <Ionicons name="bookmark-outline" size={18} color={colors.blue} />
          <Text style={styles.saveTemplateText}>{t("booking.saveAsTemplate")}</Text>
        </TouchableOpacity>
      ) : null}
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

  templateWrap: { marginBottom: 16 },
  templateChip: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "100%",
    backgroundColor: colors.tintBlue,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  templateChipMain: { flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: 12, paddingRight: 6, paddingVertical: 8, flexShrink: 1 },
  templateChipText: { fontSize: 14, fontWeight: "700", color: colors.blue, flexShrink: 1 },
  templateChipX: { paddingRight: 10, paddingLeft: 2, paddingVertical: 8 },
  saveTemplateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1.5,
    borderColor: colors.blue,
    borderRadius: radius.md,
    paddingVertical: 13,
    marginBottom: 12,
  },
  saveTemplateText: { fontSize: 14, fontWeight: "700", color: colors.blue },

  routeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 20 },
  routeTypesError: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#FDECEA", borderWidth: 1, borderColor: colors.red, borderRadius: radius.md, padding: 12, marginBottom: 12 },
  routeTypesErrorText: { flex: 1, fontSize: 13, color: colors.red, fontWeight: "600" },
  routeTypesRetry: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.red, borderRadius: radius.md, paddingVertical: 6, paddingHorizontal: 12 },
  routeTypesRetryText: { fontSize: 13, fontWeight: "700", color: colors.red },
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
  cargoSizeHint: { fontSize: 13, color: colors.textMuted, lineHeight: 17, marginBottom: 8 },
  legacyLabel: { fontSize: 12, fontWeight: "700", color: colors.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 14, marginBottom: 6 },
  legacyRemoveBtn: { padding: 8, borderRadius: radius.sm },
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
  dimRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dimInput: { flex: 1, textAlign: "center" },
  dimTimes: { fontSize: 18, color: colors.textMuted, fontWeight: "700" },
  dimFt: { fontSize: 14, color: colors.textMuted, fontWeight: "600" },

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
