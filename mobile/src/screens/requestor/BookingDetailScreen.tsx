import React, { useState } from "react";
import { Image, Linking, Modal, RefreshControl, ScrollView, Share, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RequestorStackParamList } from "../../navigation/types";
import { useTrip, useCancelTrip, useTripLatestLocation, useUploadTripDocument } from "../../hooks/queries";
import { pickDocumentFile } from "../../lib/photo";
import { TripDocument } from "../../types";
import { useToast } from "../../components/Toast";
import { api, apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { useWide } from "../../hooks/useWide";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Header } from "../../components/Header";
import { StatusBadge } from "../../components/StatusBadge";
import { LiveTripMap } from "../../components/LiveTripMap";
import { StatusTimeline } from "../../components/StatusTimeline";
import {
  bookingActions,
  bookingStage,
  bookingStatusKey,
  BOOKING_STAGES,
  type BookingAction,
} from "../../lib/bookingProgress";
import { exceptionsEnabled } from "../../lib/featureFlags";
import { RequestorExceptionBanner } from "../../components/RequestorExceptionBanner";
import { LoadingState, ErrorState } from "../../components/States";
import { tripDestination, tripConsigneeName, cargoSummary, tripDestZone, ORIGIN_LABEL } from "../../lib/trip";
import { DELIVERED_STATUSES } from "../../lib/tripStatus";
import { estimateTripCo2 } from "../../lib/tripCo2";
import { bannerFor } from "../../lib/bookingBanner";
import { formatDateTime, initials as nameInitials } from "../../lib/format";
import { changeRequestsEnabled } from "../../lib/featureFlags";

type Nav = NativeStackNavigationProp<RequestorStackParamList, "BookingDetail">;
type Rt = RouteProp<RequestorStackParamList, "BookingDetail">;

export function BookingDetailScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const wide = useWide();
  const { data: trip, isLoading, isError, refetch, isRefetching } = useTrip(params.tripId);
  const cancelTrip = useCancelTrip();
  const uploadDoc = useUploadTripDocument();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the truck's latest position while the trip is in transit. The map
  // below reads the same query (shared by key), so this is a single request.
  const inTransit = trip?.status === "in_progress";
  const { data: livePos } = useTripLatestLocation(params.tripId, Boolean(inTransit));

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  // A delivered-family trip with undelivered stops = a partial abort (28 Jul
  // partial-pay rule): the banner must say so, or the requestor never learns
  // the remaining stops need re-booking.
  const partiallyDelivered = (trip.stops ?? []).some((s) => s.status !== "delivered");
  const banner = bannerFor(trip.status, { partiallyDelivered });

  // Which buttons this status offers (design frame 9b) — one table, in a lib,
  // rather than eight independent booleans that drifted apart.
  const stops = trip.stops ?? [];
  const podStops = stops.filter((s) => s.pod_photo);
  const actions = bookingActions(trip.status, {
    hasDriverPhone: Boolean(trip.driver?.phone),
    hasPod: podStops.length > 0,
    // Once a lorry is assigned the booking is no longer the requestor's to
    // change directly (Mr. Teh A19) — but they are not stuck: Request Change
    // sends the same edit to the dispatcher for approval.
    changeRequestsEnabled: changeRequestsEnabled(),
  });
  const can = (a: BookingAction) => actions.includes(a);
  const stage = bookingStage(trip.status);
  const statusLabel = t(bookingStatusKey(trip.status, stops));

  async function shareTracking() {
    if (!trip) return;
    try {
      const { url } = (await api.get<{ url: string }>(`/trips/${trip.id}/tracking-link`)).data;
      await Share.share({ message: url, url });
    } catch (e) {
      setError(apiErrorMessage(e));
    }
  }

  const onCancel = async () => {
    setError(null);
    try {
      await cancelTrip.mutateAsync(trip.id);
      setConfirm(false);
      toast(t("bookingDetail.cancelledToast"), "success");
    } catch (e) {
      setError(apiErrorMessage(e));
      setConfirm(false);
    }
  };

  const onUploadDoc = async () => {
    setError(null);
    try {
      const photo = await pickDocumentFile();
      if (photo === "too_large") {
        toast(t("common.fileTooLarge"), "error");
        return;
      }
      if (!photo) return; // cancelled or permission denied
      await uploadDoc.mutateAsync({ tripId: trip.id, photo, type: "other" });
      toast(t("bookingDetail.docUploaded"), "success");
    } catch (e) {
      const msg = apiErrorMessage(e);
      setError(msg);
      toast(msg, "error");
    }
  };

  const documents = trip.documents ?? [];

  // ── Status + progress (design frame 9) ─────────────────────────────────────
  // A booking that never travelled gets NO bar: four ticks would imply progress
  // that will never happen. That is the frame's rule and bookingStage's.
  const progressCard = (
    <Card style={{ marginBottom: 12 }}>
      <View style={styles.statusPillRow}>
        <StatusBadge status={trip.status} label={statusLabel} />
      </View>
      {stage !== null ? (
        <>
          <View style={styles.progressBar}>
            {BOOKING_STAGES.map((s, i) => (
              <View
                key={s}
                style={[styles.progressSeg, i < stage && { backgroundColor: colors.blue }]}
              />
            ))}
          </View>
          <View style={styles.progressLabels}>
            {BOOKING_STAGES.map((s, i) => (
              <Text
                key={s}
                style={[styles.progressLabel, i === stage - 1 && styles.progressLabelActive]}
                numberOfLines={1}
              >
                {t(`bookingDetail.stage_${s}`)}
              </Text>
            ))}
          </View>
        </>
      ) : null}
    </Card>
  );

  // ── Card fragments (identical markup; stacked on phone, two columns on PC) ──
  const pendingNotice = trip.status === "pending" ? (
    <View style={styles.notice}>
      <Ionicons name="information-circle-outline" size={18} color={colors.amberText} />
      <Text style={styles.noticeText}>{t("bookingDetail.pendingNotice")}</Text>
    </View>
  ) : null;

  const rejectNotice = trip.status === "rejected" ? (
    <View style={styles.rejectNotice}>
      <Ionicons name="close-circle-outline" size={18} color={colors.red} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rejectTitle}>{t("bookingDetail.rejectionReason")}</Text>
        <Text style={styles.rejectText}>
          {trip.rejection_reason?.trim() || t("bookingDetail.rejectionNoReason")}
        </Text>
      </View>
    </View>
  ) : null;

  // Navy card, plate on a black chip — the frame treats the driver as the one
  // person on this screen, and the plate as the thing checked against the lorry
  // that turns up.
  const driverCard = trip.driver ? (
    <View style={styles.driverCard}>
      <View style={styles.driverAvatar}>
        <Text style={styles.driverAvatarText}>{nameInitials(trip.driver.name)}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.driverName} numberOfLines={1}>{trip.driver.name}</Text>
        <Text style={styles.driverSub} numberOfLines={1}>
          {[t("bookingDetail.assignedDriver"), trip.truck?.type].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {trip.truck_plate ? (
        <View style={styles.plate}>
          <Text style={styles.plateText}>{trip.truck_plate}</Text>
        </View>
      ) : null}
    </View>
  ) : null;

  const liveCard = trip.status === "in_progress" ? (
    <Card style={{ marginBottom: 12 }}>
      <View style={styles.detailHead}>
        <Text style={styles.cardLabel}>{t("bookingDetail.liveLocation")}</Text>
        <LiveStatus pos={livePos} />
      </View>
      <View style={{ marginTop: 12 }}>
        <LiveTripMap tripId={trip.id} destZone={tripDestZone(trip)} live height={wide ? 260 : 200} />
      </View>
    </Card>
  ) : null;

  const detailsCard = (
    <Card style={{ marginBottom: 12 }} padded={false}>
      <View style={styles.factRow}>
        <Ionicons name="calendar-outline" size={18} color={colors.blue} />
        <Text style={styles.factKey}>{t("bookingDetail.dateTime")}</Text>
        <Text style={styles.factVal} numberOfLines={1}>{formatDateTime(trip.pickup_datetime)}</Text>
      </View>
      <View style={[styles.factRow, styles.factDivider]}>
        <Ionicons name="cube-outline" size={18} color={colors.blue} />
        <Text style={styles.factKey}>{t("bookingDetail.cargo")}</Text>
        <Text style={styles.factVal} numberOfLines={1}>{cargoSummary(trip)}</Text>
      </View>
      {trip.route_type ? (
        <View style={[styles.factRow, styles.factDivider]}>
          <Ionicons name="git-branch-outline" size={18} color={colors.blue} />
          <Text style={styles.factKey}>{t("booking.routeType")}</Text>
          <Text style={styles.factVal} numberOfLines={1}>{trip.route_type.name}</Text>
        </View>
      ) : null}
      {/* Per-trip CO₂e ESTIMATE (SDG visibility) — delivered trips only,
          labelled as an estimate (lib/tripCo2). */}
      {DELIVERED_STATUSES.includes(trip.status)
        ? (() => {
            const co2 = estimateTripCo2(stops);
            return co2 ? (
              <View style={[styles.factRow, styles.factDivider]}>
                <Ionicons name="leaf-outline" size={18} color={colors.greenText} />
                <Text style={styles.factKey}>{t("bookingDetail.co2Label")}</Text>
                <Text style={styles.factVal} numberOfLines={1}>
                  {t("trip.co2Estimate", { km: co2.km, kg: co2.co2Kg })}
                </Text>
              </View>
            ) : null;
          })()
        : null}
    </Card>
  );

  // Every stop, numbered — a multi-stop booking used to show only the first
  // consignee anywhere on this screen.
  const routeCard = stops.length > 0 ? (
    <View style={{ marginBottom: 12, gap: 8 }}>
      <Text style={styles.sectionLabel}>{t("booking.route")}</Text>
      <Card padded={false}>
        <View style={styles.stopRow}>
          <View style={styles.originDot} />
          <Text style={styles.stopName} numberOfLines={1}>{ORIGIN_LABEL}</Text>
        </View>
        {[...stops]
          .sort((a, b) => a.sequence - b.sequence)
          .map((s) => (
            <View key={s.id} style={[styles.stopRow, styles.factDivider]}>
              <View style={styles.stopSeq}>
                <Text style={styles.stopSeqText}>{s.sequence}</Text>
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.stopName} numberOfLines={1}>
                  {s.consignee?.company_name ?? "—"}
                </Text>
                <Text style={styles.stopMeta} numberOfLines={1}>
                  {[
                    s.consignee?.zone?.name
                      ? `${s.consignee.zone_code} — ${s.consignee.zone.name}`
                      : s.consignee?.zone_code,
                    s.consignee?.area,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              {s.status === "delivered" ? (
                <Ionicons name="checkmark-circle" size={18} color={colors.greenText} />
              ) : s.arrived_at ? (
                <Ionicons name="location" size={18} color={colors.blue} />
              ) : null}
            </View>
          ))}
      </Card>
    </View>
  ) : null;

  const documentsCard = (
    <Card style={{ marginBottom: 12 }}>
      <View style={styles.detailHead}>
        <Text style={styles.cardLabel}>{t("bookingDetail.documents")}</Text>
        <TouchableOpacity
          style={styles.uploadBtn}
          onPress={onUploadDoc}
          disabled={uploadDoc.isPending}
          activeOpacity={0.8}
        >
          <Ionicons name="cloud-upload-outline" size={16} color={colors.blue} />
          <Text style={styles.uploadBtnText}>
            {uploadDoc.isPending ? t("bookingDetail.docUploading") : t("bookingDetail.docUpload")}
          </Text>
        </TouchableOpacity>
      </View>

      {documents.length === 0 ? (
        <Text style={styles.docEmpty}>{t("bookingDetail.docEmpty")}</Text>
      ) : (
        <View style={{ marginTop: 12, gap: 10 }}>
          {documents.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} />
          ))}
        </View>
      )}
    </Card>
  );

  // Proof-of-delivery photos. The server has always shipped stop.pod_photo to
  // the trip's requestor as a freshly-signed viewable URL (signTripResponse) —
  // this card finally renders it. Shown once any stop has a POD.
  const podCard =
    podStops.length > 0 ? (
      <Card style={{ marginBottom: 12 }}>
        <Text style={styles.cardLabel}>{t("bookingDetail.podTitle")}</Text>
        <View style={{ marginTop: 12, gap: 10 }}>
          {podStops.map((s) => (
            <TouchableOpacity
              key={s.id}
              style={styles.docRow}
              onPress={() => Linking.openURL(s.pod_photo!)}
              activeOpacity={0.8}
            >
              <Image source={{ uri: s.pod_photo! }} style={styles.docThumb} />
              <View style={{ flex: 1 }}>
                <Text style={styles.docName}>
                  {t("bookingDetail.podStop", {
                    n: s.sequence,
                    name: s.consignee?.company_name ?? "",
                  })}
                </Text>
                {s.delivered_at ? (
                  <Text style={styles.docDate}>{formatDateTime(s.delivered_at)}</Text>
                ) : null}
              </View>
              <Ionicons name="open-outline" size={18} color={colors.blue} />
            </TouchableOpacity>
          ))}
        </View>
      </Card>
    ) : null;

  const timelineCard = (
    <Card>
      <Text style={[styles.cardLabel, { marginBottom: 16 }]}>{t("bookingDetail.timeline")}</Text>
      <StatusTimeline steps={trip.timeline ?? []} />
    </Card>
  );

  return (
    <View style={styles.fill}>
      <Header title={t("bookingDetail.title")} onBack={() => navigation.goBack()} />

      {/* Status banner (full-width strip on every layout) */}
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Ionicons name={banner.icon} size={18} color={banner.fg} />
        <Text style={[styles.bannerText, { color: banner.fg }]}>{t(banner.textKey)}</Text>
      </View>

      <ScrollView
        contentContainerStyle={
          wide
            ? { paddingHorizontal: 28, paddingTop: 24, paddingBottom: 32, width: "100%" }
            : { padding: 16, paddingBottom: 32 }
        }
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {pendingNotice}
        {rejectNotice}
        {exceptionsEnabled() && <RequestorExceptionBanner tripId={params.tripId} />}

        {wide ? (
          // ── Wide (PC) — details + tracking on the left, docs + timeline right ──
          <View style={styles.wideRow}>
            <View style={styles.wideMain}>
              {progressCard}
              {driverCard}
              {liveCard}
              {detailsCard}
              {routeCard}
            </View>
            <View style={styles.wideSide}>
              {documentsCard}
              {podCard}
              {timelineCard}
            </View>
          </View>
        ) : (
          // ── Narrow (phone) — design frame 9's order: where it is, who has it,
          // where it is going, then the paperwork.
          <>
            {progressCard}
            {driverCard}
            {liveCard}
            {detailsCard}
            {routeCard}
            {documentsCard}
            {podCard}
            {timelineCard}
          </>
        )}

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {/* Per-status bottom bar (design frame 9b) — driven by bookingActions, so
          every status has at least one thing to do and none offers a button the
          server would refuse. */}
      {actions.length > 0 ? (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <View style={wide ? styles.bottomInner : undefined}>
            <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
              {can("call") && trip.driver?.phone ? (
                <Button
                  title={t("bookingDetail.callDriver")}
                  onPress={() => Linking.openURL(`tel:${trip.driver!.phone}`)}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="call" size={18} color={colors.white} />}
                />
              ) : null}
              {can("share") ? (
                <Button
                  title={t("bookingDetail.shareTracking")}
                  variant="outline"
                  onPress={shareTracking}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="share-social-outline" size={18} color={colors.blue} />}
                />
              ) : null}
              {can("edit") ? (
                <Button
                  title={t("bookingDetail.editRequest")}
                  onPress={() => navigation.navigate("EditBooking", { tripId: trip.id })}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="create-outline" size={18} color={colors.white} />}
                />
              ) : null}
              {can("requestChange") ? (
                <Button
                  variant="outline"
                  title={t("bookingDetail.requestChange")}
                  onPress={() => navigation.navigate("EditBooking", { tripId: trip.id })}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="git-pull-request-outline" size={18} color={colors.navy} />}
                />
              ) : null}
              {can("viewPod") ? (
                <Button
                  title={t("bookingDetail.viewPod")}
                  variant="outline"
                  onPress={() => Linking.openURL(podStops[0].pod_photo!)}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="image-outline" size={18} color={colors.blue} />}
                />
              ) : null}
              {can("rebook") ? (
                <Button
                  title={t("bookingDetail.rebook")}
                  onPress={() => navigation.navigate("NewBooking", { rebookTripId: trip.id })}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="repeat" size={18} color={colors.white} />}
                />
              ) : null}
              {can("seeReason") ? (
                <Button
                  title={t("bookingDetail.seeReason")}
                  variant="outline"
                  onPress={() => setReasonOpen(true)}
                  style={{ flex: 1, minWidth: 140 }}
                  icon={<Ionicons name="information-circle-outline" size={18} color={colors.blue} />}
                />
              ) : null}
              {can("cancel") ? (
                <Button
                  title={t("bookingDetail.cancelRequest")}
                  variant="outline"
                  onPress={() => setConfirm(true)}
                  style={{ flex: 1, minWidth: 140, borderColor: colors.red }}
                  icon={<Ionicons name="close-circle-outline" size={18} color={colors.blue} />}
                />
              ) : null}
            </View>
          </View>
        </View>
      ) : null}

      {/* Frame 9b flags "See Reason" as blocked on a data source. It is not —
          the admin's rejection writes trip.rejection_reason, and the inline
          notice above has rendered it for months. This is the same text on
          demand, with an honest fallback when the admin left it blank. */}
      <Modal visible={reasonOpen} transparent animationType="fade" onRequestClose={() => setReasonOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons name="close-circle-outline" size={28} color={colors.red} />
            </View>
            <Text style={styles.modalTitle}>{t("bookingDetail.rejectionReason")}</Text>
            <Text style={styles.modalBody}>
              {trip.rejection_reason?.trim() || t("bookingDetail.rejectionNoReason")}
            </Text>
            <Button
              title={t("common.close")}
              variant="outline"
              onPress={() => setReasonOpen(false)}
              style={{ alignSelf: "stretch", marginTop: 20 }}
            />
          </View>
        </View>
      </Modal>

      <Modal visible={confirm} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}>
              <Ionicons name="alert" size={28} color={colors.red} />
            </View>
            <Text style={styles.modalTitle}>{t("bookingDetail.cancelConfirmTitle")}</Text>
            <Text style={styles.modalBody}>{t("bookingDetail.cancelConfirmBody")}</Text>
            <View style={{ flexDirection: "row", gap: 10, marginTop: 20 }}>
              <Button title={t("bookingDetail.keepIt")} variant="outline" onPress={() => setConfirm(false)} style={{ flex: 1 }} />
              <Button title={t("bookingDetail.yesCancel")} variant="danger" onPress={onCancel} loading={cancelTrip.isPending} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Small live/stale/waiting chip for the tracking card header.
function LiveStatus({ pos }: { pos?: { stale: boolean } | null }) {
  const { t } = useTranslation();
  let color: string = colors.textFaint;
  let label = t("bookingDetail.locWaiting");
  if (pos) {
    color = pos.stale ? colors.orange : colors.green;
    label = pos.stale ? t("bookingDetail.locStale") : t("bookingDetail.locLive");
  }
  return (
    <View style={styles.liveStatus}>
      <View style={[styles.liveStatusDot, { backgroundColor: color }]} />
      <Text style={[styles.liveStatusText, { color }]}>{label}</Text>
    </View>
  );
}

// One uploaded document: thumbnail (images) or file icon (PDF), label, and a
// tap-to-open that hands the Cloudinary URL to the system browser/viewer.
function DocumentRow({ doc }: { doc: TripDocument }) {
  const { t } = useTranslation();
  // ⚠ Match the extension on the PATH, not the whole URL. The `$` anchor used to
  // sit against the full string, and a Cloudinary delivery URL ends with an SDK
  // analytics parameter (`?_a=...`) — so this was false for EVERY document and
  // every image paperwork row rendered as a file icon instead of a thumbnail.
  // Found by the API-side test that pins this rule (tests/deliveryOptimisation).
  const isImage = /\.(jpe?g|png|webp|heic|gif)$/i.test(doc.file_url.split(/[?#]/)[0]);
  const typeLabel: Record<string, string> = {
    do_photo: t("bookingDetail.docTypeDO"),
    k2_form: t("bookingDetail.docTypeK2"),
    other: t("bookingDetail.docTypeOther"),
  };
  return (
    <TouchableOpacity
      style={styles.docRow}
      onPress={() => Linking.openURL(doc.file_url)}
      activeOpacity={0.8}
    >
      {isImage ? (
        <Image source={{ uri: doc.file_url }} style={styles.docThumb} />
      ) : (
        <View style={[styles.docThumb, styles.docIcon]}>
          <Ionicons name="document-text" size={22} color={colors.blue} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.docName}>{typeLabel[doc.type] ?? t("bookingDetail.docTypeOther")}</Text>
        <Text style={styles.docDate}>{formatDateTime(doc.uploaded_at)}</Text>
      </View>
      <Ionicons name="open-outline" size={18} color={colors.blue} />
    </TouchableOpacity>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.detailCell}>
      <Text style={styles.detailKey}>{k}</Text>
      <Text style={styles.detailVal}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  wideRow: { flexDirection: "row", alignItems: "flex-start", gap: 20 },
  wideMain: { flex: 1.3 },
  wideSide: { flex: 1 },
  bottomInner: { width: "100%", paddingHorizontal: 28 },
  banner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 14 },
  bannerText: { fontSize: 14, fontWeight: "700" },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.tintYellow, borderRadius: radius.md, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#FFE082" },
  noticeText: { flex: 1, fontSize: 14, fontWeight: "600", color: "#92400e" },
  rejectNotice: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "#fef2f2", borderRadius: radius.md, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#fecaca" },
  rejectTitle: { fontSize: 12, fontWeight: "700", color: colors.red, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  rejectText: { fontSize: 14, fontWeight: "600", color: "#991b1b", lineHeight: 18 },
  cardLabel: { fontSize: 13, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6 },
  sectionLabel: { fontSize: 12, fontWeight: "800", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 1 },

  statusPillRow: { flexDirection: "row", marginBottom: 12 },
  progressBar: { flexDirection: "row", gap: 10 },
  progressSeg: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.border },
  progressLabels: { flexDirection: "row", marginTop: 8 },
  progressLabel: { flex: 1, fontSize: 11, fontWeight: "700", color: colors.textFaint, textAlign: "center" },
  progressLabelActive: { color: colors.blue },

  driverCard: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: colors.navy, borderRadius: radius.md, padding: 16, marginBottom: 12 },
  driverAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.yellow },
  driverAvatarText: { color: colors.yellow, fontSize: 16, fontWeight: "800" },
  driverName: { fontSize: 15, fontWeight: "800", color: colors.white },
  driverSub: { fontSize: 13, color: "#c9d6f0", marginTop: 2 },
  plate: { flexShrink: 0, minHeight: 28, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#111318", justifyContent: "center" },
  plateText: { color: colors.white, fontSize: 13, fontWeight: "700", letterSpacing: 1 },

  factRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  factDivider: { borderTopWidth: 1, borderTopColor: colors.bg },
  factKey: { flex: 1, fontSize: 14, color: colors.textMuted },
  factVal: { flexShrink: 1, fontSize: 14, fontWeight: "700", color: colors.navy, textAlign: "right" },

  stopRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  originDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: colors.border },
  stopSeq: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.tintBlue, alignItems: "center", justifyContent: "center" },
  stopSeqText: { fontSize: 11, fontWeight: "800", color: colors.blue },
  stopName: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.navy },
  stopMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  detailHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  uploadBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.tintBlue, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  uploadBtnText: { color: colors.blue, fontSize: 13, fontWeight: "700" },
  docEmpty: { fontSize: 14, color: colors.textFaint, marginTop: 10 },
  co2Row: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 12 },
  co2Text: { fontSize: 12, color: colors.textMuted, flexShrink: 1 },
  docRow: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.bg, borderRadius: radius.md, padding: 10 },
  docThumb: { width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.tintBlue },
  docIcon: { alignItems: "center", justifyContent: "center" },
  docName: { fontSize: 14, fontWeight: "700", color: colors.navy },
  docDate: { fontSize: 13, color: colors.textFaint, marginTop: 2 },
  liveStatus: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveStatusDot: { width: 8, height: 8, borderRadius: 4 },
  liveStatusText: { fontSize: 13, fontWeight: "700" },
  ticketChip: { backgroundColor: colors.blue, paddingHorizontal: 12, paddingVertical: 4, borderRadius: radius.pill },
  ticketChipText: { color: colors.white, fontSize: 13, fontWeight: "700" },
  typeChip: { alignSelf: "flex-start", backgroundColor: colors.tintBlue, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill, marginTop: 12 },
  typeChipText: { color: colors.blue, fontSize: 13, fontWeight: "700" },
  detailGrid: { marginTop: 14, gap: 12 },
  detailCell: { borderTopWidth: 1, borderTopColor: colors.bg, paddingTop: 10 },
  detailKey: { fontSize: 13, color: colors.textFaint, fontWeight: "600", marginBottom: 4 },
  detailVal: { fontSize: 14, fontWeight: "700", color: colors.navy },
  error: { color: colors.red, fontSize: 14, fontWeight: "600", marginTop: 12 },
  bottom: { paddingHorizontal: 16, paddingTop: 12, backgroundColor: colors.bg },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: 24, padding: 28, alignItems: "center", width: "100%" },
  modalIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: "#fef2f2", alignItems: "center", justifyContent: "center", marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: "800", color: colors.navy, marginBottom: 8 },
  modalBody: { fontSize: 14, color: colors.textMuted, textAlign: "center", lineHeight: 20 },
});
