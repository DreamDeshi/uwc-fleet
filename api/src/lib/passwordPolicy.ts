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

/** Minimum length. Matches what the prod rotation actually used. */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Passwords a rotation must never re-introduce. `password123` is here because
 * it IS the seeded default this project shipped with (published in three
 * READMEs), so re-setting it is the specific regression worth blocking.
 */
export const WEAK_PASSWORDS = new Set([
  "password123",
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
