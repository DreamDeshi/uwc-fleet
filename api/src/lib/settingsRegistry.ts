import { z } from "zod";
import { prisma } from "./prisma";
import { MORNING_CUTOFF_MIN, AFTERNOON_CUTOFF_MIN } from "./bookingCutoff";

/**
 * The generic admin-settings registry.
 *
 * One entry per admin-editable value. Adding a new setting later means adding
 * one entry here and wiring the one call site that should consult it — never
 * a schema migration, since every value lives in the single `Setting`
 * key/value table (schema.prisma). See AGENTS.md's "admin-configurable
 * settings" note for which values are in scope and why.
 *
 * RESOLUTION ORDER, always: a `Setting` row in the DB → the named env var (if
 * the entry has one and it parses) → the hardcoded `default`. This is the
 * same DB→env→default shape `envNumbers.ts` already uses for env→default, one
 * layer up — nothing changes for anyone until an admin explicitly sets a
 * value.
 */

export type SettingType = "minutes" | "integer" | "time" | "boolean";

export interface SettingDef {
  key: string;
  category: string;
  label: string;
  description: string;
  type: SettingType;
  /** Inclusive bounds — only meaningful for "minutes"/"integer". */
  min?: number;
  max?: number;
  /** Name of an existing env var this setting may also be read from, ranked
   *  below a DB row and above the hardcoded default. Omit if the constant was
   *  never env-tunable. */
  envVar?: string;
  default: number | string | boolean;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * B7 — the booking cut-off times. The ONE setting with real client
 * authorization (Mr. Teh, WhatsApp, 27 Aug 2026: "do you want a flexible
 * system for the admin to change the time" / "yes"). `MORNING_CUTOFF_MIN` /
 * `AFTERNOON_CUTOFF_MIN` in bookingCutoff.ts stay exactly as they are — plain
 * literals, not env-tunable — this registry only supplies an OVERRIDE on top,
 * resolved at the route layer (see bookingCutoffSettings.ts). The pure
 * `bookingCutoffVerdict` function is unaware this registry exists.
 */
export const SETTINGS_REGISTRY: SettingDef[] = [
  {
    key: "booking.morning_cutoff_min",
    category: "Booking cut-offs",
    label: "Morning cut-off",
    description:
      "A booking for today's MORNING pickup must be made before this time (MYT). After it, the earliest selectable pickup is the next working day.",
    type: "minutes",
    min: 0,
    max: 1439,
    default: MORNING_CUTOFF_MIN,
  },
  {
    key: "booking.afternoon_cutoff_min",
    category: "Booking cut-offs",
    label: "Afternoon cut-off",
    description:
      "A booking for today's AFTERNOON pickup must be made before this time (MYT).",
    type: "minutes",
    min: 0,
    max: 1439,
    default: AFTERNOON_CUTOFF_MIN,
  },
];

function findDef(key: string): SettingDef | undefined {
  return SETTINGS_REGISTRY.find((d) => d.key === key);
}

/** Zod schema for one setting's VALUE, derived from its registry entry. */
export function zodSchemaFor(def: SettingDef): z.ZodTypeAny {
  switch (def.type) {
    case "minutes":
    case "integer": {
      let schema = z.number().int();
      if (def.min !== undefined) schema = schema.min(def.min);
      if (def.max !== undefined) schema = schema.max(def.max);
      return schema;
    }
    case "time":
      return z.string().regex(TIME_RE, "Must be HH:MM (24-hour).");
    case "boolean":
      return z.boolean();
  }
}

/** Parse a raw stored/env string against a def's type + bounds. `undefined` = invalid, caller should fall through. */
function parseValue(def: SettingDef, raw: string): number | string | boolean | undefined {
  switch (def.type) {
    case "minutes":
    case "integer": {
      const n = Number(raw);
      if (!Number.isInteger(n)) return undefined;
      if (def.min !== undefined && n < def.min) return undefined;
      if (def.max !== undefined && n > def.max) return undefined;
      return n;
    }
    case "time":
      return TIME_RE.test(raw) ? raw : undefined;
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return undefined;
  }
}

export type SettingSource = "db" | "env" | "default";

export interface EffectiveSetting {
  def: SettingDef;
  value: number | string | boolean;
  source: SettingSource;
}

/** The value in effect right now, and where it came from. */
export async function getEffectiveSetting(key: string): Promise<EffectiveSetting> {
  const def = findDef(key);
  if (!def) throw new Error(`Unknown setting key: ${key}`);

  const row = await prisma.setting.findUnique({ where: { key } });
  if (row) {
    const parsed = parseValue(def, row.value);
    if (parsed !== undefined) return { def, value: parsed, source: "db" };
  }
  if (def.envVar) {
    const raw = process.env[def.envVar];
    if (raw !== undefined && raw.trim() !== "") {
      const parsed = parseValue(def, raw.trim());
      if (parsed !== undefined) return { def, value: parsed, source: "env" };
    }
  }
  return { def, value: def.default, source: "default" };
}

/** Convenience for a caller that only wants the value, typed. */
export async function getSettingValue<T extends number | string | boolean>(key: string): Promise<T> {
  return (await getEffectiveSetting(key)).value as T;
}

export async function listEffectiveSettings(): Promise<EffectiveSetting[]> {
  return Promise.all(SETTINGS_REGISTRY.map((def) => getEffectiveSetting(def.key)));
}

/** Set a setting. Caller must already have validated `value` against `zodSchemaFor(def)`. */
export async function updateSetting(
  key: string,
  value: number | string | boolean
): Promise<{ def: SettingDef; oldValue: number | string | boolean; newValue: number | string | boolean }> {
  const def = findDef(key);
  if (!def) throw new Error(`Unknown setting key: ${key}`);
  const before = await getEffectiveSetting(key);
  await prisma.setting.upsert({
    where: { key },
    update: { value: String(value) },
    create: { key, value: String(value) },
  });
  return { def, oldValue: before.value, newValue: value };
}

/** Reset to the default (removes the DB row; resolution falls through to env/default). */
export async function resetSetting(
  key: string
): Promise<{ def: SettingDef; oldValue: number | string | boolean; newValue: number | string | boolean }> {
  const def = findDef(key);
  if (!def) throw new Error(`Unknown setting key: ${key}`);
  const before = await getEffectiveSetting(key);
  await prisma.setting.deleteMany({ where: { key } });
  const after = await getEffectiveSetting(key);
  return { def, oldValue: before.value, newValue: after.value };
}

export function getSettingDef(key: string): SettingDef | undefined {
  return findDef(key);
}
