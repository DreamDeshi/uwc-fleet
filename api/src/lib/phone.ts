/**
 * Phone-number canonicalization. The phone number IS the login ID (User.phone
 * is unique), so registration and login must map the same human input to the
 * same stored string — "0123456789", "123456789", "012-345 6789",
 * "+60123456789" and the double-prefixed "+600123456789" are all one person.
 *
 * ⚠ The illustrative number above is SYNTHETIC. This comment previously used a
 * real Malaysian mobile, described as "one person" — in a public repo, and one
 * that Sentry's contextLines integration would upload as source context around
 * any nearby stack frame. AGENTS.md forbids committing telephone numbers; use
 * an obviously-sequential example here.
 *
 * Canonical form: "+60" + national number with no trunk zero, digits only
 * (e.g. "+60123456789"). Both auth routes normalize through here; nothing
 * else in the API writes User.phone.
 */
export function normalizePhone(input: string): string {
  // Digits only — drops "+", spaces, dashes, parentheses.
  let digits = input.replace(/\D/g, "");
  // A bare country code is not a number.
  if (digits === "60") return "";
  // Peel the 60 country code (repeatedly, so the mobile client's
  // "+60" + "60..." double prefix collapses too). The length guard keeps at
  // least an 8-digit national number, so a real number is never eaten:
  // no Malaysian national number starts with "60" (area code 6 is never
  // followed by a 0-leading subscriber).
  while (digits.startsWith("60") && digits.length >= 10) {
    digits = digits.slice(2);
  }
  // National numbers are stored without the trunk-zero prefix.
  digits = digits.replace(/^0+/, "");
  return digits === "" ? "" : `+60${digits}`;
}

/** True when `phone` is already in canonical form (national part 8–11 digits). */
export function isNormalizedPhone(phone: string): boolean {
  return /^\+60[1-9]\d{7,10}$/.test(phone);
}
