-- Remove the Johor (JH) and Selangor (SL) placeholder zones.
--
-- JH/SL were never authoritative spec: they appear in the REQUESTOR INTERFACE
-- destination dropdown but carry NO points in the INTERNAL LORRY RATE sheet.
-- They were seeded as 8-point placeholders (matching KL) so speculative
-- bookings would score during testing. Mr. Teh confirmed on 16 Jul 2026 they
-- won't be used ("is ok you can ignore it, we wont arrange to Johor and
-- Selangor using this apps"), so the code that seeds them is removed and this
-- migration clears any rows an earlier seed already wrote to prod.
--
-- Defensive, like 20260702200000_dedupe_destination_rates: a database that
-- never had JH/SL (a clean install off the current seed) is untouched — both
-- DELETEs simply match zero rows.
--
-- ORDER MATTERS: DestinationRate first, then Zone. DestinationRate.zone_code is
-- a FK to Zone.code, so the Zone rows can't drop while their rate rows exist.
-- ZoneAdjacency has no JH/SL rows (they are out-of-matrix, like KL — seed.ts),
-- so nothing else references them.
--
-- NOT force-guarded against real data: if a Consignee somehow sits in JH or SL,
-- its FK to Zone.code makes the Zone DELETE below fail loudly (foreign-key
-- violation) rather than silently orphaning or skipping it. That is intended —
-- a real JH/SL consignee is a surprise we want the deploy to surface, not hide.

DELETE FROM "DestinationRate" WHERE "zone_code" IN ('JH', 'SL');

DELETE FROM "Zone" WHERE "code" IN ('JH', 'SL');
