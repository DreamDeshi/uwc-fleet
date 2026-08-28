import { z } from "zod";
import { prisma } from "./prisma";
import { MORNING_CUTOFF_MIN, AFTERNOON_CUTOFF_MIN, SESSION_SPLIT_MIN } from "./bookingCutoff";
import {
  DEFAULT_WINDOW_START,
  DEFAULT_WINDOW_END,
  OP_LOAD_MIN,
  OP_UNLOAD_MIN_PER_STOP,
  OP_DRIVE_MIN_PER_LEG,
  OP_DRIVE_POINTS_BASELINE,
} from "../services/operatingWindow";
import { ASSIGNMENT_CONFLICT_BUFFER_MIN } from "../services/schedulingConflict";
import { EXCEPTION_ALERT_THRESHOLD_MINUTES } from "../services/exceptionAlerts";
import { PENDING_ALERT_THRESHOLD_MINUTES, PENDING_RETRY_CEILING_MINUTES } from "../services/pendingTripAlerts";
import { DOC_EXPIRY_REMIND_DAYS_DEFAULT } from "../services/docExpiryReminders";
import { LOCKOUT_DEFAULT_MAX_ATTEMPTS, LOCKOUT_DEFAULT_MINUTES } from "./loginLockout";
import { POD_URL_TTL_SECONDS } from "./podPhotos";

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
  /**
   * Phase 2 — the morning/afternoon boundary itself. An INVENTED constant
   * (bookingCutoff.ts: Mr. Teh gave two sessions and two cut-offs but never
   * named where morning ends), already env-tunable server-side via
   * BOOKING_SESSION_SPLIT_MIN. This registry entry sits ABOVE that env var in
   * the resolution order, same as every other setting here — an admin's
   * change beats the env default, the env default beats the literal.
   */
  {
    key: "booking.session_split_min",
    category: "Booking cut-offs",
    label: "Morning/afternoon split",
    description:
      "The time of day (MYT) that divides a morning pickup from an afternoon one. Decides which cut-off applies to a given pickup time.",
    type: "minutes",
    min: 0,
    max: 1439,
    envVar: "BOOKING_SESSION_SPLIT_MIN",
    default: SESSION_SPLIT_MIN,
  },
  /**
   * Phase 2 — the fleet's default operating window (services/operatingWindow.ts).
   * ⚠ REACH IS NARROW BY DESIGN, not by oversight: every real Truck row carries
   * its OWN operating_hours_start/end (schema default "07:00"/"02:00", NOT
   * NULL — see Truck in schema.prisma), already admin-editable per truck on the
   * Trucks screen, and that per-truck value always wins over this one. This
   * setting is consulted only where a truck lookup can come back empty at the
   * moment of estimating — dispatchEngine.ts's auto-dispatch selection, when a
   * candidate plate no longer matches a loaded truck — and, being pure, the
   * estimator's own compiled-in DEFAULT_WINDOW_START/END still answers for any
   * caller (e.g. a direct unit test) that never resolves this setting at all.
   * NOT the B6 ruling: this does not change what the value IS (07:00/02:00,
   * unchanged), only makes that already-literal default admin-editable.
   */
  {
    key: "dispatch.window_start",
    category: "Dispatch window",
    label: "Operating window start (default)",
    description:
      "Fallback pickup-window start (MYT) used only when a truck has no operating hours of its own. Every truck today has its own hours, set on the Trucks screen, and those always take priority over this.",
    type: "time",
    default: DEFAULT_WINDOW_START,
  },
  {
    key: "dispatch.window_end",
    category: "Dispatch window",
    label: "Operating window end (default)",
    description:
      "Fallback pickup-window end (MYT) used only when a truck has no operating hours of its own. Every truck today has its own hours, set on the Trucks screen, and those always take priority over this.",
    type: "time",
    default: DEFAULT_WINDOW_END,
  },
  /**
   * Phase 3 — the operating-window ESTIMATE's own tuning knobs
   * (services/operatingWindow.ts). Unlike dispatch.window_start/end above,
   * these are consulted on EVERY assignment (manual approve in trips.ts and
   * auto-dispatch in dispatchEngine.ts) — no narrow-reach caveat needed.
   * Already env-tunable "invented constants" (OPEN_ITEMS N11); an admin
   * setting sits above the env var in the resolution order, same as every
   * other entry here.
   */
  {
    key: "dispatch.op_load_min",
    category: "Dispatch estimate",
    label: "Load time",
    description: "Minutes assumed to load at the plant before departure, used to estimate when a run finishes.",
    type: "minutes",
    min: 0,
    max: 1439,
    envVar: "OP_LOAD_MIN",
    default: OP_LOAD_MIN,
  },
  {
    key: "dispatch.op_unload_min_per_stop",
    category: "Dispatch estimate",
    label: "Unload time per stop",
    description: "Minutes assumed to unload at EACH delivery stop, used to estimate when a run finishes.",
    type: "minutes",
    min: 0,
    max: 1439,
    envVar: "OP_UNLOAD_MIN_PER_STOP",
    default: OP_UNLOAD_MIN_PER_STOP,
  },
  {
    key: "dispatch.op_drive_min_per_leg",
    category: "Dispatch estimate",
    label: "Drive time per leg (baseline)",
    description:
      "Minutes assumed to drive one leg at the baseline zone points below. A leg to a farther zone scales up from this; a nearer one scales down.",
    type: "minutes",
    min: 0,
    max: 1439,
    envVar: "OP_DRIVE_MIN_PER_LEG",
    default: OP_DRIVE_MIN_PER_LEG,
  },
  {
    key: "dispatch.op_drive_points_baseline",
    category: "Dispatch estimate",
    label: "Drive time baseline (zone points)",
    description:
      "The zone-points value that corresponds to exactly one baseline leg of driving. Must stay above zero — the estimate divides by it.",
    type: "integer",
    min: 1,
    max: 50,
    envVar: "OP_DRIVE_POINTS_BASELINE",
    default: OP_DRIVE_POINTS_BASELINE,
  },
  /**
   * Phase 3 — the scheduling-conflict buffer (services/schedulingConflict.ts).
   * Consulted on every manual approve (trips.ts) and every auto-dispatch
   * candidate filter (dispatchEngine.ts) — always reachable, no caveat.
   */
  {
    key: "dispatch.assignment_conflict_buffer_min",
    category: "Dispatch estimate",
    label: "Scheduling-conflict buffer",
    description:
      "Minutes either side of a pickup within which the SAME driver or truck already committed elsewhere counts as a scheduling conflict.",
    type: "minutes",
    min: 0,
    max: 1439,
    envVar: "ASSIGNMENT_CONFLICT_BUFFER_MIN",
    default: ASSIGNMENT_CONFLICT_BUFFER_MIN,
  },
  /**
   * Phase 4 — alert thresholds. Each one already env-tunable; an admin
   * setting sits above the env var, same resolution order as every entry
   * above. See lib/alertThresholdSettings.ts for the resolvers, and
   * services/pendingTripAlerts.ts for why the retry-ceiling note text had to
   * change shape to stay correct once its own minutes became admin-editable.
   */
  {
    key: "alert.exception_threshold_min",
    category: "Alert thresholds",
    label: "Open-exception alert",
    description:
      "How long a driver-reported exception may stay open before admins are pinged. The trip is paused the whole time regardless of this setting.",
    type: "minutes",
    min: 1,
    max: 1439,
    envVar: "EXCEPTION_ALERT_THRESHOLD_MINUTES",
    default: EXCEPTION_ALERT_THRESHOLD_MINUTES,
  },
  {
    key: "alert.pending_trip_threshold_min",
    category: "Alert thresholds",
    label: "Pending-booking alert",
    description: "How long a booking may sit unassigned before admins are pinged (auto-dispatch keeps retrying either way).",
    type: "minutes",
    min: 1,
    max: 1439,
    envVar: "PENDING_ALERT_THRESHOLD_MINUTES",
    default: PENDING_ALERT_THRESHOLD_MINUTES,
  },
  {
    key: "alert.pending_retry_ceiling_min",
    category: "Alert thresholds",
    label: "Pending-booking retry ceiling",
    description:
      "The generous backstop past which the engine gives up retrying a stuck booking and escalates it to manual handling instead.",
    type: "minutes",
    min: 1,
    max: 10080, // a week — a backstop, not a same-day cut-off
    envVar: "PENDING_RETRY_CEILING_MINUTES",
    default: PENDING_RETRY_CEILING_MINUTES,
  },
  {
    key: "alert.doc_expiry_remind_days",
    category: "Alert thresholds",
    label: "Document-expiry reminder window",
    description:
      "Admins get a daily push while any truck's insurance, permit or road tax is due within this many days (or already expired).",
    type: "integer",
    min: 1,
    max: 365,
    envVar: "DOC_EXPIRY_REMIND_DAYS",
    default: DOC_EXPIRY_REMIND_DAYS_DEFAULT,
  },
  /**
   * Phase 5 — security settings.
   *
   * The two login-lockout entries are DISPLAY/AUDIT/EDIT surfaces only — the
   * actual runtime resolution is lib/securitySettings.ts's
   * effectiveLockoutConfig(), which deliberately does NOT read through this
   * registry's generic env-var mechanism for these two keys (see that file's
   * own comment: loginLockout.ts already has a shared, security-reviewed env
   * parser, and duplicating it here risks exactly the drift envLimit.ts was
   * written to prevent). `envVar` is still listed below so the admin UI's
   * "source" badge reports accurately when the env var is the reason a value
   * isn't the bare default — tests/securitySettings.test.ts pins that this
   * registry's own parsing and loginLockout.ts's resolveSecurityLimit still
   * agree on every boundary, so the badge can never lie about which one
   * actually governs.
   */
  {
    key: "security.login_lockout_max_attempts",
    category: "Security",
    label: "Login lockout — attempts",
    description:
      "Failed sign-in attempts allowed before an account locks. 0 disables the lockout entirely.",
    type: "integer",
    min: 0,
    max: 100,
    envVar: "LOGIN_LOCKOUT_MAX_ATTEMPTS",
    default: LOCKOUT_DEFAULT_MAX_ATTEMPTS,
  },
  {
    key: "security.login_lockout_minutes",
    category: "Security",
    label: "Login lockout — duration",
    description: "How long a triggered account lock lasts before it expires on its own.",
    type: "minutes",
    // min 0 (not 1) deliberately: loginLockout.ts's own resolveSecurityLimit
    // accepts 0 for this knob too (see securitySettings.test.ts). A 0-minute
    // lock is degenerate but not harmful — it expires immediately — and the
    // bound here must match what actually governs, or the admin UI's "source"
    // badge could disagree with reality for an env var set to 0.
    min: 0,
    max: 1440,
    envVar: "LOGIN_LOCKOUT_MINUTES",
    default: LOCKOUT_DEFAULT_MINUTES,
  },
  /**
   * ⚠ REGISTERED FOR VISIBILITY ONLY — NOT WIRED LIVE. An admin can see and
   * edit this, but the signing code (lib/podPhotos.ts) still reads only the
   * env var. Two reasons, both explained fully in podPhotos.ts's own comment:
   * (1) it has zero effect unless CLOUDINARY_POD_TOKEN_KEY (a paid Cloudinary
   * add-on) is ALSO configured, which it is not in this project; (2) wiring
   * it live would mean an async DB read on every trip response, since the
   * signing pipeline is a synchronous hot path inside JSON serialization, not
   * a per-request settings-resolution point like every other phase's.
   * Owner decision, 28 Aug 2026: register only, don't pay that cost for a
   * setting that currently does nothing either way.
   */
  {
    key: "security.pod_url_ttl_seconds",
    category: "Security",
    label: "POD signed-URL lifetime (seconds) — NOT YET LIVE",
    description:
      "How long a signed POD/K2 delivery URL would stay valid, IF Cloudinary's token-based auth add-on were configured. Not consulted by the app today — editing this has no effect until that add-on is set up and the code is wired to read it.",
    type: "integer",
    min: 60,
    max: 86400,
    envVar: "CLOUDINARY_POD_URL_TTL_SECONDS",
    default: POD_URL_TTL_SECONDS,
  },
  /**
   * Phase 6 — rate limits (middleware/rateLimit.ts). Like the Phase 5 lockout
   * settings, resolution is delegated (lib/rateLimitSettings.ts) rather than
   * routed through this registry's generic env-var mechanism, for the same
   * reason: `resolveSecurityLimit` is a shared, security-reviewed parser and
   * a second copy risks drift. Unlike every other phase, THIS setting is also
   * CACHED (short TTL) rather than read fresh per call — see that file's own
   * header for why: express-rate-limit invokes its threshold callback on
   * every request across the whole API.
   *
   * `default` below is a LITERAL, not an import of
   * middleware/rateLimit.ts's own GLOBAL_RATE_LIMIT_DEFAULT /
   * SENSITIVE_RATE_LIMIT_DEFAULT constants — importing them here would create
   * a cycle (rateLimit.ts → rateLimitSettings.ts → settingsRegistry.ts →
   * rateLimit.ts). tests/rateLimitSettings.test.ts pins the two stay equal.
   */
  {
    key: "rate_limit.global_max",
    category: "Rate limits",
    label: "Global rate limit (requests/min)",
    description:
      "Requests per minute allowed per person (per IP when unauthenticated) across the whole API. 0 means unlimited.",
    type: "integer",
    min: 0,
    max: 100000,
    envVar: "RATE_LIMIT_MAX",
    default: 300,
  },
  {
    key: "rate_limit.sensitive_max",
    category: "Rate limits",
    label: "Account-security rate limit (requests/min)",
    description:
      "Requests per minute allowed per IP on login, password change and password reset. 0 means unlimited — do not set this to 0 in production.",
    type: "integer",
    min: 0,
    max: 100000,
    envVar: "SENSITIVE_RATE_LIMIT_MAX",
    default: 10,
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
