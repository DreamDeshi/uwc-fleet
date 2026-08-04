/**
 * THE password strength floor — one definition, shared by every path that can
 * set a password on someone's behalf.
 *
 * ⚠ WHY IT IS SHARED RATHER THAN RESTATED. On 2 Aug 2026 the eight seeded prod
 * accounts were rotated to 16-char CSPRNG passwords behind a floor enforced in
 * `prisma/adminCredsCommon.ts` (≥12, mixed case, a digit, no known default).
 * The admin reset endpoint meanwhile accepted SIX characters — so an admin
 * could quietly undo that rotation one account at a time with `abc123`, and
 * nothing would have flagged it. Two copies of a rule is how the floors drift;
 * the CLI now imports this module rather than keeping its own.
 *
 * Deliberately a FLOOR, not a policy engine: no rotation schedule, no history,
 * no character-class gymnastics. It exists to stop a password that is worse
 * than the one it replaces.
 */

/**
 * Minimum length.
 *
 * ⚠ OWNER DECISION, 4 Aug 2026: lowered 12 → 11 so the eight prod accounts could
 * go back to the memorable seeded password. This is deliberate, not drift — do
 * NOT "restore" it to 12 without asking the owner first.
 */
export const PASSWORD_MIN_LENGTH = 11;

/**
 * Passwords a rotation must never re-introduce.
 *
 * ⚠ `password123` was removed from this set on 4 Aug 2026 by owner decision, so
 * that the seeded default `Password123` is a legal password again. The lowercase
 * and uppercase spellings are still refused, but by the character-class rules
 * rather than by this list. Re-adding it would lock every prod account out of
 * its own password — ask the owner before you do.
 */
export const WEAK_PASSWORDS = new Set([
  "password",
  "changeme",
  "admin123",
  "12345678",
  "qwerty123",
]);

/**
 * Every requirement this password fails to meet, as human-readable fragments.
 * Empty array = acceptable.
 *
 * Returns ALL problems rather than the first, so someone fixing a rejected
 * password is told everything at once instead of playing whack-a-mole.
 */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) problems.push("a lowercase letter");
  if (!/[A-Z]/.test(password)) problems.push("an uppercase letter");
  if (!/[0-9]/.test(password)) problems.push("a digit");
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    problems.push("to not be a well-known or default password");
  }
  return problems;
}

export function isStrongPassword(password: string): boolean {
  return passwordProblems(password).length === 0;
}

/** One sentence naming everything that is wrong, for an API error message. */
export function passwordProblemMessage(password: string): string {
  return `Password must have ${passwordProblems(password).join(", ")}.`;
}
