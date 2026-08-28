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
    expect(morning?.default).toBe(10 * 60);
    expect(afternoon?.default).toBe(15 * 60);
    expect(morning?.type).toBe("minutes");
    expect(afternoon?.type).toBe("minutes");
  });

  it("an unknown key has no def", () => {
    expect(getSettingDef("not.a.real.key")).toBeUndefined();
  });

  it("the session-split entry is registered with the same default bookingCutoff.ts exports", () => {
    const split = getSettingDef("booking.session_split_min");
    expect(split?.default).toBe(12 * 60);
    expect(split?.type).toBe("minutes");
    expect(split?.envVar).toBe("BOOKING_SESSION_SPLIT_MIN");
  });
});

describe("settingsRegistry — the dispatch-window entries (Phase 2)", () => {
  it("both window settings are registered with operatingWindow.ts's own defaults", () => {
    const start = getSettingDef("dispatch.window_start");
    const end = getSettingDef("dispatch.window_end");
    expect(start?.default).toBe("07:00");
    expect(end?.default).toBe("02:00");
    expect(start?.type).toBe("time");
    expect(end?.type).toBe("time");
    // Never env-tunable — an admin's Setting row or the literal default only,
    // same discipline as the two B7 cut-offs.
    expect(start?.envVar).toBeUndefined();
    expect(end?.envVar).toBeUndefined();
  });
});

describe("settingsRegistry — the dispatch-estimate entries (Phase 3)", () => {
  it("all four estimate knobs are registered with operatingWindow.ts's own defaults", () => {
    const load = getSettingDef("dispatch.op_load_min");
    const unload = getSettingDef("dispatch.op_unload_min_per_stop");
    const drive = getSettingDef("dispatch.op_drive_min_per_leg");
    const baseline = getSettingDef("dispatch.op_drive_points_baseline");
    expect(load?.default).toBe(30);
    expect(unload?.default).toBe(20);
    expect(drive?.default).toBe(45);
    expect(baseline?.default).toBe(3);
    expect(load?.type).toBe("minutes");
    expect(unload?.type).toBe("minutes");
    expect(drive?.type).toBe("minutes");
    expect(baseline?.type).toBe("integer");
    // All four were already env-tunable "invented constants" — an admin
    // setting sits above the env var, never replaces it.
    expect(load?.envVar).toBe("OP_LOAD_MIN");
    expect(unload?.envVar).toBe("OP_UNLOAD_MIN_PER_STOP");
    expect(drive?.envVar).toBe("OP_DRIVE_MIN_PER_LEG");
    expect(baseline?.envVar).toBe("OP_DRIVE_POINTS_BASELINE");
  });

  it("the drive-points baseline cannot be set to zero — the estimate divides by it", () => {
    const baseline = getSettingDef("dispatch.op_drive_points_baseline")!;
    expect(zodSchemaFor(baseline).safeParse(0).success).toBe(false);
    expect(zodSchemaFor(baseline).safeParse(1).success).toBe(true);
  });

  it("the scheduling-conflict buffer is registered with schedulingConflict.ts's own default", () => {
    const buffer = getSettingDef("dispatch.assignment_conflict_buffer_min");
    expect(buffer?.default).toBe(120);
    expect(buffer?.type).toBe("minutes");
    expect(buffer?.envVar).toBe("ASSIGNMENT_CONFLICT_BUFFER_MIN");
  });
});

describe("zodSchemaFor — a 'time' setting validates HH:MM strictly", () => {
  const timeDef = SETTINGS_REGISTRY.find((d) => d.key === "dispatch.window_start")!;

  it("accepts a well-formed 24-hour HH:MM", () => {
    expect(zodSchemaFor(timeDef).safeParse("07:00").success).toBe(true);
    expect(zodSchemaFor(timeDef).safeParse("23:59").success).toBe(true);
    expect(zodSchemaFor(timeDef).safeParse("00:00").success).toBe(true);
  });

  it("rejects a single-digit hour — the admin UI must always send two digits", () => {
    expect(zodSchemaFor(timeDef).safeParse("7:00").success).toBe(false);
  });

  it("rejects an out-of-range hour or minute", () => {
    expect(zodSchemaFor(timeDef).safeParse("24:00").success).toBe(false);
    expect(zodSchemaFor(timeDef).safeParse("07:60").success).toBe(false);
  });

  it("rejects a non-time string", () => {
    expect(zodSchemaFor(timeDef).safeParse("not a time").success).toBe(false);
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
