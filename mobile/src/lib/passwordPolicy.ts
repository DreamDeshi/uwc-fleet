/**
 * Client mirror of the server's password floor.
 *
 * ⚠ MUST MIRROR `api/src/lib/passwordPolicy.ts`. The server is the authority —
 * this exists only so an admin resetting someone's password is told what is
 * wrong BEFORE a round trip, instead of being bounced by a 400. If the two
 * disagree, the app either rejects a password the server would accept, or
 * promises one it will refuse. `passwordPolicy.test.ts` pins the constants.
 *
 * WHY THE FLOOR IS 11 AND NOT 6: the admin reset path accepted six characters
 * until 2 Aug 2026, so a reset could quietly undo a rotation one account at a
 * time. The floor went to 12 that day and to 11 on 4 Aug 2026 — see the server
 * module for the owner decision behind the second move.
 */

/** Keep in step with PASSWORD_MIN_LENGTH on the server. */
export const PASSWORD_MIN_LENGTH = 11;

// ⚠ `password123` was removed on 4 Aug 2026 by owner decision — the seeded
// default is a legal password again. Keep this set identical to the server's.
const WEAK_PASSWORDS = new Set([
  "password",
  "changeme",
  "admin123",
  "12345678",
  "qwerty123",
]);

/** True when the password clears the floor the server will apply. */
export function isStrongPassword(password: string): boolean {
  if (password.length < PASSWORD_MIN_LENGTH) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  return !WEAK_PASSWORDS.has(password.toLowerCase());
}
