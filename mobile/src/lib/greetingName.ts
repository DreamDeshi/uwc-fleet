/**
 * Sizing for the name on the three greeting home headers.
 *
 * The problem: a long name "looks off and out of place" (owner, 9 Aug 2026).
 * Malaysian names here run to four and five words — "Muhamad Zulkhairi Bin
 * Yusuf" — and at the design's display size that either wraps to a second line
 * that reads as an orphan, or truncates.
 *
 * TRUNCATION IS NOT AVAILABLE on the driver home: Mr Teh asked for the driver's
 * FULL name there in writing (16 Jul 2026, "Need show the driver full name in
 * driver page"), so cutting it is a requirement violation, not a design call.
 * Shrinking to fit keeps every character and is the only lever that does.
 *
 * So the size steps down as the name grows. A short name keeps the design's
 * display size; a long one settles to something that still reads as the
 * heading of the screen without taking two lines to do it.
 */
export function greetingFontSize(name: string, base: number): number {
  const len = name.trim().length;
  if (len <= 14) return base;
  if (len <= 22) return base - 3;
  if (len <= 30) return base - 5;
  // Floor: below ~15px it stops looking like a heading at all, at which point
  // wrapping to a second line is the better failure. numberOfLines={2} on the
  // callers is what catches that tail.
  return Math.max(15, base - 7);
}

/**
 * The name as a greeting addresses someone: the first two words.
 *
 * "Nurul Huda" (the design's own example) survives intact; "Ahmad Faizal Bin
 * Rahman" becomes "Ahmad Faizal", which is how a colleague would actually say
 * it. One word alone is too blunt for names whose first word is a prefix —
 * "Mohd", "Nurul", "Siti" — and the whole string is unbounded.
 *
 * ⚠ Do NOT use this on the DRIVER home. See the note above: the full name
 * there is a written client requirement.
 */
export function greetingName(name: string | undefined): string {
  return (name ?? "").trim().split(/\s+/).slice(0, 2).join(" ");
}
