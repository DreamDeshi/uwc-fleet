import { describe, it, expect } from "vitest";
import {
  DEMO_DB_NAMES,
  PROD_HOST_MARKERS,
  isDemoDatabase,
  isProductionHost,
  parseTarget,
  seedGate,
} from "../prisma/seedGate";

const env = (o: Record<string, string> = {}) => o as unknown as NodeJS.ProcessEnv;
const target = (host: string, database: string | null) => ({ host, database });

// A Railway host that is NOT the demo database. This stands in for production
// in every test below: the guard never learns prod's real hostname, so what is
// being asserted is "a live Railway database", not "this specific host".
const LIVE = target("containers-us-west-1.railway.app", "railway");
const DEMO_HOST = "monorail.proxy.rlwy.net";
const DEMO = target(DEMO_HOST, "uwc_demo");

describe("parseTarget", () => {
  it("splits host and database name", () => {
    expect(parseTarget("postgresql://u:p@db.example.com:5432/uwc_demo")).toEqual({
      host: "db.example.com",
      database: "uwc_demo",
    });
  });

  it("lowercases the database name so casing cannot dodge the allowlist", () => {
    expect(parseTarget("postgresql://u:p@h/UWC_DEMO")?.database).toBe("uwc_demo");
  });

  it("returns null for a missing or unparseable URL", () => {
    expect(parseTarget(undefined)).toBeNull();
    expect(parseTarget("not-a-url")).toBeNull();
  });

  it("reports a database-less URL as null rather than empty string", () => {
    expect(parseTarget("postgresql://u:p@h:5432/")?.database).toBeNull();
  });
});

describe("host and database classification", () => {
  it("treats every Railway marker as a live host", () => {
    for (const m of PROD_HOST_MARKERS) expect(isProductionHost(`x.${m}`)).toBe(true);
  });

  it("leaves non-Railway hosts alone", () => {
    for (const h of ["localhost", "127.0.0.1", "db.example.com", "ep-x.neon.tech"]) {
      expect(isProductionHost(h)).toBe(false);
    }
  });

  it("recognises only the listed demo database names", () => {
    for (const n of DEMO_DB_NAMES) expect(isDemoDatabase(n)).toBe(true);
    for (const n of ["railway", "postgres", "uwc", null]) expect(isDemoDatabase(n)).toBe(false);
  });
});

describe("seedGate", () => {
  it("allows any non-Railway target unchanged, with no flags at all", () => {
    expect(seedGate("seed", target("localhost", "uwc"), env()).ok).toBe(true);
    expect(seedGate("seed", target("127.0.0.1", null), env()).ok).toBe(true);
  });

  // THE load-bearing assertion. Production carries no demo name, so there is no
  // combination of environment variables that reaches it. If this ever goes
  // green with a flag set, the guard has been defeated.
  it("refuses a live Railway database no matter what flags are set", () => {
    const everything = env({
      CONFIRM_SEED_HOST: LIVE.host,
      ALLOW_DESTRUCTIVE: "1",
      ALLOW_REMOTE_DB: "1",
      ALLOW_TRIP_WIPE: "1",
      NODE_ENV: "development",
    });
    const gate = seedGate("seed", LIVE, everything);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.lines.join(" ")).toMatch(/PRODUCTION/);
  });

  it("refuses a live Railway database even when the host is retyped correctly", () => {
    expect(seedGate("seed", LIVE, env({ CONFIRM_SEED_HOST: LIVE.host })).ok).toBe(false);
  });

  it("refuses the demo database until the host is retyped", () => {
    const gate = seedGate("seed", DEMO, env());
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.lines.join(" ")).toMatch(/CONFIRM_SEED_HOST/);
  });

  it("refuses a near-miss host — a typo must not pass", () => {
    const gate = seedGate("seed", DEMO, env({ CONFIRM_SEED_HOST: "monorail.proxy.rlwy.ne" }));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.lines.join(" ")).toMatch(/does not match/);
  });

  it("allows the demo database once its host is retyped exactly", () => {
    const gate = seedGate("seed", DEMO, env({ CONFIRM_SEED_HOST: DEMO_HOST }));
    expect(gate.ok).toBe(true);
  });

  it("refuses an unset or unparseable target", () => {
    expect(seedGate("seed", { host: null, database: null }, env()).ok).toBe(false);
  });

  // The demo name is what makes the target reachable, so a database that merely
  // sits on the demo HOST must not inherit it.
  it("does not let the demo host carry a non-demo database through", () => {
    const gate = seedGate("seed", target(DEMO_HOST, "railway"), env({ CONFIRM_SEED_HOST: DEMO_HOST }));
    expect(gate.ok).toBe(false);
  });
});
