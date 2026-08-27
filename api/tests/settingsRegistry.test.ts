import { describe, it, expect } from "vitest";
import { SETTINGS_REGISTRY, getSettingDef, zodSchemaFor } from "../src/lib/settingsRegistry";

/**
 * Pure parts only — validation and the registry shape. DB-backed resolution
 * (getEffectiveSetting/updateSetting/resetSetting, the DB→env→default order,
 * and the audit trail) is covered in tests-integration/settings.test.ts
 * against a real Postgres, per AGENTS.md's rule that a fixture must actually
 * discriminate behaviour rather than assert against a mock.
 */

describe("settingsRegistry — the booking cut-off entries", () => {
  it("both cut-off settings are registered with the same defaults bookingCutoff.ts exports", () => {
    const morning = getSettingDef("booking.morning_cutoff_min");
    const afternoon = getSettingDef("booking.afternoon_cutoff_min");
    expect(morning?.default).toBe(8 * 60 + 30);
    expect(afternoon?.default).toBe(15 * 60);
    expect(morning?.type).toBe("minutes");
    expect(afternoon?.type).toBe("minutes");
  });

  it("an unknown key has no def", () => {
    expect(getSettingDef("not.a.real.key")).toBeUndefined();
  });
});

describe("zodSchemaFor — bounds are enforced per setting type", () => {
  const minutesDef = SETTINGS_REGISTRY.find((d) => d.key === "booking.afternoon_cutoff_min")!;

  it("accepts an in-range integer", () => {
    expect(zodSchemaFor(minutesDef).safeParse(16 * 60).success).toBe(true);
  });

  it("rejects a value above 23:59 (1439 minutes)", () => {
    expect(zodSchemaFor(minutesDef).safeParse(1440).success).toBe(false);
  });

  it("rejects a negative value", () => {
    expect(zodSchemaFor(minutesDef).safeParse(-1).success).toBe(false);
  });

  it("rejects a non-integer", () => {
    expect(zodSchemaFor(minutesDef).safeParse(510.5).success).toBe(false);
  });

  it("rejects a string where a number is required, at RUNTIME", () => {
    // zodSchemaFor returns ZodTypeAny, whose static input type is `any` — a
    // string is not a TYPE error here (nothing for `tsc` to catch), only a
    // VALIDATION one. This is exactly why the route validates the request
    // body through this schema rather than trusting the caller's TypeScript.
    expect(zodSchemaFor(minutesDef).safeParse("510").success).toBe(false);
  });
});
