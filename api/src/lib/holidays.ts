import { prisma } from "./prisma";

/**
 * The active public-holiday calendar as a set of MYT "YYYY-MM-DD" keys — the
 * shape isOffPeak() consumes. Loaded fresh per use (the table is ~20 rows/yr);
 * the incentive engine itself stays pure and never touches the DB.
 */
export async function loadHolidaySet(): Promise<Set<string>> {
  const rows = await prisma.publicHoliday.findMany({ select: { date: true } });
  return new Set(rows.map((r) => r.date));
}
