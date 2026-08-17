/**
 * ARE TWO ADDRESSES SHARING ONE PIN THE SAME PLACE?
 *
 * The duplicate-pin backstop demotes any BUILDING-grade coordinate shared by a
 * different address, because a shared "rooftop" is the geocoder giving up
 * rather than two firms in one building. Deleting the position was the only
 * answer available at the time; it sent the driver to a zone centroid a MEDIAN
 * OF 7.3 KM AWAY (measured on the 222 affected production rows: 70% over 5 km,
 * worst 46 km).
 *
 * With precision as a value, there is a third option — keep the pin at a
 * coarser grade — but only where the members really are the same place.
 *
 * ⚠ POSITIVE EVIDENCE ONLY. A cluster is downgraded when it can be SHOWN to be
 * one place. "Cannot tell" leaves it demoted, because the cost of guessing
 * wrong is a driver at another company's gate, while the cost of being
 * cautious is the status quo.
 *
 * ⚠ THIS PARSER WAS WRONG TWICE BEFORE IT WAS RIGHT, both times quietly.
 *   1. It knew only full words, so `JLN`, `LRG`, `TMN`, `KWS` and `LINTANG`
 *      all read as "no street found". A third of clusters landed in a bucket
 *      that a weaker plan would have downgraded — and a sample of ten showed
 *      two genuinely different streets sitting in it.
 *   2. Fixed, it then over-extracted: it swallowed trailing words unevenly
 *      ("... MINYAK 7 MUKIM 13" vs "... MINYAK 7"), so the SAME street compared
 *      unequal and 37 clusters were called different. That error was in the
 *      safe direction, which is exactly why it could have shipped unnoticed.
 * Both were found by reading samples, not by any assertion. Keep the fixtures
 * in the test file honest and add to them when a new address shape appears.
 */

/** Abbreviations and typos seen in the live consignee table. */
const ABBREV: [RegExp, string][] = [
  [/\bJLN\.?\b/g, "JALAN"],
  [/\bLRG\.?\b/g, "LORONG"],
  [/\bTMN\.?\b/g, "TAMAN"],
  [/\bKWS\.?\b/g, "KAWASAN"],
  [/\bKAW\.?\b/g, "KAWASAN"],
  [/\bBKT\.?\b/g, "BUKIT"],
  [/\bPSRN\.?\b/g, "PERSIARAN"],
  [/\bSG\.?\b/g, "SUNGAI"],
  [/\bMK\.?\s*(\d+)/g, "MUKIM $1"],
  [/\bIND\.?\b/g, "INDUSTRIAL"],
  [/\bPERINDUSTRIAL\b/g, "PERINDUSTRIAN"],
  [/\bPERINDUTRIAN\b/g, "PERINDUSTRIAN"],
  [/\bP'INUSTRIAN\b/g, "PERINDUSTRIAN"],
  // "NO. 756" and "756" are the same building.
  [/^NO\s+/g, ""],
];

/**
 * Street-type words, longest first so LEBUHRAYA is not read as LEBUH.
 *
 * ⚠ KAWASAN and TAMAN are NOT here. They name an AREA, not a street ("Kawasan
 * Perindustrian Bukit Minyak" is an estate containing many streets), and they
 * are section words below. Listing them both ways made the lookup return
 * whichever the LIST reached first rather than whichever the ADDRESS began
 * with, so "797, JLN PERINDUSTRIAN BUKIT MINYAK 7, KAW. PERINDUSTRIAN"
 * resolved to "KAWASAN PERINDUSTRIAN" — an estate shared by dozens of
 * unrelated firms, which would have merged them all into one "street".
 */
const STREET_TYPES = [
  "LEBUHRAYA", "PERSIARAN", "PENGKALAN", "LENGKOK", "LENG KOK", "LINTANG",
  "TINGKAT", "LORONG", "MEDAN", "SOLOK", "JALAN", "LEBUH", "GAT",
];

/** Words that begin a SECTION rather than continue a street name. */
const SECTION = /^(MUKIM|MK|KAWASAN|TAMAN|PHASE|FASA|ZON|ZONE|BANDAR|SEBERANG|DAERAH)$/;
/** A street number ends the name: "Bukit Minyak 7" and "…20" differ. */
const NUMBERISH = /^[0-9]+([/-][0-9A-Z]+)?$/;

export function normaliseAddress(raw: string | null | undefined): string {
  let t = (raw ?? "").toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of ABBREV) t = t.replace(re, to);
  return t.replace(/\s+/g, " ").trim();
}

/** True when address_1 is a "care of" line — a company, not a place. */
export function isCareOfLine(raw: string | null | undefined): boolean {
  return /^\s*C\s*\/\s*O\b/i.test((raw ?? "").trim());
}

/**
 * The street phrase, or null when none can be found. Stops at a section word
 * and immediately after a street number, so the result does not depend on how
 * much trailing detail the clerk happened to type.
 */
export function streetOf(raw: string | null | undefined): string | null {
  const t = normaliseAddress(raw);
  // The EARLIEST street type in the string, not the first in the list — an
  // address names its street before its estate, and iterating the list picked
  // whichever word happened to be listed first.
  let best: { type: string; i: number } | null = null;
  for (const type of STREET_TYPES) {
    const i = t.indexOf(type + " ");
    if (i === -1) continue;
    if (!best || i < best.i || (i === best.i && type.length > best.type.length)) best = { type, i };
  }
  if (!best) return null;
  const words = t.slice(best.i + best.type.length + 1).split(" ").filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (STREET_TYPES.includes(w) || SECTION.test(w) || w.startsWith("(")) break;
    out.push(w);
    if (NUMBERISH.test(w)) break;
    if (out.length >= 6) break;
  }
  return out.length ? `${best.type} ${out.join(" ")}` : null;
}

export type ClusterVerdict = "SAME_ADDRESS" | "SAME_STREET" | "DIFFERENT" | "UNKNOWN";

/** Is this cluster of addresses provably one place? */
export function classifyCluster(addresses: (string | null | undefined)[]): ClusterVerdict {
  if (addresses.some((a) => isCareOfLine(a) || !(a ?? "").trim())) return "UNKNOWN";

  const cleaned = new Set(addresses.map(normaliseAddress));
  if (cleaned.size === 1) return "SAME_ADDRESS";

  const streets = addresses.map(streetOf);
  if (streets.some((s) => s === null)) return "UNKNOWN";

  // PREFIX-COMPATIBLE, not equal: the same street is written with varying
  // amounts of trailing detail, and demanding equality called those different.
  const all = streets as string[];
  const compatible = all.every((a) => all.every((b) => a.startsWith(b) || b.startsWith(a)));
  return compatible ? "SAME_STREET" : "DIFFERENT";
}

/** Verdicts whose pin is kept, at road grade. */
export function keepsPin(v: ClusterVerdict): boolean {
  return v === "SAME_ADDRESS" || v === "SAME_STREET";
}
