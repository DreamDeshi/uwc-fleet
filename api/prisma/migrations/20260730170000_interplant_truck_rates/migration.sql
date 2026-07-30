-- Interplant pay, part 2: the per-lorry INTERPLANT rates.
--
-- WHY THIS EXISTS. The 28 Jul covering email, point 5: "Latest entitle claim for
-- interplant only is also define in NEW TABLE". That table is real and is on the
-- client-authored `INTERNAL LORRY RATE` sheet (AGENTS.md authority tier 2),
-- rows 25-31 of the 28 Jul workbook — a block absent from the pre-revision sheet:
--
--   25  INTER PLANT                             ZONE  P2
--   26  Lorry / Type (Weekday 8am - 6pm)        Entitled Claim  BATU KAWAN  REMARK
--   27  PLX 2406 (10t-30ft)   4X4 pallet x 16   6               1           ROUND TRIP, SEND AND RETRUN WITH CARGO ONLY CAN CONSIDER 1 TRIP COUNT
--   28  PPE 2406 (10t-30ft)   4X4 pallet x 8    5               1
--   29  Lorry / Type (PH / Sat-Sun / after 6pm) Entitled Claim  BATU KAWAN
--   30  PLX 2406 (10t-30ft)   4X4 pallet x 16   8               1
--   31  PPE 2406 (10t-30ft)   4X4 pallet x 8    7               1
--
-- The first cut of interplant pay used each lorry's CUSTOMER rates instead,
-- because the email line was read and not followed to the sheet it names. PLX
-- 2406 would have been paid RM11 a round trip against a published RM6 — +83%,
-- roughly RM660 a month for that driver. PPE 2406 was correct only by accident:
-- it has no customer row, so its Truck record already held interplant numbers.
--
-- A SECOND PAIR, not a replacement. Workbook point 6: "All lorry still can swap
-- between interplant and customer / supplier delivery" — so a lorry needs both,
-- and the pay follows the JOB, not the vehicle.
--
-- Note the interplant block has NO Daily Deduction column, independently
-- corroborating A4's "Interplant no need deduction".
--
-- ADDITIVE ONLY: two nullable columns, then an UPDATE that touches exactly the
-- two lorries the workbook names. No drop, no retype, no existing value changed.
--
-- ⚠ HAND-WRITTEN. `prisma migrate diff` here keeps emitting a phantom
--     ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT
--       "ExceptionEvidence_action_same_exception_fkey";
-- because that composite FK is raw SQL and invisible to Prisma. Not below.
--
-- LOCKING: two ADD COLUMNs with no default and no NOT NULL are catalog-only on
-- PG >= 11 — no rewrite. The UPDATE touches two rows.

-- AlterTable
ALTER TABLE "Truck" ADD COLUMN "interplant_claim_weekday" DECIMAL(10,2);
ALTER TABLE "Truck" ADD COLUMN "interplant_claim_offpeak" DECIMAL(10,2);

-- DESTRUCTIVE-OK: sets the two published interplant rates onto the two lorries
-- the workbook names. It writes only these columns, which were NULL a moment ago
-- on every row, so no existing value can be overwritten; the WHERE keys on the
-- exact plates and matches zero rows on a fleet that lacks them. Every other
-- lorry stays NULL, which is the honest answer — the client has published no
-- interplant rate for them.
UPDATE "Truck"
   SET "interplant_claim_weekday" = 6, "interplant_claim_offpeak" = 8
 WHERE "plate" = 'PLX 2406';

-- DESTRUCTIVE-OK: same, for the second interplant lorry. PPE 2406's published
-- interplant rates (RM5 / RM7) happen to equal the customer rates already on its
-- row, so this changes no amount today — it is written explicitly so the two
-- meanings stop being one field by coincidence.
UPDATE "Truck"
   SET "interplant_claim_weekday" = 5, "interplant_claim_offpeak" = 7
 WHERE "plate" = 'PPE 2406';
