import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatTime, mytDateKey } from "./format";

// These instants are chosen so MYT (UTC+8) disagrees with UTC — and with most
// other timezones a dev/CI machine could be set to. If the formatters ever
// fall back to the machine's local zone, the date-boundary assertions break.

describe("admin time formatting is pinned to MYT", () => {
  it("formats a time in MYT with an explicit MYT label (off-peak boundary evidence)", () => {
    // 10:05Z = 18:05 MYT — the exact off-peak cutoff boundary.
    const t = formatTime("2026-07-04T10:05:00Z");
    expect(t).toMatch(/0?6:05\s?pm MYT/i);
  });

  it("rolls the calendar day at MYT midnight, not local/UTC midnight", () => {
    // 17:30Z on the 4th = 01:30 MYT on the 5th.
    expect(formatDate("2026-07-04T17:30:00Z")).toBe("05 Jul 2026");
    expect(formatTime("2026-07-04T17:30:00Z")).toMatch(/0?1:30\s?am MYT/i);
    expect(mytDateKey("2026-07-04T17:30:00Z")).toBe("2026-07-05");
  });

  it("composes date + labelled time", () => {
    const dt = formatDateTime("2026-07-04T10:05:00Z");
    expect(dt).toContain("04 Jul 2026");
    expect(dt).toContain("MYT");
  });

  it("renders em dash for empty values", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatTime(undefined)).toBe("—");
  });
});
