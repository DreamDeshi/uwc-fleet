/**
 * Phone-number canonicalization. The phone number IS the login ID (User.phone
 * is unique), so registration and login must map the same human input to the
 * same stored string — "0174145245", "174145245", "017-414 5245",
 * "+60174145245" and the double-prefixed "+600174145245" are all one person.
 *
 * Canonical form: "+60" + national number with no trunk zero, digits only
 * (e.g. "+60174145245"). Both auth routes normalize through here; nothing
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

/**
 * The pre-normalization malformed shape of a canonical number: the mobile
 * client used to prepend "+60" without stripping the trunk zero, storing
 * "+600174145245". Login/registration check this variant so accounts created
 * before the fix keep working until the one-off data correction runs —
 * remove this (and its call sites) once no "+600…" rows remain.
 */
export function legacyZeroVariant(canonical: string): string {
  return canonical.replace(/^\+60/, "+600");
}
