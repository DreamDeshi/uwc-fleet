// Saved booking templates — the requestor "save function" (owner ask, 2026-07-19).
// The twin of the admin saved filter presets: a requestor names a recurring
// order (route + stops + cargo + remarks) and reloads it in one tap on a later
// booking. Device-local (AsyncStorage) — no server, no schema.
//
// Pallets are stored KEYED BY SIZE, never as a positional array: the booking
// form keeps its own display order for PALLET_SIZES and that order has changed
// before (item 2 took it 5→10 sizes). A stored index array would silently
// misalign after any such reorder — the exact class of bug called out in
// BookingFormScreen. A size→qty map is order-independent, so a template saved
// today still loads correctly if the display order is reshuffled tomorrow.
//
// Pure helpers (build/upsert/remove/pallet mapping) are unit-tested in
// bookingTemplates.test.ts; only load/persist touch AsyncStorage.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PalletSize } from "./pallets";
import type { Consignee } from "../types";

export interface BookingTemplate {
  name: string;
  routeTypeId?: string;
  // Full consignee snapshots so the chips/stops render without a re-fetch.
  // Device-local: a renamed consignee shows its old label until re-saved — the
  // Confirm step still shows what will actually be booked before submit.
  stops: Consignee[];
  cargoType: "pallet" | "carton" | "others";
  // Only non-zero sizes are kept; missing = 0 on reload.
  pallets: Partial<Record<PalletSize, number>>;
  cartonQty: number;
  othersText: string;
  sizeEstimate: string;
  remarks: string;
}

const KEY = "requestor.bookingTemplates.v1";

export async function loadTemplates(): Promise<BookingTemplate[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as BookingTemplate[]) : [];
  } catch {
    return [];
  }
}

export async function persistTemplates(list: BookingTemplate[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* device storage best-effort — a failed write just loses the new template */
  }
}

/** Build the size→qty map from the form's index-aligned qty array, dropping
 *  zeros so a template only carries the sizes the requestor actually ordered. */
export function palletsMap(sizes: readonly PalletSize[], qtys: number[]): Partial<Record<PalletSize, number>> {
  const out: Partial<Record<PalletSize, number>> = {};
  sizes.forEach((size, i) => {
    const q = qtys[i] ?? 0;
    if (q > 0) out[size] = q;
  });
  return out;
}

/** Rebuild the form's index-aligned qty array for a given display order from a
 *  template's size→qty map — the inverse of palletsMap, order-independent. */
export function palletQtysFor(tpl: BookingTemplate, sizes: readonly PalletSize[]): number[] {
  return sizes.map((size) => tpl.pallets?.[size] ?? 0);
}

/** Replace a same-named template rather than duplicate it (matches FilterPresets). */
export function upsertTemplate(list: BookingTemplate[], tpl: BookingTemplate): BookingTemplate[] {
  return [...list.filter((t) => t.name !== tpl.name), tpl];
}

export function removeTemplate(list: BookingTemplate[], name: string): BookingTemplate[] {
  return list.filter((t) => t.name !== name);
}
