-- Interplant pay, part 1: the pickup point, and the nine UWC plants.
--
-- AUTHORITY — Mr. Teh, CLIENT_ANSWERS 29 Jul 2026:
--   A4  "Interplant no need deduction, but please ensure they need to fulfill
--        round trip only can consider complete 1 trip, get 1 point. Please
--        ensure Interplant can only select pickup point and delivery point from
--        UWC Plant 1 to UWC Plant 9."
--   A1  "P1 to P9 is not the zone area, is the consignee name, u just name it
--        UWC Plant 1, UWC Plant 2, etc … I don't have all the address, but all
--        postal code are same 14110, this is P1 address = … You can use it all
--        to same P1 to P9 temporary, but can set admin to amend the address?
--        Batu Kawan consider as P2 zone area, same with Juru and Prai"
--
-- ADDITIVE ONLY: one nullable column + its FK, and nine consignee rows. No drop,
-- no column retyped, no existing row modified. A customer/supplier trip leaves
-- pickup_consignee_id NULL and behaves exactly as before.
--
-- ⚠ HAND-WRITTEN. `prisma migrate diff` in this repo keeps emitting a phantom
--     ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT
--       "ExceptionEvidence_action_same_exception_fkey";
-- because that composite FK is raw SQL and invisible to Prisma. Not below.
--
-- LOCKING: ADD COLUMN with no default and no NOT NULL is catalog-only on
-- PG >= 11 — no table rewrite. The nine INSERTs are trivial. (The destructive-SQL
-- guard does not check locking; noted because AGENTS.md lists it as uncovered.)

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN "pickup_consignee_id" TEXT;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_pickup_consignee_id_fkey"
  FOREIGN KEY ("pickup_consignee_id") REFERENCES "Consignee"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex — interplant bookings filter by pickup point.
CREATE INDEX "Trip_pickup_consignee_id_idx" ON "Trip"("pickup_consignee_id");

-- ── The nine UWC plants ─────────────────────────────────────────────────────
--
-- Seeded HERE rather than in seed.ts because seed.ts skips the consignee import
-- entirely once any consignee exists (prod has 1564), and refuses to run against
-- a production DATABASE_URL at all. These rows must exist on prod for an
-- interplant booking to be possible.
--
-- All nine carry P1's address as a TEMPORARY placeholder, exactly as A1
-- instructs, and zone P2 (Batu Kawan). `created_by` is left NULL so they read as
-- seed data, not as a requestor self-add — the same discriminator
-- seed-demo-trips.ts uses.
--
-- ⚠ A1 ALSO ASKED FOR SOMETHING NOT BUILT HERE: "can set admin to amend the
-- address?" Treat as a request, not a question — tracked separately. Until then
-- eight of these nine addresses are knowingly wrong, which is why they are
-- placeholders and not invented data.
--
-- IDEMPOTENT: Consignee has no unique key on company_name, so each insert is
-- guarded by NOT EXISTS. Re-running changes nothing, and a re-seeded database
-- that already created them is untouched.
INSERT INTO "Consignee" ("id", "company_name", "address_1", "area", "state", "postal_code", "zone_code", "is_active")
SELECT
  'uwc-plant-' || n::text,
  'UWC Plant ' || n::text,
  'PMT 744-745, Jalan Cassia Selatan 5/1, Lebuhraya Bandar Cassia, Taman Perindustrian Batu Kawan',
  'Batu Kawan',
  'Pulau Pinang',
  '14110',
  'P2',
  true
FROM generate_series(1, 9) AS n
WHERE NOT EXISTS (
  SELECT 1 FROM "Consignee" c WHERE c."company_name" = 'UWC Plant ' || n::text
);
