import { Circle, MapContainer, Marker, TileLayer, Tooltip } from "react-leaflet";
import L from "leaflet";
import { MAP_CENTER, MAP_ZOOM, PLANT_ORIGIN, ZONES, truckPosition } from "@/lib/zones";
import { colors } from "@/theme";
import type { Truck } from "@/types";

// status → marker color for trucks on the map
const truckColor: Record<string, string> = {
  active: colors.green,
  idle: colors.blue,
  maintenance: colors.orange,
};

function truckIcon(plate: string, color: string) {
  return L.divIcon({
    className: "uwc-truck-label",
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;transform:translateY(-6px)">
        <div style="background:#fff;border:1.5px solid ${color};color:${colors.navy};font:700 10px Inter,sans-serif;
             padding:1px 6px;border-radius:6px;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,0.2);margin-bottom:3px">${plate}</div>
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

export function FleetMap({ trucks }: { trucks: Truck[] }) {
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

      {/* Trucks (approx. position from priority zone — no live GPS yet) */}
      {trucks.map((t) => (
        <Marker
          key={t.plate}
          position={truckPosition(t.plate, t.priority_zones)}
          icon={truckIcon(t.plate, truckColor[t.status] ?? colors.blue)}
        >
          <Tooltip direction="top" offset={[0, -30]}>
            <div style={{ fontSize: 12 }}>
              <strong>{t.plate}</strong> · {t.type}
              <br />
              {t.driver?.name ?? "No driver"}
              <br />
              Load {t.current_load}/{t.max_pallets} pallets
            </div>
          </Tooltip>
        </Marker>
      ))}
    </MapContainer>
  );
}
