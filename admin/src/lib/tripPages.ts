// Pure helpers for the paged trip board (GET /trips paged mode).
//
// The keyset contract means loaded pages can't overlap or gap in steady
// state (page boundaries are pinned to immutable columns), but the board
// still renders through a defensive by-id dedupe: React keys on trip.id,
// and one duplicated row from any transient server/client mismatch would
// otherwise break the whole board render, not just look odd.

/** Flatten loaded pages newest-first, keeping the FIRST copy of any id. */
export function flattenTripPages<T extends { id: string }>(
  pages: Array<{ items: T[] }> | undefined
): T[] {
  if (!pages) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const page of pages) {
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

/**
 * The filtered-set total for the board header / Load-older label. Every page
 * reports it; the first page's copy is the one the 20s poll refreshes first.
 */
export function tripsTotal(
  pages: Array<{ total: number }> | undefined,
  loadedCount: number
): number {
  const total = pages?.[0]?.total;
  // A total the pages themselves contradict (never expected — trips are
  // never hard-deleted) must not produce a negative "N more" label.
  return typeof total === "number" ? Math.max(total, loadedCount) : loadedCount;
}
