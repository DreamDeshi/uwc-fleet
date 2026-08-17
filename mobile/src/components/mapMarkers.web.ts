// Map markers for the WEB (Leaflet) builds — one set, shared by the driver's
// active-trip hero map, the trip-details map and requestor tracking, so the
// three cannot drift into three visual languages for the same three things.
//
// ── WHAT THE DRIVER NEEDS, IN ORDER ────────────────────────────────────────
//
// Owner review, 18 Aug 2026: "The plant is context, the destination is the
// point." The old set inverted that — the plant carried a filled navy-on-yellow
// chip and was the loudest thing on the map, while the destination was a 16px
// dot. Size now follows importance:
//
//   DESTINATION   34×42 pin   — where he is going. The largest thing here.
//   DRIVER        26px ring   — where he is now. Second.
//   PLANT         10px square — where he started. Context, and quiet.
//
// ── COLOUR ─────────────────────────────────────────────────────────────────
//
// Every fill is taken from the OUTDOOR palette (lib/outdoorMode.ts), whose
// members all clear 7:1 on white — not from the ordinary status colours, which
// are tuned for a UI surface rather than a screen held in Penang sun. That is
// deliberate: a map is read outdoors by definition, so it should not need
// outdoor MODE to be legible, and a marker that changes colour with a setting
// is a marker the driver has to re-learn.
//
//   destination  #AE1A1A  outdoor `danger`   7.09:1
//   driver       #003087  brand blue        12.40:1
//   plant        #3A3F52  outdoor `neutral`  7.30:1
//
// ⚠ Orange is not available here even though a marker would suit it: orange is
// reserved app-wide for offline/queued state (standing design ruling).
import L from "leaflet";
import { ORIGIN_LABEL } from "../lib/trip";

/** Outdoor-grade fills. Named, not inlined, so the contrast note above stays true. */
export const MARKER_COLORS = {
  destination: "#AE1A1A",
  driver: "#003087",
  plant: "#3A3F52",
  stale: "#4E5771",
} as const;

const SHADOW = "0 1px 3px rgba(0,0,0,0.35)";

/**
 * THE DESTINATION — a teardrop pin, not a dot.
 *
 * A dot says "something is here". A pin says "this is the place", points at one
 * pixel, and is the shape every driver already reads from Waze and Google Maps.
 * The white core keeps it legible where tiles go dark.
 */
export const destinationIcon = L.divIcon({
  className: "uwc-map-marker",
  html: `
    <div style="width:34px;height:42px;filter:drop-shadow(${SHADOW})">
      <svg width="34" height="42" viewBox="0 0 34 42" xmlns="http://www.w3.org/2000/svg">
        <path d="M17 1C8.7 1 2 7.7 2 16c0 10.5 13.2 23.4 13.8 24a1.7 1.7 0 0 0 2.4 0C18.8 39.4 32 26.5 32 16 32 7.7 25.3 1 17 1z"
              fill="${MARKER_COLORS.destination}" stroke="#fff" stroke-width="2.5"/>
        <circle cx="17" cy="16" r="5.5" fill="#fff"/>
      </svg>
    </div>`,
  iconSize: [34, 42],
  iconAnchor: [17, 42], // the tip, not the centre — a pin points at its place
  tooltipAnchor: [0, -38],
});

/**
 * THE DRIVER — a ring around a core, the convention for "you are here".
 *
 * Distinct from the destination by SHAPE as well as colour, so it survives a
 * sunlit screen and a colour-blind reader: round and haloed vs pointed and
 * solid. Greys out when the fix goes stale rather than disappearing, because
 * "his last known position" is still worth drawing.
 */
export function driverIcon(stale = false) {
  const core = stale ? MARKER_COLORS.stale : MARKER_COLORS.driver;
  const ring = stale ? "rgba(78,87,113,0.20)" : "rgba(0,48,135,0.20)";
  return L.divIcon({
    className: "uwc-map-marker",
    html: `
      <div style="width:26px;height:26px;border-radius:50%;background:${ring};display:flex;align-items:center;justify-content:center">
        <div style="width:15px;height:15px;border-radius:50%;background:${core};border:2.5px solid #fff;box-shadow:${SHADOW}"></div>
      </div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    tooltipAnchor: [0, -14],
  });
}

/**
 * THE PLANT — the quietest thing on the map.
 *
 * It used to be a navy chip filled with yellow text, which read as the subject
 * of the map. It is not: the driver knows where he started. It keeps its name
 * because an unlabelled grey square is a puzzle, but the name is set in a small
 * neutral face with a white halo instead of a filled chip — legible over tiles,
 * silent next to the destination.
 */
export const plantIcon = L.divIcon({
  className: "uwc-map-marker",
  html: `
    <div style="display:flex;flex-direction:column;align-items:center">
      <div style="width:10px;height:10px;background:${MARKER_COLORS.plant};border:2px solid #fff;border-radius:2px;box-shadow:${SHADOW}"></div>
      <div style="font:600 9px Inter,sans-serif;color:${MARKER_COLORS.plant};margin-top:2px;white-space:nowrap;
           text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff">${ORIGIN_LABEL}</div>
    </div>`,
  iconSize: [10, 24],
  iconAnchor: [5, 5],
});
