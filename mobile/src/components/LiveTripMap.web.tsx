// Live trip-tracking map — WEB build (Leaflet + OpenStreetMap, keyless).
//
// This is the browser-visible end of the GPS chain: the driver's phone posts to
// POST /locations while a trip is in progress, and this map draws that position
// via GET /trips/:id/location (polled by useTripLatestLocation). Until now the
// web build rendered a placeholder here, so the tracking feature — the point of
// the whole GPS phase — was invisible to everyone on the web app, which is what
// UWC actually uses. Native keeps react-native-maps via LiveTripMap.tsx.
//
// Deliberately NOT drawing the road route: the plant → destination line is a
// plain dashed two-pointer. Real road geometry exists server-side (the
// pre-computed RouteLeg table) but is a separate concern; this map is about the
// live truck position, and a straight line carries no false precision.
//
// The destination is the DESTINATION ZONE'S CENTROID, not the consignee's
// address (Consignee stores zone_code only, with no coordinates), so it is
// labelled approximate. Same honesty rule as the admin fleet map's ghosted
// markers: never let a placeholder read as a real location.
import React, { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { useTranslation } from "react-i18next";
import { InvalidateOnLayout } from "./leafletCommon";
import { PLANT_ORIGIN, zoneCoord, type LatLng } from "../lib/geo";
import { colors } from "../theme";
import { destinationIcon, driverIcon, plantIcon } from "./mapMarkers.web";
import { useTripLatestLocation } from "../hooks/queries";

/**
 * Keep every point in view. The map is locked (no drag/zoom, matching native),
 * so the user cannot re-frame it themselves — the framing must follow the truck
 * as it moves, which a static `bounds` prop would not do after first render.
 */
function FitToPoints({ points }: { points: LatLng[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.latitude},${p.longitude}`).join("|");
  React.useEffect(() => {
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]));
    // Top padding carries the destination pin's 42px height — it is anchored at
    // its tip, so fitting to the coordinate alone clips the head.
    map.fitBounds(bounds, { paddingTopLeft: [36, 56], paddingBottomRight: [36, 36], maxZoom: 13, animate: false });
    // `key` (not `points`) so a re-render with identical coordinates doesn't
    // re-fit and fight the tile load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

export function LiveTripMap({
  tripId,
  destZone,
  destCoord,
  live = true,
  height = 200,
}: {
  tripId: string;
  destZone?: string | null;
  /** The consignee's geocoded position when it has one (see consigneeDestination).
   *  Falls back to the zone centroid so a caller can still pass only destZone. */
  destCoord?: LatLng | null;
  live?: boolean; // poll the truck's position — true only while in transit
  height?: number;
}) {
  const { t } = useTranslation();
  const dest = destCoord ?? zoneCoord(destZone);
  const { data: pos } = useTripLatestLocation(tripId, live);

  const truck: LatLng | null =
    live && pos ? { latitude: pos.latitude, longitude: pos.longitude } : null;

  const points = useMemo(
    () => [PLANT_ORIGIN, dest, ...(truck ? [truck] : [])],
    [dest.latitude, dest.longitude, truck?.latitude, truck?.longitude] // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <div style={{ height, width: "100%", borderRadius: 14, overflow: "hidden" }}>
      <MapContainer
        // Locked to match the native map: it sits inside a scrolling detail
        // screen, and a pannable map there would swallow the page scroll.
        center={[PLANT_ORIGIN.latitude, PLANT_ORIGIN.longitude]}
        zoom={9}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        zoomControl={false}
        attributionControl
        style={{ height: "100%", width: "100%" }}
      >
        <InvalidateOnLayout />
        <FitToPoints points={points} />
        <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {/* ⚠ NO CONNECTOR LINE. A dashed plant→destination two-pointer used to
            be drawn here as "an indication of the journey". It is drawn between
            pins rather than routed on roads, so it claims a path nobody
            computed — and this map has no road geometry to fall back on at all.
            The two pins say where the trip runs between; a line between them
            says how, and we do not know how. Owner ruling, 18 Aug 2026. */}

        <Marker position={[PLANT_ORIGIN.latitude, PLANT_ORIGIN.longitude]} icon={plantIcon} interactive={false} />

        <Marker position={[dest.latitude, dest.longitude]} icon={destinationIcon}>
          <Tooltip direction="top" offset={[0, -8]}>
            <span style={{ fontSize: 12 }}>{t("bookingDetail.mapDestApprox")}</span>
          </Tooltip>
        </Marker>

        {truck && (
          <Marker position={[truck.latitude, truck.longitude]} icon={driverIcon(Boolean(pos?.stale))} zIndexOffset={500}>
            <Tooltip direction="top" offset={[0, -12]}>
              <span style={{ fontSize: 12, fontWeight: 700, color: pos?.stale ? colors.textMuted : colors.green }}>
                {pos?.stale ? t("bookingDetail.locStale") : t("bookingDetail.locLive")}
              </span>
            </Tooltip>
          </Marker>
        )}
      </MapContainer>
    </div>
  );
}
