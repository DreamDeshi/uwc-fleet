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
import { AttributionControl, MapContainer, TileLayer, Marker, Tooltip, useMap } from "react-leaflet";
import L, { type Map as LeafletMap } from "leaflet";
import { InvalidateOnLayout } from "../../components/leafletCommon";
import { useTranslation } from "react-i18next";
import { useWide } from "../../hooks/useWide";
import { FOCUS_ZOOM, MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES } from "../lib/zones";
import { formatTime } from "../lib/format";
import { groupFleet, type FleetGroup } from "../lib/fleetGroups";
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


/**
 * Frame the trucks that are actually out there.
 *
 * A fixed centre+zoom is always wrong for somebody: wide enough for Ipoh makes
 * Penang a smudge, tight enough for Penang loses Ipoh. Fitting to the live
 * fixes is right by construction — on an ordinary day every truck is in the
 * northern corridor and the map opens tight on it; the day one runs to Ipoh,
 * the map opens wide enough to show it.
 *
 * The PLANT is always included, so the frame never floats away from the depot.
 * Falls back to the static default when nothing is live. `maxZoom` stops a
 * single truck zooming to rooftop level.
 */
function FitToFleet({ points }: { points: [number, number][] }) {
  const map = useMap();
  // Join on the coordinates, not the array identity — the live query re-fetches
  // every 15s and returns a NEW array each time, which would re-fit (and fight
  // the user's own pan) on every poll even when nothing moved.
  const key = points.map((p) => p.join(",")).join("|");
  useEffect(() => {
    if (points.length === 0) {
      map.setView(MAP_CENTER, MAP_ZOOM);
      return;
    }
    map.fitBounds([[PLANT_ORIGIN.lat, PLANT_ORIGIN.lng], ...points], { padding: [36, 36], maxZoom: 13 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map]);
  return null;
}

export function AdminFleetMap({
  trucks,
  live = [],
  height = 400,
  fill = false,
  idleCollapsed = false,
}: {
  trucks: Truck[];
  live?: LivePosition[];
  height?: number;
  // ONE summary line instead of the full list (admin Home). The list is the
  // right thing on the Fleet screen, where you went looking for lorries; on
  // Home it was the tallest block on the page and made the screen feel like it
  // never ended. Collapsed by default here, one tap to open — nothing is
  // hidden, it just stops being the first thing you scroll past.
  idleCollapsed?: boolean;
  // fill: take the parent's full height (flex:1) instead of a fixed px height —
  // used where the map sits in a stretched card beside a taller rail, so it
  // fills the card rather than leaving white space below a fixed-height map.
  fill?: boolean;
}) {
  const { t } = useTranslation();
  const isWide = useWide();
  // The Leaflet instance, captured off MapContainer's ref. The plant button
  // sits OUTSIDE MapContainer (it is an overlay, not a Leaflet control), so it
  // cannot use useMap() — it needs the instance itself.
  const [map, setMap] = React.useState<LeafletMap | null>(null);
  const focus = React.useCallback(
    (lat: number, lng: number) => map?.setView([lat, lng], FOCUS_ZOOM, { animate: true }),
    [map]
  );
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));
  // A truck gets a map marker ONLY when it has a real fix — i.e. it is on an
  // in-progress trip that has pinged (live OR stale/last-known). Everything else
  // has no live position and must never be drawn at a fake coordinate: it goes
  // to the Idle list beside the map instead.
  const active = trucks.filter((tr) => liveByPlate.has(tr.plate));
  const idle = trucks.filter((tr) => !liveByPlate.has(tr.plate));

  const mapCard = (
    <MapContainer
      ref={setMap}
      center={MAP_CENTER}
      zoom={MAP_ZOOM}
      scrollWheelZoom
      style={{ height: "100%", width: "100%" }}
      // The default control is replaced below so the LEAFLET PREFIX can go
      // while the data credit stays. Do NOT set this to remove attribution
      // outright — see the note on AttributionControl.
      attributionControl={false}
    >
      <InvalidateOnLayout />
      <FitToFleet points={live.map((p) => [p.latitude, p.longitude] as [number, number])} />
      {/* ⚠ THE "© OpenStreetMap" CREDIT IS NOT OPTIONAL. OSM data is ODbL,
          which REQUIRES attribution wherever the tiles are shown — dropping it
          would put the app in breach of the tile terms, and OSM has blocked
          apps for it. What IS optional is Leaflet's own "Leaflet" prefix (the
          little flag bottom-right): the library's docs say that one may be
          removed. `prefix={false}` removes exactly that and nothing else. */}
      <AttributionControl prefix={false} />
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
            // Tap a truck to go to it. On a fleet frame wide enough to hold an
            // outlier, the trucks in the corridor are a cluster of dots — the
            // tooltip tells you WHICH, this gets you THERE.
            eventHandlers={{ click: () => focus(fix.latitude, fix.longitude) }}
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
  //
  // Service-class grouping (28 Jul design) — NARROW ONLY, and only once the
  // fleet has two classes (INTERPLANT_PLATES empty today → `grouped` false →
  // the flat list renders exactly as before: the ship-early contract). Header
  // count pills INCLUDE the class's on-map trucks, so class totals always
  // reconcile to the whole fleet (pinned in lib/fleetGroups.test.ts).
  const groups = groupFleet(trucks, (p) => liveByPlate.has(p));
  const grouped = !isWide && groups.length > 1;
  // Home passes idleCollapsed; the Fleet screen does not, so it keeps the
  // full list exactly as before.
  const [idleOpen, setIdleOpen] = React.useState(false);
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({
    customer: true, // the dispatch pool — open by default
    interplant: false, // two dedicated shuttles — folded, counts still visible
  });

  const idleRow = (tr: Truck) => {
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
  };

  const countPill = (bg: string, fg: string, label: string) => (
    <span key={label} style={{ flexShrink: 0, background: bg, color: fg, fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );

  const groupHeader = (g: FleetGroup, open: boolean) => (
    <div
      key={`${g.key}-head`}
      role="button"
      aria-expanded={open}
      onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !open }))}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        background: "#fafbfe",
        borderBottom: `1px solid ${colors.border}`,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span style={{ width: 12, fontSize: 11, fontWeight: 700, color: colors.textFaint }}>{open ? "▾" : "▸"}</span>
      <span style={{ fontSize: 12, fontWeight: 800, color: colors.text }}>{t(`admin.fleetGroups.${g.key}`)}</span>
      {g.key === "interplant" ? (
        <span style={{ fontSize: 10, color: colors.textFaint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("admin.fleetGroups.interplantSub")}
        </span>
      ) : null}
      <span style={{ flex: 1 }} />
      {g.activeOnMap > 0 && countPill(colors.greenTint, colors.green, t("admin.fleetGroups.countActive", { n: g.activeOnMap }))}
      {g.counts.idle > 0 && countPill(colors.blueTint, colors.blue, t("admin.fleetGroups.countIdle", { n: g.counts.idle }))}
      {g.counts.maintenance > 0 && countPill(colors.orangeTint, colors.orange, t("admin.fleetGroups.countMaintenance", { n: g.counts.maintenance }))}
      {g.counts.retired > 0 && countPill(colors.bg, colors.textMuted, t("admin.fleetGroups.countRetired", { n: g.counts.retired }))}
    </div>
  );

  // ONE summary line instead of the full list when the host asks for it.
  const idleSummary = idle.length > 0 && idleCollapsed && !idleOpen && (
    <button
      type="button"
      onClick={() => setIdleOpen(true)}
      aria-expanded={false}
      style={{
        display: "flex", alignItems: "center", gap: 9, width: "100%",
        background: colors.card, border: `1px solid ${colors.border}`,
        borderRadius: 12, padding: "11px 13px", cursor: "pointer",
        font: "inherit", textAlign: "left",
      }}
    >
      <span style={{ width: 26, height: 26, borderRadius: 8, background: colors.blueTint,
                     display: "grid", placeItems: "center", fontSize: 12,
                     color: colors.blue, fontWeight: 800, flex: "none" }}>{idle.length}</span>
      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: colors.text }}>
        {t("admin.trucks.statusIdle")} · {t("admin.fleetGroups.notTracked")}
      </span>
      <span style={{ fontSize: 12, fontWeight: 700, color: colors.blue }}>{t("admin.fleetGroups.showAll")}</span>
    </button>
  );

  const idlePanel = idle.length > 0 && (!idleCollapsed || idleOpen) && (
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
        // No narrow height cap (28 Jul, parity with map.tsx): all trucks
        // render in full on phones; the page scrolls.
      }}
    >
      {grouped ? (
        groups.map((g) => {
          const open = openGroups[g.key] ?? false;
          return (
            <React.Fragment key={g.key}>
              {groupHeader(g, open)}
              {open && g.rows.map(idleRow)}
            </React.Fragment>
          );
        })
      ) : (
        // Single class (today's fleet) or the WIDE sidebar: flat, unchanged.
        <>
          <div style={{ padding: "8px 12px", borderBottom: `1px solid ${colors.border}`, fontWeight: 700, fontSize: 12, color: colors.text }}>
            {t("admin.trucks.statusIdle")} · {idle.length}
          </div>
          <div style={{ overflowY: "auto" }}>{idle.map(idleRow)}</div>
        </>
      )}
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
            ? { flex: 1, minHeight: 0, borderRadius: 12, overflow: "hidden", position: "relative" }
            : { height, width: "100%", borderRadius: 12, overflow: "hidden", position: "relative" }
        }
      >
        {mapCard}
        {/* Jump to the plant. Deliberately SMALL and out of the way (owner:
            "a really small button") — the map's job is the fleet; this is a
            way back to the depot when you have panned off, not a headline
            control. Sits opposite Leaflet's own zoom buttons so it never
            covers them, and above the attribution, which must stay legible. */}
        <button
          type="button"
          onClick={() => focus(PLANT_ORIGIN.lat, PLANT_ORIGIN.lng)}
          title={t("admin.dashboard.focusPlant")}
          aria-label={t("admin.dashboard.focusPlant")}
          style={{
            position: "absolute", top: 10, right: 10, zIndex: 500,
            display: "flex", alignItems: "center", gap: 6,
            background: colors.card, border: `1px solid ${colors.border}`,
            borderRadius: 8, padding: "5px 8px", cursor: "pointer",
            font: "inherit", fontSize: 11, fontWeight: 700, color: colors.navy,
            boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
          }}
        >
          <span style={{ width: 9, height: 9, background: colors.yellow,
                         border: `2px solid ${colors.navy}`, borderRadius: 2, display: "inline-block" }} />
          {t("admin.dashboard.focusPlantShort")}
        </button>
      </div>
      {idleSummary}
      {idlePanel}
    </div>
  );
}
