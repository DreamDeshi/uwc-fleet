import React, { useState } from "react";
import { Image, Linking, Modal, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useNavigation, useRoute, RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { RequestorStackParamList } from "../../navigation/types";
import { useTrip, useCancelTrip, useTripLatestLocation, useUploadTripDocument } from "../../hooks/queries";
import { pickDocumentImage } from "../../lib/photo";
import { TripDocument } from "../../types";
import { useToast } from "../../components/Toast";
import { apiErrorMessage } from "../../services/api";
import { colors, radius, shadow } from "../../theme";
import { Card } from "../../components/Card";
import { Button } from "../../components/Button";
import { Header } from "../../components/Header";
import { RouteLine } from "../../components/RouteLine";
import { LiveTripMap } from "../../components/LiveTripMap";
import { StatusTimeline } from "../../components/StatusTimeline";
import { LoadingState, ErrorState } from "../../components/States";
import { tripDestination, tripConsigneeName, cargoSummary, tripDestZone, ORIGIN_LABEL } from "../../lib/trip";
import { formatDateTime, initials as nameInitials } from "../../lib/format";
import { TripStatus } from "../../types";

type Nav = NativeStackNavigationProp<RequestorStackParamList, "BookingDetail">;
type Rt = RouteProp<RequestorStackParamList, "BookingDetail">;

export function BookingDetailScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const { params } = useRoute<Rt>();
  const { data: trip, isLoading, isError, refetch, isRefetching } = useTrip(params.tripId);
  const cancelTrip = useCancelTrip();
  const uploadDoc = useUploadTripDocument();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the truck's latest position while the trip is in transit. The map
  // below reads the same query (shared by key), so this is a single request.
  const inTransit = trip?.status === "in_progress";
  const { data: livePos } = useTripLatestLocation(params.tripId, Boolean(inTransit));

  if (isLoading) return <View style={styles.fill}><LoadingState /></View>;
  if (isError || !trip) return <View style={styles.fill}><ErrorState onRetry={refetch} /></View>;

  const banner = bannerFor(trip.status);
  const canCancel = trip.status === "pending" || trip.status === "approved";

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
      const photo = await pickDocumentImage();
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

  return (
    <View style={styles.fill}>
      <Header title={t("bookingDetail.title")} onBack={() => navigation.goBack()} />

      {/* Status banner */}
      <View style={[styles.banner, { backgroundColor: banner.bg }]}>
        <Ionicons name={banner.icon} size={18} color={banner.fg} />
        <Text style={[styles.bannerText, { color: banner.fg }]}>{banner.text(t)}</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        {/* Pending notice */}
        {trip.status === "pending" ? (
          <View style={styles.notice}>
            <Ionicons name="information-circle-outline" size={18} color="#d97706" />
            <Text style={styles.noticeText}>{t("bookingDetail.pendingNotice")}</Text>
          </View>
        ) : null}

        {/* Rejection reason — shown when an admin rejected the booking */}
        {trip.status === "rejected" ? (
          <View style={styles.rejectNotice}>
            <Ionicons name="close-circle-outline" size={18} color={colors.red} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rejectTitle}>{t("bookingDetail.rejectionReason")}</Text>
              <Text style={styles.rejectText}>
                {trip.rejection_reason?.trim() || t("bookingDetail.rejectionNoReason")}
              </Text>
            </View>
          </View>
        ) : null}

        {/* Assigned driver */}
        {trip.driver ? (
          <Card style={{ marginBottom: 12 }}>
            <Text style={styles.cardLabel}>{t("bookingDetail.assignedDriver")}</Text>
            <View style={styles.driverRow}>
              <View style={styles.driverAvatar}>
                <Text style={styles.driverAvatarText}>{nameInitials(trip.driver.name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.driverName}>{trip.driver.name}</Text>
                <Text style={styles.driverSub}>{trip.truck_plate} {trip.truck?.type ? `(${trip.truck.type})` : ""}</Text>
                {trip.driver.phone ? <Text style={styles.driverPhone}>📞 {trip.driver.phone}</Text> : null}
              </View>
              {trip.driver.phone ? (
                <TouchableOpacity style={styles.callBtn} onPress={() => Linking.openURL(`tel:${trip.driver!.phone}`)}>
                  <Ionicons name="call" size={20} color={colors.white} />
                </TouchableOpacity>
              ) : null}
            </View>
          </Card>
        ) : null}

        {/* Live tracking — only while the truck is in transit */}
        {trip.status === "in_progress" ? (
          <Card style={{ marginBottom: 12 }}>
            <View style={styles.detailHead}>
              <Text style={styles.cardLabel}>{t("bookingDetail.liveLocation")}</Text>
              <LiveStatus pos={livePos} />
            </View>
            <View style={{ marginTop: 12 }}>
              <LiveTripMap tripId={trip.id} destZone={tripDestZone(trip)} live height={200} />
            </View>
          </Card>
        ) : null}

        {/* Trip details */}
        <Card style={{ marginBottom: 12 }}>
          <View style={styles.detailHead}>
            <Text style={styles.cardLabel}>{t("bookingDetail.tripDetails")}</Text>
            <View style={styles.ticketChip}>
              <Text style={styles.ticketChipText}>{trip.ticket_number}</Text>
            </View>
          </View>
          {trip.route_type ? (
            <View style={styles.typeChip}>
              <Text style={styles.typeChipText}>{trip.route_type.name}</Text>
            </View>
          ) : null}
          <View style={{ marginTop: 14 }}>
            <RouteLine from={ORIGIN_LABEL} to={tripConsigneeName(trip)} />
          </View>
          <View style={styles.detailGrid}>
            <Detail k={t("bookingDetail.dateTime")} v={formatDateTime(trip.pickup_datetime)} />
            <Detail k={t("bookingDetail.cargo")} v={cargoSummary(trip)} />
            <Detail k={t("bookingDetail.consignee")} v={tripDestination(trip)} />
          </View>
        </Card>

        {/* Documents — DO / invoice upload + uploaded files */}
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

        {/* Adaptive status timeline (from GET /trips/:id .timeline) */}
        <Card>
          <Text style={[styles.cardLabel, { marginBottom: 16 }]}>{t("bookingDetail.timeline")}</Text>
          <StatusTimeline steps={trip.timeline ?? []} />
        </Card>

        {error ? <Text style={styles.error}>{error}</Text> : null}
      </ScrollView>

      {/* Cancel */}
      {canCancel ? (
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <Button
            title={t("bookingDetail.cancelRequest")}
            variant="outline"
            onPress={() => setConfirm(true)}
            style={{ borderColor: colors.red }}
            icon={<Ionicons name="close-circle-outline" size={18} color={colors.blue} />}
          />
        </View>
      ) : null}

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
  const isImage = /\.(jpe?g|png|webp|heic|gif)$/i.test(doc.file_url);
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

function bannerFor(status: TripStatus): {
  bg: string;
  fg: string;
  icon: keyof typeof Ionicons.glyphMap;
  text: (t: (k: string) => string) => string;
} {
  switch (status) {
    case "pending":
    case "approved":
      return { bg: colors.yellow, fg: colors.navy, icon: "time-outline", text: (t) => t("bookingDetail.bannerPending") };
    case "assigned":
      return { bg: colors.green, fg: colors.white, icon: "checkmark-circle", text: (t) => t("bookingDetail.bannerAccepted") };
    case "in_progress":
      return { bg: colors.blue, fg: colors.white, icon: "navigate", text: (t) => t("bookingDetail.bannerInProgress") };
    case "completed":
      return { bg: colors.green, fg: colors.white, icon: "checkmark-done", text: (t) => t("bookingDetail.bannerCompleted") };
    case "rejected":
      return { bg: colors.red, fg: colors.white, icon: "close-circle", text: (t) => t("bookingDetail.bannerRejected") };
    default:
      return { bg: colors.red, fg: colors.white, icon: "close-circle", text: (t) => t("bookingDetail.bannerCancelled") };
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  banner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 14 },
  bannerText: { fontSize: 14, fontWeight: "700" },
  notice: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.tintYellow, borderRadius: radius.md, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#FFE082" },
  noticeText: { flex: 1, fontSize: 14, fontWeight: "600", color: "#92400e" },
  rejectNotice: { flexDirection: "row", alignItems: "flex-start", gap: 10, backgroundColor: "#fef2f2", borderRadius: radius.md, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: "#fecaca" },
  rejectTitle: { fontSize: 12, fontWeight: "700", color: colors.red, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 },
  rejectText: { fontSize: 14, fontWeight: "600", color: "#991b1b", lineHeight: 18 },
  cardLabel: { fontSize: 13, fontWeight: "700", color: colors.textFaint, textTransform: "uppercase", letterSpacing: 0.6 },
  driverRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  driverAvatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.blue, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: colors.yellow, marginRight: 12 },
  driverAvatarText: { color: colors.yellow, fontSize: 16, fontWeight: "800" },
  driverName: { fontSize: 15, fontWeight: "700", color: colors.navy },
  driverSub: { fontSize: 14, color: colors.textMuted, marginTop: 3 },
  driverPhone: { fontSize: 14, color: colors.blue, marginTop: 3, fontWeight: "600" },
  callBtn: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.green, alignItems: "center", justifyContent: "center" },
  detailHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  uploadBtn: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.tintBlue, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  uploadBtnText: { color: colors.blue, fontSize: 13, fontWeight: "700" },
  docEmpty: { fontSize: 14, color: colors.textFaint, marginTop: 10 },
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
