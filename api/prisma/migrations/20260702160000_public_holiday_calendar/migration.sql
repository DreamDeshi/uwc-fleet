-- Admin-managed public-holiday calendar. Replaces the hardcoded 2026 list in
-- incentiveEngine.ts, which carried WRONG dates (2025's calendar relabeled
-- 2026 — e.g. CNY listed 29-30 Jan; real CNY 2026 is 17-18 Feb) and would have
-- silently emptied on 1 Jan 2027.

-- CreateTable
CREATE TABLE "PublicHoliday" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublicHoliday_date_key" ON "PublicHoliday"("date");

-- Seed the corrected 2026 Malaysia federal/national set so production is not
-- empty after this migration. Islamic dates are moon-sighting estimates —
-- verify Islamic dates vs the official JPA/JAKIM gazette before the trial run.
-- Kept in sync with api/src/data/publicHolidays2026.ts (used by seed.ts).
INSERT INTO "PublicHoliday" ("id", "date", "name") VALUES
  ('ph-2026-01-01', '2026-01-01', 'New Year''s Day'),
  ('ph-2026-02-01', '2026-02-01', 'Thaipusam'),
  ('ph-2026-02-17', '2026-02-17', 'Chinese New Year'),
  ('ph-2026-02-18', '2026-02-18', 'Chinese New Year (2nd day)'),
  ('ph-2026-03-20', '2026-03-20', 'Hari Raya Aidilfitri (PM-declared)'),
  ('ph-2026-03-21', '2026-03-21', 'Hari Raya Aidilfitri'),
  ('ph-2026-03-22', '2026-03-22', 'Hari Raya Aidilfitri (2nd day)'),
  ('ph-2026-03-23', '2026-03-23', 'Hari Raya Aidilfitri (replacement)'),
  ('ph-2026-05-01', '2026-05-01', 'Labour Day'),
  ('ph-2026-05-27', '2026-05-27', 'Hari Raya Aidiladha'),
  ('ph-2026-05-31', '2026-05-31', 'Wesak Day'),
  ('ph-2026-06-01', '2026-06-01', 'Agong''s Birthday'),
  ('ph-2026-06-16', '2026-06-16', 'Awal Muharram'),
  ('ph-2026-08-25', '2026-08-25', 'Maulidur Rasul'),
  ('ph-2026-08-31', '2026-08-31', 'Merdeka Day'),
  ('ph-2026-09-16', '2026-09-16', 'Malaysia Day'),
  ('ph-2026-11-08', '2026-11-08', 'Deepavali'),
  ('ph-2026-11-09', '2026-11-09', 'Deepavali (replacement)'),
  ('ph-2026-12-25', '2026-12-25', 'Christmas Day');
