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
import React from "react";
import { MapContainer, TileLayer, Marker, Tooltip } from "react-leaflet";
import L from "leaflet";
import { InvalidateOnLayout } from "../../components/leafletCommon";
import { useTranslation } from "react-i18next";
import { useWide } from "../../hooks/useWide";
import { MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES } from "../lib/zones";
import { formatTime } from "../lib/format";
import { colors } from "../theme";
import type { LivePosition, Truck } from "../types";

const truckColor: Record<string, string> = {
  active: colors.green,
  idle: colors.blue,
  maintenance: colors.orange,
};

// Every mapped truck has a REAL fix now (idle/no-fix trucks live in the side
// list, never on a fake coordinate). A LIVE fix gets a solid border + green dot;
// a STALE one keeps its colour (it IS a real last-known point) with a dashed
// border and no dot.
function truckIcon(plate: string, color: string, live: boolean) {
  const border = live ? `1.5px solid ${color}` : `1.5px dashed ${color}`;
  const liveDot = live
    ? `<span style="width:6px;height:6px;border-radius:50%;background:${colors.green};display:inline-block;margin-right:4px"></span>`
    : "";
  return L.divIcon({
    className: "uwc-truck-label",
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px)">
        <div style="display:flex;align-items:center;background:#fff;border:${border};color:${colors.navy};font:700 10px Inter,sans-serif;
             padding:1px 6px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);margin-bottom:3px">${liveDot}${plate}</div>
        <div style="width:22px;height:22px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;
             box-shadow:0 0 0 4px ${color}33;border:2px solid #fff">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="1" y="7" width="13" height="9" rx="1.5" fill="#fff"/><path d="M14 10h4l3 3v3h-7z" fill="#fff"/></svg>
        </div>
      </div>`,
    iconSize: [22, 40],
    iconAnchor: [11, 34],
  });
}

// Status tag shown on each Idle-list row. Reuses the existing admin.trucks.*
// status strings + theme tints — no new palette, no new copy.
function statusTag(status: string): { bg: string; fg: string; labelKey: string } {
  switch (status) {
    case "active":
      return { bg: colors.greenTint, fg: colors.green, labelKey: "admin.trucks.statusActive" };
    case "maintenance":
      return { bg: colors.orangeTint, fg: colors.orange, labelKey: "admin.trucks.statusMaintenance" };
    case "retired":
      return { bg: colors.bg, fg: colors.textMuted, labelKey: "admin.trucks.statusRetired" };
    default: // "idle"
      return { bg: colors.blueTint, fg: colors.blue, labelKey: "admin.trucks.statusIdle" };
  }
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
  const isWide = useWide();
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));
  // A truck gets a map marker ONLY when it has a real fix — i.e. it is on an
  // in-progress trip that has pinged (live OR stale/last-known). Everything else
  // has no live position and must never be drawn at a fake coordinate: it goes
  // to the Idle list beside the map instead.
  const active = trucks.filter((tr) => liveByPlate.has(tr.plate));
  const idle = trucks.filter((tr) => !liveByPlate.has(tr.plate));

  const mapCard = (
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

      {/* Active trucks — every one sits on a real GPS fix (live or stale) */}
      {active.map((tr) => {
        const fix = liveByPlate.get(tr.plate)!;
        const isLive = !fix.stale;
        return (
          <Marker
            key={tr.plate}
            position={[fix.latitude, fix.longitude]}
            icon={truckIcon(tr.plate, truckColor[tr.status] ?? colors.blue, isLive)}
            zIndexOffset={500}
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
                    ? `● ${t("admin.dashboard.mapLive", { time: formatTime(fix.recorded_at) })}`
                    : t("admin.dashboard.mapStale")}
                </span>
              </div>
            </Tooltip>
          </Marker>
        );
      })}
    </MapContainer>
  );

  // Idle trucks: no live position, so NOT on the map. A compact side list
  // (narrow column on wide, stacked below on phone). Hidden entirely when the
  // whole fleet is active, so the map takes the full width.
  const idlePanel = idle.length > 0 && (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: colors.card,
        border: `1px solid ${colors.border}`,
        borderRadius: 12,
        overflow: "hidden",
        flexShrink: 0,
        width: isWide ? 190 : "100%",
        maxHeight: isWide ? undefined : 190,
      }}
    >
      <div style={{ padding: "8px 12px", borderBottom: `1px solid ${colors.border}`, fontWeight: 700, fontSize: 12, color: colors.text }}>
        {t("admin.trucks.statusIdle")} · {idle.length}
      </div>
      <div style={{ overflowY: "auto" }}>
        {idle.map((tr) => {
          const tag = statusTag(tr.status);
          return (
            <div
              key={tr.plate}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "7px 12px", borderBottom: `1px solid ${colors.divider}` }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: colors.navy, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tr.plate}</div>
                <div style={{ fontSize: 11, color: colors.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {tr.type}
                  {tr.driver ? ` · ${tr.driver.name}` : ""}
                </div>
              </div>
              <span style={{ flexShrink: 0, background: tag.bg, color: tag.fg, fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
                {t(tag.labelKey)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isWide ? "row" : "column",
        gap: 12,
        width: "100%",
        ...(fill ? { flex: 1, minHeight: 0 } : isWide ? { height } : {}),
      }}
    >
      <div
        style={
          isWide
            ? { flex: 1, minHeight: 0, borderRadius: 12, overflow: "hidden" }
            : { height, width: "100%", borderRadius: 12, overflow: "hidden" }
        }
      >
        {mapCard}
      </div>
      {idlePanel}
    </div>
  );
}
