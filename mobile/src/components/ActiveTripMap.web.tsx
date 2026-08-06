// Active-trip hero map — WEB build (Leaflet + OpenStreetMap, keyless).
//
// This replaces a MapPlaceholder that read "Map view requires the native app
// install". The driver's active trip is the screen the whole GPS phase exists
// to serve, and on web it showed a grey box — the same gap LiveTripMap.web.tsx
// already closed for the trip-details map, with the same reasoning: the web
// app is what UWC actually uses, and an APK is not guaranteed to be permitted
// on their devices at all, which would make web the ONLY driver client.
//
// Native keeps react-native-maps via ActiveTripMap.tsx; Metro resolves this
// file only for web.
//
// Draws what the native map draws, and nothing it doesn't:
//   - the plant origin and the destination
//   - the REAL road polyline when the caller has one (pre-computed RouteLeg),
//     falling back to a straight two-pointer until it loads — same rule as
//     native, so the two builds never disagree about how much precision is
//     being claimed
//   - the live "you are here" dot from this device's GPS, when present
import React, { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Polyline, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import { InvalidateOnLayout } from "./leafletCommon";
import { PLANT_ORIGIN, type LatLng } from "../lib/geo";
import { ORIGIN_LABEL } from "../lib/trip";
import { colors } from "../theme";

const plantIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px)">
      <div style="background:${colors.navy};color:${colors.yellow};font:700 10px Inter,sans-serif;
           padding:2px 7px;border-radius:6px;white-space:nowrap;margin-bottom:3px">${ORIGIN_LABEL}</div>
      <div style="width:14px;height:14px;background:${colors.yellow};border:3px solid ${colors.navy};border-radius:3px"></div>
    </div>`,
  iconSize: [14, 32],
  iconAnchor: [7, 26],
});

const destIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:${colors.red};border:3px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.35)"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

/** The driver's own position — same ring-and-core as the native marker. */
const liveIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `
    <div style="width:26px;height:26px;border-radius:50%;background:rgba(0,48,135,0.18);display:flex;align-items:center;justify-content:center">
      <div style="width:14px;height:14px;border-radius:50%;background:${colors.blue};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.3)"></div>
    </div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

/**
 * Keep every point in frame. The map is locked (matching native's hero map,
 * which the driver does not pan), so framing has to follow the truck itself —
 * a static `bounds` prop would not re-fit after the first render.
 */
function FitToPoints({ points }: { points: LatLng[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.latitude},${p.longitude}`).join("|");
  React.useEffect(() => {
    if (points.length === 0) return;
    const bounds = L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number]));
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14, animate: false });
    // `key`, not `points` — a re-render with identical coordinates must not
    // re-fit and fight the tile load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

export function ActiveTripMap({
  dest,
  destLabel,
  polyline,
  current,
}: {
  /** Native takes an initialRegion; web derives framing from the points. */
  region?: any;
  dest: LatLng;
  destLabel: string;
  polyline?: LatLng[] | null;
  current?: LatLng | null;
}) {
  const road = polyline?.length ? polyline : null;

  const points = useMemo(
    () => [PLANT_ORIGIN, dest, ...(current ? [current] : [])],
    [dest?.latitude, dest?.longitude, current?.latitude, current?.longitude] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // dest can be absent for a trip whose consignee has no coordinates and whose
  // zone has no centroid; a Leaflet map with a NaN centre throws.
  if (!dest || typeof dest.latitude !== "number" || typeof dest.longitude !== "number") {
    return null;
  }

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <MapContainer
        center={[PLANT_ORIGIN.latitude, PLANT_ORIGIN.longitude]}
        zoom={10}
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

        {/* Solid when it is the real road geometry, dashed when it is the
            straight-line stand-in — the driver should never read a placeholder
            as a route he can follow. */}
        <Polyline
          positions={(road ?? [PLANT_ORIGIN, dest]).map(
            (p) => [p.latitude, p.longitude] as [number, number]
          )}
          pathOptions={
            road
              ? { color: colors.blue, weight: 5, opacity: 0.85 }
              : { color: colors.blue, weight: 3, opacity: 0.6, dashArray: "6 8" }
          }
        />

        <Marker position={[PLANT_ORIGIN.latitude, PLANT_ORIGIN.longitude]} icon={plantIcon} interactive={false} />

        <Marker position={[dest.latitude, dest.longitude]} icon={destIcon}>
          <Tooltip direction="top" offset={[0, -10]}>
            <span style={{ fontSize: 12 }}>{destLabel}</span>
          </Tooltip>
        </Marker>

        {current ? (
          <Marker position={[current.latitude, current.longitude]} icon={liveIcon} zIndexOffset={500} interactive={false} />
        ) : null}
      </MapContainer>
    </div>
  );
}
