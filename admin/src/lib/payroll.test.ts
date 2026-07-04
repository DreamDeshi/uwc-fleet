import { describe, expect, it } from "vitest";
import { buildPayrollCsv, lastNMytMonthKeys, monthKeyLabel } from "./payroll";
import { formatMoney } from "./format";
import type { PayrollDriverRow } from "@/types";

describe("month selector keys (MYT)", () => {
  it("lists current month first and crosses the year boundary", () => {
    // 2026-01-01 03:00 MYT (2025-12-31 19:00 UTC) — key must be Jan 2026 in MYT.
    const keys = lastNMytMonthKeys(new Date("2025-12-31T19:00:00Z"), 3);
    expect(keys).toEqual(["2026-01", "2025-12", "2025-11"]);
  });

  it("labels keys for humans", () => {
    expect(monthKeyLabel("2026-07")).toBe("Jul 2026");
  });
});

describe("payroll CSV ties exactly to the displayed figures", () => {
  const driver: PayrollDriverRow = {
    driver_id: "d1",
    name: "Mohd Azmi B. Che Dol",
    employee_number: "H593",
    trip_count: 2,
    total: 143.99999999999997, // float dust — display and export must both say 144.00
    trips: [
      {
        id: "t1",
        ticket_number: "TKT-20260704-001",
        pickup_datetime: "2026-07-04T00:30:00Z",
        delivered_at: "2026-07-04T10:05:00Z", // 18:05 MYT — the boundary case
        incentive_earned: 44,
      },
    ],
  };

  it("money cells equal the on-screen formatMoney value (2dp, no separators)", () => {
    const csv = buildPayrollCsv("2026-07", [driver], []);
    expect(csv).toContain("144.00");
    expect(csv).not.toContain("143.99999");
    // The displayed pill for the same value:
    expect(formatMoney(driver.total)).toBe("RM 144.00");
  });

  it("includes employee number and the MYT delivery-confirm timestamp", () => {
    const csv = buildPayrollCsv("2026-07", [driver], []);
    expect(csv).toContain("H593");
    // 10:05Z = 18:05 MYT; formatDateTime output contains a comma → quoted cell.
    expect(csv).toMatch(/"04 Jul 2026, 0?6:05\s?pm MYT"/i);
  });
});
