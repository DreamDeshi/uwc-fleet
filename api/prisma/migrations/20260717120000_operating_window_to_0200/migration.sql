-- Item 12 (Mr. Teh, 17 Jul 2026): "can pickup time allow set until 2AM instead
-- of 6pm". The fleet operating day now runs 07:00 -> 02:00 the NEXT calendar
-- day; operatingWindow.ts treats an end < start as a wrapping window.
--
-- Additive + reversible: no column is added, dropped or retyped. This changes
-- the DEFAULT for trucks created from here on, and migrates the EXISTING fleet
-- off the old 18:00 close.

ALTER TABLE "Truck" ALTER COLUMN "operating_hours_end" SET DEFAULT '02:00';

-- Only rows still sitting on the old fleet-wide default are moved. A truck an
-- admin has deliberately given some other window (say a 07:00-16:00 shift) is
-- left exactly as configured — this migration must not quietly overwrite an
-- operational decision it can't see the reason for.
-- DESTRUCTIVE-OK: moves the fleet off the old 18:00 close per Mr. Teh's item 12
-- (17 Jul 2026). The WHERE clause restricts it to trucks still on the previous
-- fleet-wide default, so a deliberately customised window is never overwritten.
UPDATE "Truck" SET "operating_hours_end" = '02:00' WHERE "operating_hours_end" = '18:00';
