// Shared Leaflet plumbing for the WEB build. Every Leaflet map in the app
// imports this one module, so the stylesheet import and the sizing fix have a
// SINGLE source and cannot drift apart per-map.
//
// `.web.tsx` because react-leaflet cannot bundle for native — only *.web.tsx
// files may import it, and Metro keeps this out of the native graph entirely.
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./leafletChrome.css";

/**
 * Leaflet computes its tile grid from the container size AT INIT. Inside a
 * ScrollView/flex parent the container often has its final height only AFTER
 * first layout, so the map initialises too small and paints tiles for just the
 * top slice — the rest stays blank white. invalidateSize() re-reads the real
 * size and fills the gap. Fire it right after mount, once more when layout has
 * settled, and whenever the container actually resizes.
 *
 * Lifted verbatim from the admin fleet map, where this exact bug shipped once
 * (map rendered only its top half inside a stretched card). Do not reinvent it
 * per-map: drop <InvalidateOnLayout /> inside any <MapContainer>.
 */
export function InvalidateOnLayout() {
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
