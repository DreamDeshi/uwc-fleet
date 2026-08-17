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

// ── MARKER SCALE ───────────────────────────────────────────────────────────
// Sized against the MAP, not the screen. The band frames a ~50 km run in about
// 320px, so a 26px dot covered roughly 4 km of ground and the plant square sat
// wider than Batu Kawan itself. Owner review, 18 Aug 2026: markers are a
// fraction of their former size — readable, not dominating. Previous values are
// in the comment beside each, so a future change is a deliberate step.
// The chip LABEL scales with the marker (10px -> 6px, padding 2/7 -> 0.5/3):
// left at its old size it outweighed the destination and inverted the
// priority, which is the thing the sizing is for. It stays on the map rather
// than moving to a hover — a driver benefits from seeing the plant named.
const plantIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-3px)">
      <div style="background:${colors.navy};color:${colors.yellow};font:700 6px Inter,sans-serif;
           padding:0.5px 3px;border-radius:2px;white-space:nowrap;margin-bottom:2px">${ORIGIN_LABEL}</div>
      <div style="width:7px;height:7px;background:${colors.yellow};border:1.5px solid ${colors.navy};border-radius:2px"></div>
    </div>`,
  iconSize: [7, 18], // was [14, 32]
  iconAnchor: [3.5, 15],
});

const destIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `<div style="width:8px;height:8px;border-radius:50%;background:${colors.red};border:1.5px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.3)"></div>`,
  iconSize: [8, 8], // was [16, 16]
  iconAnchor: [4, 4],
});

/** The driver's own position — same ring-and-core as the native marker. */
const liveIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `
    <div style="width:14px;height:14px;border-radius:50%;background:rgba(0,48,135,0.18);display:flex;align-items:center;justify-content:center">
      <div style="width:8px;height:8px;border-radius:50%;background:${colors.blue};border:1.5px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.3)"></div>
    </div>`,
  iconSize: [14, 14], // was [26, 26]
  iconAnchor: [7, 7],
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

        {/* ONLY the real road geometry, and only when we have it.
            ⚠ There used to be a dashed plant→destination fallback here. It was
            drawn between two pins, not routed on roads, so it implied a path
            that was never computed — and at this zoom a dashed line across the
            map reads as "your route", not as "these two things are related".
            The stand-in is gone; the road line stays, because that one IS
            computed (RouteLeg). Owner ruling, 18 Aug 2026. */}
        {road ? (
          <Polyline
            positions={road.map((p) => [p.latitude, p.longitude] as [number, number])}
            // weight 2 / opacity 0.55 — was 5 / 0.85, which drew wider than the
            // motorways underneath it and read as the dominant road on the map.
            pathOptions={{ color: colors.blue, weight: 2, opacity: 0.55 }}
          />
        ) : null}

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
