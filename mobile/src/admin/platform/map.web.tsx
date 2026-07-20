// Admin fleet map — WEB build (Leaflet + OpenStreetMap, keyless): zone code
// labels, the plant marker, and per-truck markers that sit on a real GPS fix
// when the phone has pinged or the zone centroid otherwise.
//
// The zone CATCHMENT CIRCLES were removed 2026-07-20 (owner). They were never
// real boundaries — ZONES is a hand-written centroid list and every circle used
// the SAME hardcoded 9km radius, so P1/P2/P3/K1 (centroids ~10-25km apart)
// overlapped into a blob at zoom 8 and their permanent labels collided with the
// truck pills. Nothing in the data can draw a true catchment: Consignee stores
// zone_code only, no coordinates. Only the code label remains.
import React, { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./leaflet.css";
import { useTranslation } from "react-i18next";
import { MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES, truckPosition } from "../lib/zones";
import { formatTime } from "../lib/format";
import { colors } from "../theme";
import type { LivePosition, Truck } from "../types";

const truckColor: Record<string, string> = {
  active: colors.green,
  idle: colors.blue,
  maintenance: colors.orange,
};

// `approx` = the truck has NO GPS fix at all, so it is drawn on its zone
// centroid (a placeholder, not a location). Those are GHOSTED — grey, faded,
// and prefixed "~" — so a solid coloured marker always means a real fix and
// nobody reads a placeholder as a lorry's actual position. A stale fix keeps
// its colour (it IS a real last-known point) and just loses the live dot.
function truckIcon(plate: string, color: string, live: boolean, approx: boolean) {
  const markerColor = approx ? colors.textMuted : color;
  const border = live ? `1.5px solid ${markerColor}` : `1.5px dashed ${markerColor}`;
  const liveDot = live
    ? `<span style="width:6px;height:6px;border-radius:50%;background:${colors.green};display:inline-block;margin-right:4px"></span>`
    : "";
  // "~" reads as approximate in every locale — no new translation string.
  const label = approx ? `~${plate}` : plate;
  return L.divIcon({
    className: "uwc-truck-label",
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px);opacity:${approx ? 0.45 : 1}">
        <div style="display:flex;align-items:center;background:#fff;border:${border};color:${approx ? colors.textMuted : colors.navy};font:700 10px Inter,sans-serif;
             padding:1px 6px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);margin-bottom:3px">${liveDot}${label}</div>
        <div style="width:22px;height:22px;border-radius:50%;background:${markerColor};display:flex;align-items:center;justify-content:center;
             box-shadow:${approx ? "none" : `0 0 0 4px ${markerColor}33`};border:2px solid #fff">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="1" y="7" width="13" height="9" rx="1.5" fill="#fff"/><path d="M14 10h4l3 3v3h-7z" fill="#fff"/></svg>
        </div>
      </div>`,
    iconSize: [22, 40],
    iconAnchor: [11, 34],
  });
}

// Zone code label — a standalone, non-interactive marker at the centroid. It
// used to be a permanent Tooltip on the (now removed) catchment circle.
function zoneLabelIcon(code: string, color: string) {
  return L.divIcon({
    className: "uwc-zone-label",
    html: `<span style="color:${color};font:800 13px Inter,sans-serif;opacity:0.75;white-space:nowrap;
           text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">${code}</span>`,
    iconSize: [30, 16],
    iconAnchor: [15, 8],
  });
}

// Leaflet computes its tile grid from the container size AT INIT. Inside a
// ScrollView/flex parent the container often has its final height only AFTER
// first layout, so the map initialises too small and paints tiles for just the
// top slice — the rest stays blank white. invalidateSize() re-reads the real
// size and fills the gap. Fire it right after mount, once more when layout has
// settled, and whenever the container actually resizes.
function InvalidateOnLayout() {
  const map = useMap();
  useEffect(() => {
    const fix = () => map.invalidateSize();
    const t0 = setTimeout(fix, 0);
    const t1 = setTimeout(fix, 300);
    const el = map.getContainer();
    const ro = new ResizeObserver(fix);
    ro.observe(el);
    window.addEventListener("resize", fix);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      ro.disconnect();
      window.removeEventListener("resize", fix);
    };
  }, [map]);
  return null;
}

const plantIcon = L.divIcon({
  className: "uwc-truck-label",
  html: `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px)">
      <div style="background:${colors.navy};color:#FFCC00;font:700 10px Inter,sans-serif;padding:2px 7px;border-radius:6px;white-space:nowrap;margin-bottom:3px">UWC PLANT</div>
      <div style="width:16px;height:16px;background:${colors.yellow};border:3px solid ${colors.navy};border-radius:3px"></div>
    </div>`,
  iconSize: [16, 34],
  iconAnchor: [8, 28],
});

export function AdminFleetMap({
  trucks,
  live = [],
  height = 400,
  fill = false,
}: {
  trucks: Truck[];
  live?: LivePosition[];
  height?: number;
  // fill: take the parent's full height (flex:1) instead of a fixed px height —
  // used where the map sits in a stretched card beside a taller rail, so it
  // fills the card rather than leaving white space below a fixed-height map.
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));

  return (
    <div
      style={
        fill
          ? { flex: 1, minHeight: 0, width: "100%", borderRadius: 12, overflow: "hidden" }
          : { height, width: "100%", borderRadius: 12, overflow: "hidden" }
      }
    >
      <MapContainer center={MAP_CENTER} zoom={MAP_ZOOM} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
        <InvalidateOnLayout />
        <TileLayer attribution="&copy; OpenStreetMap" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />

        {/* Zone code labels only — no catchment circles (see file header) */}
        {ZONES.map((z) => (
          <Marker
            key={z.code}
            position={[z.lat, z.lng]}
            icon={zoneLabelIcon(z.code, z.color)}
            interactive={false}
            keyboard={false}
          />
        ))}

        {/* Plant origin */}
        <Marker position={[PLANT_ORIGIN.lat, PLANT_ORIGIN.lng]} icon={plantIcon} />

        {/* Trucks — real GPS position when the phone has pinged, else zone centroid */}
        {trucks.map((tr) => {
          const fix = liveByPlate.get(tr.plate);
          const isLive = Boolean(fix) && !fix!.stale;
          const approx = !fix; // no fix at all → zone centroid placeholder
          const position: [number, number] = fix
            ? [fix.latitude, fix.longitude]
            : truckPosition(tr.plate, tr.priority_zones);

          return (
            <Marker
              key={tr.plate}
              position={position}
              icon={truckIcon(tr.plate, truckColor[tr.status] ?? colors.blue, isLive, approx)}
              // keep ghosts behind real fixes where they overlap
              zIndexOffset={approx ? 0 : 500}
            >
              <Tooltip direction="top" offset={[0, -30]}>
                <div style={{ fontSize: 13 }}>
                  <strong>{tr.plate}</strong> · {tr.type}
                  <br />
                  {tr.driver?.name ?? t("admin.dashboard.mapNoDriver")}
                  <br />
                  {t("admin.dashboard.loadPallets", { load: tr.current_load, capacity: tr.max_pallets })}
                  <br />
                  <span style={{ color: isLive ? colors.green : colors.textMuted, fontWeight: 700 }}>
                    {isLive
                      ? `● ${t("admin.dashboard.mapLive", { time: formatTime(fix!.recorded_at) })}`
                      : fix
                        ? t("admin.dashboard.mapStale")
                        : t("admin.dashboard.mapApprox")}
                  </span>
                </div>
              </Tooltip>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
