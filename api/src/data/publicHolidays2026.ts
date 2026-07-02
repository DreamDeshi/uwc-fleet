/**
 * Corrected 2026 Malaysia federal/national public holidays — the initial
 * dataset for the admin-managed PublicHoliday calendar (seeded by seed.ts;
 * the calendar migration inserts the same rows into production).
 *
 * This replaces the old hardcoded MY_PUBLIC_HOLIDAYS_2026 in the incentive
 * engine, which carried WRONG dates (2025's calendar relabeled as 2026).
 * The engine no longer holds any baked-in list — holidays are passed in.
 *
 * // verify Islamic dates vs official JPA/JAKIM gazette — moon-sighting
 * // estimates (Aidilfitri, Aidiladha, Awal Muharram, Maulidur Rasul) must be
 * // human-checked before the UWC trial run.
 */
export const PUBLIC_HOLIDAYS_2026: { date: string; name: string }[] = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-02-01", name: "Thaipusam" }, // observance varies; Penang observes
  { date: "2026-02-17", name: "Chinese New Year" },
  { date: "2026-02-18", name: "Chinese New Year (2nd day)" },
  { date: "2026-03-20", name: "Hari Raya Aidilfitri (PM-declared)" },
  { date: "2026-03-21", name: "Hari Raya Aidilfitri" },
  { date: "2026-03-22", name: "Hari Raya Aidilfitri (2nd day)" },
  { date: "2026-03-23", name: "Hari Raya Aidilfitri (replacement)" },
  { date: "2026-05-01", name: "Labour Day" },
  { date: "2026-05-27", name: "Hari Raya Aidiladha" },
  { date: "2026-05-31", name: "Wesak Day" },
  { date: "2026-06-01", name: "Agong's Birthday" },
  { date: "2026-06-16", name: "Awal Muharram" },
  { date: "2026-08-25", name: "Maulidur Rasul" },
  { date: "2026-08-31", name: "Merdeka Day" },
  { date: "2026-09-16", name: "Malaysia Day" },
  { date: "2026-11-08", name: "Deepavali" },
  { date: "2026-11-09", name: "Deepavali (replacement)" },
  { date: "2026-12-25", name: "Christmas Day" },
];
