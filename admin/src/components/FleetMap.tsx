import { Circle, MapContainer, Marker, TileLayer, Tooltip } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES, truckPosition } from "@/lib/zones";
import { formatTime } from "@/lib/format";
import { colors } from "@/theme";
import type { LivePosition, Truck } from "@/types";

// status → marker color for trucks on the map
const truckColor: Record<string, string> = {
  active: colors.green,
  idle: colors.blue,
  maintenance: colors.orange,
};

// `live` = the marker is on a real GPS fix. We draw a solid border + a small
// green "live dot" on the label. Approximate (zone-centroid) markers get a
// dashed border so admins can tell a guessed position from a real one.
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

export function FleetMap({ trucks, live = [] }: { trucks: Truck[]; live?: LivePosition[] }) {
  // Index live GPS fixes by plate for quick lookup per truck marker.
  const liveByPlate = new Map(live.map((p) => [p.plate, p]));

  return (
    <MapContainer center={MAP_CENTER} zoom={MAP_ZOOM} scrollWheelZoom style={{ height: "100%", width: "100%" }}>
      <TileLayer
        attribution='&copy; OpenStreetMap'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Zone overlays — coloured catchment circles with code labels */}
      {ZONES.map((z) => (
        <Circle
          key={z.code}
          center={[z.lat, z.lng]}
          radius={9000}
          pathOptions={{ color: z.color, fillColor: z.color, fillOpacity: 0.12, weight: 1.5 }}
        >
          <Tooltip permanent direction="center" className="uwc-zone-label">
            <span style={{ color: z.color, fontWeight: 800, fontSize: 13 }}>{z.code}</span>
          </Tooltip>
        </Circle>
      ))}

      {/* Plant origin */}
      <Marker position={[PLANT_ORIGIN.lat, PLANT_ORIGIN.lng]} icon={plantIcon} />

      {/* Trucks — real GPS position when the phone has pinged, else zone centroid */}
      {trucks.map((t) => {
        const fix = liveByPlate.get(t.plate);
        const isLive = Boolean(fix) && !fix!.stale;
        const position: [number, number] = fix
          ? [fix.latitude, fix.longitude]
          : truckPosition(t.plate, t.priority_zones);

        return (
          <Marker
            key={t.plate}
            position={position}
            icon={truckIcon(t.plate, truckColor[t.status] ?? colors.blue, isLive)}
          >
            <Tooltip direction="top" offset={[0, -30]}>
              <div style={{ fontSize: 12 }}>
                <strong>{t.plate}</strong> · {t.type}
                <br />
                {t.driver?.name ?? "No driver"}
                <br />
                Load {t.current_load}/{t.max_pallets} pallets
                <br />
                <span style={{ color: isLive ? colors.green : colors.textMuted, fontWeight: 700 }}>
                  {isLive
                    ? `● Live · ${formatTime(fix!.recorded_at)}`
                    : fix
                      ? "Signal lost (last fix stale)"
                      : "Approx. position (no GPS yet)"}
                </span>
              </div>
            </Tooltip>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
