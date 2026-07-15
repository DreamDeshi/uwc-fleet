/**
 * Rotate seeded-account passwords (bcrypt) directly against the database.
 *
 * WHY: the bootstrap admin + 6 drivers + test requestor all ship on the same
 * seeded password, which was published in the READMEs. This is the sanctioned,
 * auditable way to replace them with strong per-account secrets. It is safe to
 * re-seed afterwards — seed.ts/seed-test.ts upsert with `update: {}`, so a
 * rotated password is never overwritten (only a brand-new account gets the seed
 * default). This script changes nothing else.
 *
 * SESSIONS: changing a password does NOT by itself end any session (tokens are
 * validated by signature + stored refresh-hash + a per-request status check —
 * none involve the password). So current sessions keep working and the new
 * password is only needed at the next fresh login. `ROTATE_INVALIDATE` controls
 * whether we ALSO null refresh_token_hash to force re-login:
 *   admins (default) — only admin accounts are kicked (highest-value target;
 *                      the published password may already be in use)
 *   all              — every rotated account kicked
 *   none             — no session touched (zero disruption)
 *
 * INPUT (env only — never argv, so secrets never hit the process list):
 *   ROTATE_PASSWORDS   JSON object { "<phone>": "<newPassword>", ... }
 *   ROTATE_INVALIDATE  none | admins | all      (default: admins)
 *   ALLOW_PROD_ROTATE  =1 required ONLY when DATABASE_URL is the prod host
 *
 * All-or-nothing: every password is strength-checked and every phone resolved
 * BEFORE any write, and the writes + audit rows run in one transaction. New
 * passwords are never printed.
 *
 * Example (PowerShell):
 *   $env:ROTATE_PASSWORDS = '{"+60100000001":"…","+60100000101":"…"}'
 *   npx tsx prisma/rotate-passwords.ts
 */
import bcrypt from "bcrypt";
import { prisma } from "../src/lib/prisma";
import {
  loadApiEnv,
  resolveTarget,
  assertStrongPassword,
  fail,
  BCRYPT_COST,
} from "./adminCredsCommon";

const SCRIPT = "rotate-passwords";
type Invalidate = "none" | "admins" | "all";

async function main() {
  loadApiEnv();
  resolveTarget(SCRIPT, "ALLOW_PROD_ROTATE");

  const raw = process.env.ROTATE_PASSWORDS;
  if (!raw) {
    fail(
      SCRIPT,
      'set ROTATE_PASSWORDS to a JSON object {"<phone>":"<newPassword>", ...} (env only — never on the command line).'
    );
  }
  let map: Record<string, string>;
  try {
    map = JSON.parse(raw);
  } catch {
    fail(SCRIPT, "ROTATE_PASSWORDS is not valid JSON.");
  }
  const phones = Object.keys(map);
  if (phones.length === 0) fail(SCRIPT, "ROTATE_PASSWORDS is empty — nothing to rotate.");

  const invalidate = (process.env.ROTATE_INVALIDATE ?? "admins") as Invalidate;
  if (!["none", "admins", "all"].includes(invalidate)) {
    fail(SCRIPT, `ROTATE_INVALIDATE must be none|admins|all (got "${invalidate}").`);
  }

  // ── Validate EVERYTHING before any write (fail-closed) ───────────────────
  for (const phone of phones) assertStrongPassword(map[phone], phone, SCRIPT);

  const users = await prisma.user.findMany({
    where: { phone: { in: phones } },
    select: { id: true, phone: true, role: true },
  });
  const found = new Set(users.map((u) => u.phone));
  const missing = phones.filter((p) => !found.has(p));
  if (missing.length) {
    fail(
      SCRIPT,
      `these phone(s) are not in the target database (typo, or wrong target?): ${missing.join(", ")}. No changes made.`
    );
  }

  // ── Hash off the transaction, then apply atomically ──────────────────────
  const updates = await Promise.all(
    users.map(async (u) => ({
      u,
      password_hash: await bcrypt.hash(map[u.phone], BCRYPT_COST),
      killSession: invalidate === "all" || (invalidate === "admins" && u.role === "admin"),
    }))
  );

  await prisma.$transaction(
    updates.flatMap(({ u, password_hash, killSession }) => [
      prisma.user.update({
        where: { id: u.id },
        data: { password_hash, ...(killSession ? { refresh_token_hash: null } : {}) },
      }),
      prisma.auditLog.create({
        data: {
          user_id: u.id, // CLI has no logged-in actor; attribute to the affected account
          action: killSession ? "user.password_rotated+sessions_revoked" : "user.password_rotated",
          table_name: "User",
          record_id: u.id,
        },
      }),
    ])
  );

  console.log(`\n✔ Rotated ${updates.length} account(s)  (ROTATE_INVALIDATE=${invalidate}):`);
  for (const { u, killSession } of updates) {
    console.log(`   - ${u.phone}  (${u.role})   sessions ${killSession ? "REVOKED" : "kept"}`);
  }
  console.log("   New passwords were read from the environment and are NOT printed.\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
