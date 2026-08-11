-- Populate the interplant rate pair for the two lorries that HAVE one.
--
-- 20260811130000_interplant_rates added the columns but deliberately carried no
-- backfill, so they landed NULL on every row. Verified on production directly
-- after that deploy: all 9 trucks NULL. Code reads
--
--     truck.interplant_claim_weekday ?? INTERPLANT_FALLBACK_RATE.weekday
--
-- so until these values exist, EVERY interplant assignment resolves through the
-- fallback — PLX 2406's RM6/8, owner ruling 11 Aug 2026.
--
-- ⚠ THAT IS AN OVERPAY ON PPE 2406, AND IT IS THE MAIN CASE, NOT AN EDGE. PPE
-- 2406 is one of the two designated interplant lorries and the workbook's INTER
-- PLANT block prices it at RM5/7, not RM6/8. Every interplant point it earns
-- while these columns are null is paid RM1 too much, and an approved incentive
-- cannot be corrected afterwards (BL9 — no route rewrites incentive_final).
--
-- Values are the workbook's INTERNAL LORRY RATE sheet, INTER PLANT block (28 Jul
-- 2026 revision, rows 25-31), which is also what docs/uwc-spec.json carries and
-- what prisma/seed.ts writes on a fresh database:
--
--     PLX 2406   RM6 weekday / RM8 off-peak
--     PPE 2406   RM5 weekday / RM7 off-peak
--
-- The other seven trucks are LEFT NULL ON PURPOSE. Null is a value here: they
-- have no INTER PLANT row of their own, and a cross-assigned backup is supposed
-- to resolve through the fallback. This is a backfill of the two rows the
-- workbook prices, not a default for the fleet.
--
-- Each statement is guarded on the rate being unset, so it can never overwrite a
-- value a human or a later editor has set, and re-running it on an
-- already-populated database is a no-op. On a fresh database (CI, a new
-- environment) the table is empty at migration time and seed.ts writes the same
-- two pairs from the spec, so this changes nothing there.
--
-- The guard is EITHER column null, not BOTH, so that it agrees with the
-- assertion at the foot of this file. With a both-null guard a HALF-populated
-- row — one rate set, one null, which is not a legitimate state for a pair —
-- would be skipped by the write and then trip the assertion, failing the deploy
-- with no way to heal itself. Matching the two conditions makes the migration
-- repair that row instead. Caught by running this against a real Postgres.
--
-- ⚠ On LOCKING (the class the SQL guard cannot see): two single-row writes on a
-- 9-row table, matched on the primary key. No rewrite, no scan, no lock worth
-- the name.

-- DESTRUCTIVE-OK: writes PLX 2406's workbook INTER PLANT rate onto a money
-- column that is currently null. Nothing is overwritten — the guard below
-- restricts it to rows where the pair is still unset. Source: INTERNAL LORRY
-- RATE sheet, INTER PLANT block, row 27/30 (28 Jul 2026 revision).
UPDATE "Truck"
   SET "interplant_claim_weekday" = 6.00,
       "interplant_claim_offpeak" = 8.00
 WHERE "plate" = 'PLX 2406'
   AND ("interplant_claim_weekday" IS NULL OR "interplant_claim_offpeak" IS NULL);

-- DESTRUCTIVE-OK: same, for PPE 2406 at RM5/7. This is the row that is being
-- OVERPAID by the fallback today, so leaving it null is the destructive option.
-- Source: INTERNAL LORRY RATE sheet, INTER PLANT block (28 Jul 2026 revision).
UPDATE "Truck"
   SET "interplant_claim_weekday" = 5.00,
       "interplant_claim_offpeak" = 7.00
 WHERE "plate" = 'PPE 2406'
   AND ("interplant_claim_weekday" IS NULL OR "interplant_claim_offpeak" IS NULL);

-- Fail the deploy rather than ship a half-populated money table: if either
-- lorry EXISTS but still has no interplant pair, something did not take.
-- Empty-table safe by construction (a fresh database matches no rows here), so
-- CI and any new environment pass straight through.
DO $$
DECLARE
  still_null INT;
BEGIN
  SELECT COUNT(*) INTO still_null
    FROM "Truck"
   WHERE "plate" IN ('PLX 2406', 'PPE 2406')
     AND ("interplant_claim_weekday" IS NULL OR "interplant_claim_offpeak" IS NULL);

  IF still_null > 0 THEN
    RAISE EXCEPTION
      'interplant backfill did not take: % of the two interplant lorries still have a null rate pair. Interplant work would be paid the fallback rate.',
      still_null;
  END IF;
END $$;
