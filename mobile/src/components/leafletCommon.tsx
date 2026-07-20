// NATIVE counterpart of leafletCommon.web.tsx — Leaflet is a browser library and
// cannot bundle for iOS/Android, so there is nothing to do here.
//
// This file exists so the module RESOLVES on native (tsc and Metro both need a
// base file next to a .web one) and so an accidental native import fails safely
// as a no-op instead of dragging react-leaflet into the native bundle. Native
// maps use react-native-maps — see LiveTripMap.tsx / admin/platform/map.tsx.
export function InvalidateOnLayout(): null {
  return null;
}
