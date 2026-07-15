// Which GPS fix to show for a truck/trip, given its recent LocationLog rows.
//
// Source preference (design note, GPS phase): a truck may have BOTH a
// third-party hardware fix ("vendor") and the driver's phone fix ("phone"). We
// prefer the freshest VENDOR fix, then the freshest PHONE fix, then any other
// fresh source, and finally — if nothing is fresh — the latest fix overall,
// marked stale (the map renders stale as a last-known dot / falls back to the
// zone-approximate pill). Vendor ingestion isn't built yet, so today every row
// is "phone" and this reduces to "latest phone fix" — but the preference is in
// place so the vendor path slots in with no refactor.

export const GPS_STALE_AFTER_MS = 3 * 60 * 1000;

export interface RawFix {
  latitude: unknown; // Prisma Decimal | number | string
  longitude: unknown;
  recorded_at: Date;
  source: string;
}

export interface ResolvedFix {
  latitude: number;
  longitude: number;
  recorded_at: Date;
  source: string;
  stale: boolean;
}

/**
 * Resolve the display fix from a trip's logs (must be ordered NEWEST-first).
 * Returns null when there are no logs at all (caller → approximate). `nowMs`
 * is injectable for tests. Pure.
 */
export function resolveFleetFix(logsDesc: RawFix[], nowMs = Date.now()): ResolvedFix | null {
  if (logsDesc.length === 0) return null;
  const freshCut = nowMs - GPS_STALE_AFTER_MS;
  const fresh = logsDesc.filter((l) => l.recorded_at.getTime() >= freshCut);
  const pick =
    fresh.find((l) => l.source === "vendor") ??
    fresh.find((l) => l.source === "phone") ??
    fresh[0] ??
    logsDesc[0]; // nothing fresh → latest overall, stale
  return {
    latitude: Number(pick.latitude),
    longitude: Number(pick.longitude),
    recorded_at: pick.recorded_at,
    source: pick.source,
    stale: pick.recorded_at.getTime() < freshCut,
  };
}
