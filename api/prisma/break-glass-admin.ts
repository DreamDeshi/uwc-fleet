/**
 * BREAK-GLASS: restore admin access when ALL admin accounts are lost.
 *
 * This is the last-resort recovery valve for the single-admin SPOF. It is NOT
 * an app endpoint and NOT a backdoor: it only runs where someone already holds
 * the database connection string (DATABASE_URL / Railway env), which IS the
 * security boundary. It either promotes an existing account to admin+active or
 * creates a fresh admin, then you log in and (ideally) rotate.
 *
 * Prefer the in-app promotion instead when any admin still works: an existing
 * admin calling PATCH /users/:id/role removes the SPOF without DB access. Reach
 * for THIS only when no admin can log in at all.
 *
 * INPUT (env only — secrets never on the command line):
 *   ALLOW_BREAK_GLASS   =1 required — the single deliberate opt-in for this
 *                       admin-granting action (covers local AND prod targets)
 *   BREAK_GLASS_PHONE   login phone to grant admin (normalised to +60…)
 *   BREAK_GLASS_PASSWORD new password for that account (strength-checked)
 *   BREAK_GLASS_NAME    display name, only used when CREATING (default below)
 *
 * Audit-logged; the password is read from env and never printed.
 *
 * Example (PowerShell):
 *   $env:ALLOW_BREAK_GLASS = "1"
 *   $env:BREAK_GLASS_PHONE = "+60123456789"
 *   $env:BREAK_GLASS_PASSWORD = "…"
 *   npx tsx prisma/break-glass-admin.ts
 */
import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma";
import { loadApiEnv, resolveTarget, assertStrongPassword, fail, BCRYPT_COST } from "./adminCredsCommon";
import { normalizePhone, isNormalizedPhone } from "../src/lib/phone";

const SCRIPT = "break-glass-admin";
const DEFAULT_NAME = "Break-glass Admin";

async function main() {
  loadApiEnv();

  if (process.env.ALLOW_BREAK_GLASS !== "1") {
    fail(
      SCRIPT,
      "refusing to run without the explicit opt-in ALLOW_BREAK_GLASS=1. This grants ADMIN access — use it only to recover a locked-out system."
    );
  }
  // ALLOW_BREAK_GLASS is the single deliberate gate; it covers a prod target too.
  resolveTarget(SCRIPT, "ALLOW_BREAK_GLASS");

  const rawPhone = process.env.BREAK_GLASS_PHONE;
  const password = process.env.BREAK_GLASS_PASSWORD;
  const name = process.env.BREAK_GLASS_NAME || DEFAULT_NAME;
  if (!rawPhone) fail(SCRIPT, "set BREAK_GLASS_PHONE to the login phone that should become admin.");
  if (!password) fail(SCRIPT, "set BREAK_GLASS_PASSWORD (env only) to the new admin password.");
  assertStrongPassword(password, "BREAK_GLASS_PASSWORD", SCRIPT);

  const phone = normalizePhone(rawPhone);
  if (!isNormalizedPhone(phone)) {
    fail(SCRIPT, `BREAK_GLASS_PHONE "${rawPhone}" is not a valid Malaysian phone number.`);
  }

  const password_hash = await bcrypt.hash(password, BCRYPT_COST);
  const existing = await prisma.user.findUnique({ where: { phone } });

  let userId: string;
  let action: string;
  if (existing) {
    const updated = await prisma.user.update({
      where: { phone },
      // Promote + guarantee login: admin role, active status, known password,
      // and revoke any stale session on the account.
      data: { role: "admin", status: "active", password_hash, refresh_token_hash: null },
    });
    userId = updated.id;
    action = `break_glass.promote:${existing.role}->admin`;
    console.log(
      `\n✔ Promoted existing account ${phone} (was ${existing.role}/${existing.status}) → admin/active; password reset.`
    );
  } else {
    const created = await prisma.user.create({
      data: { phone, password_hash, name, role: "admin", status: "active" },
    });
    userId = created.id;
    action = "break_glass.create_admin";
    console.log(`\n✔ Created new admin account ${phone} ("${name}").`);
  }

  await prisma.auditLog.create({
    data: { user_id: userId, action, table_name: "User", record_id: userId },
  });
  console.log("   Password was read from the environment and is NOT printed. Log in, then rotate if appropriate.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
