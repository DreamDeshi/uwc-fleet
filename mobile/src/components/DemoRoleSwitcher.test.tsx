import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import en from "../i18n/en.json";

/**
 * The demo one-tap role switcher, and the proof it CANNOT appear in production.
 *
 * The dangerous failure here is not a wrong label — it is the panel rendering
 * on the live trial, where it would hand anyone with the URL an admin session.
 * A unit test of `demoLoginEnabled()` alone would not catch that: it would pass
 * just as happily if the login screen ignored the gate, or never mounted the
 * component at all (the dead-code failure AGENTS.md describes).
 *
 * So this file asserts three different things:
 *
 *   1. the GATE — off unless BOTH the flag and a password are present;
 *   2. the RENDER — the real login screen, rendered through react-native-web,
 *      draws no demo control with the flag off and three with it on;
 *   3. the CALL SITE — both layouts (phone and desktop ≥1024px) mount it, so
 *      deleting either one turns this file red.
 *
 * (2) is what makes this more than a note about the risk: it renders the actual
 * screen, so "the guard is correct but nothing consults it" fails here.
 */

// `expo-modules-core` (reached via services/api → expo-constants) reads the
// React Native global `__DEV__` at import. Metro injects it; Vite does not.
(globalThis as any).__DEV__ = false;

// ── Mocks: everything the login screen needs that is native-only. The screen
//    itself, the switcher, and the gate are all REAL — mocking any of those
//    would be mocking the thing under test.
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-linear-gradient", async () => {
  const rn = await import("react-native");
  return { LinearGradient: rn.View };
});
vi.mock("@expo/vector-icons", async () => {
  const rn = await import("react-native");
  const React2 = await import("react");
  // Icons render as nothing; they carry no copy the assertions depend on.
  const Ionicons = () => React2.createElement(rn.View, null);
  return { Ionicons };
});
vi.mock("../components/BrandLogo", async () => {
  const rn = await import("react-native");
  const React2 = await import("react");
  return { BrandLogo: () => React2.createElement(rn.View, null) };
});
// services/api reaches expo-constants → expo-modules-core, which cannot load
// outside a native/Metro runtime. Only the error formatter is used here.
vi.mock("../services/api", () => ({
  apiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ login: vi.fn() }),
}));
vi.mock("react-i18next", () => ({
  // Resolve against the REAL en.json, so the assertions below match the copy a
  // judge actually sees rather than a key name.
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), en) ?? key,
  }),
}));

const FLAG = "EXPO_PUBLIC_FEATURE_DEMO_LOGIN";
const PW = "EXPO_PUBLIC_DEMO_PASSWORD";
const originalFlag = process.env[FLAG];
const originalPw = process.env[PW];

const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
};

beforeEach(() => {
  delete process.env[FLAG];
  delete process.env[PW];
});
afterEach(() => {
  restore(FLAG, originalFlag);
  restore(PW, originalPw);
});

// The login screen is imported lazily inside each test so the mocks above are
// installed first; the gate reads env at call time, so no module reset is
// needed between the on and off cases.
const renderLogin = async () => {
  const { LoginScreen } = await import("../screens/auth/LoginScreen");
  const navigation = { navigate: () => {} } as any;
  return renderToStaticMarkup(
    React.createElement(LoginScreen, { navigation, route: { key: "l", name: "Login" } } as any)
  );
};

const DEMO_LABELS = [en.login.demo.admin, en.login.demo.driver, en.login.demo.requestor];

describe("demo one-tap login — the gate", () => {
  it("is OFF when neither the flag nor a password is set (the production case)", async () => {
    const { demoLoginEnabled, demoAccounts } = await import("../lib/demoLogin");
    expect(demoLoginEnabled()).toBe(false);
    expect(demoAccounts()).toEqual([]);
  });

  it("is OFF for any flag value other than the exact string 'true'", async () => {
    const { demoLoginEnabled } = await import("../lib/demoLogin");
    process.env[PW] = "whatever";
    for (const v of ["", "false", "1", "TRUE", "True", "yes", "on"]) {
      process.env[FLAG] = v;
      expect(demoLoginEnabled(), `flag=${JSON.stringify(v)} must not open the gate`).toBe(
        false
      );
    }
  });

  it("is OFF with the flag on but NO password — a stray flag alone opens nothing", async () => {
    const { demoLoginEnabled, demoAccounts } = await import("../lib/demoLogin");
    process.env[FLAG] = "true";
    delete process.env[PW];
    expect(demoLoginEnabled()).toBe(false);
    expect(demoAccounts()).toEqual([]);

    // An empty string is the shape a misconfigured build actually produces.
    process.env[PW] = "";
    expect(demoLoginEnabled()).toBe(false);
  });

  it("is ON only with BOTH, and offers exactly the three demo roles", async () => {
    const { demoLoginEnabled, demoAccounts } = await import("../lib/demoLogin");
    process.env[FLAG] = "true";
    process.env[PW] = "demo-pw";
    expect(demoLoginEnabled()).toBe(true);
    expect(demoAccounts().map((a) => a.role)).toEqual(["admin", "driver", "requestor"]);
    // Synthetic demo numbers only — these accounts exist on the demo database.
    expect(demoAccounts().map((a) => a.phone)).toEqual([
      "+60100000001",
      "+60100000101",
      "+60199990001",
    ]);
  });
});

describe("demo one-tap login — what the LOGIN SCREEN actually renders", () => {
  it("draws NO demo control when the gate is shut", async () => {
    const html = await renderLogin();

    // First prove the render is real. An exception, an empty string or a bare
    // wrapper would make the absence assertions below pass for the wrong
    // reason — "there is nothing there" and "I rendered nothing" are the same
    // observation until you separate them.
    expect(html).toContain(en.login.signIn);
    expect(html).toContain(en.login.createAccount);

    for (const label of [...DEMO_LABELS, en.login.demo.title]) {
      expect(html, `production login must not offer "${label}"`).not.toContain(label);
    }
  });

  it("draws all three buttons when the demo build's flag and password are present", async () => {
    process.env[FLAG] = "true";
    process.env[PW] = "demo-pw";
    const html = await renderLogin();

    for (const label of DEMO_LABELS) {
      expect(html, `demo login must offer "${label}"`).toContain(label);
    }
    expect(html).toContain(en.login.demo.title);

    // The normal form stays — the buttons are an addition, not a replacement.
    expect(html).toContain(en.login.signIn);
    expect(html).toContain(en.login.phone);
  });
});

describe("demo one-tap login — the call sites", () => {
  // The two tests above prove the component obeys the gate. Nothing in them
  // proves the DESKTOP branch mounts it: the render above takes the phone
  // branch (useWide() is false with no window), so a desktop-only regression
  // would sail through. These read the source of both branches instead.
  //
  // Prove them by DELETING a <DemoRoleSwitcher /> line, not by breaking the
  // gate — removing the call site is the failure this catches.
  const source = fs.readFileSync(
    path.resolve(__dirname, "../screens/auth/LoginScreen.tsx"),
    "utf-8"
  );

  it("mounts the switcher in the DESKTOP (≥1024px) layout", () => {
    const start = source.indexOf("if (wide) {");
    expect(start, "the desktop branch moved or was renamed").toBeGreaterThan(-1);
    const end = source.indexOf("// ── Phone:", start);
    expect(end, "the phone branch comment moved or was renamed").toBeGreaterThan(start);

    expect(source.slice(start, end)).toContain("<DemoRoleSwitcher");
  });

  it("mounts the switcher in the PHONE layout", () => {
    const start = source.indexOf("// ── Phone:");
    expect(start, "the phone branch moved or was renamed").toBeGreaterThan(-1);

    const phoneBranch = source.slice(start);
    expect(phoneBranch).toContain("<DemoRoleSwitcher");
    // Above the form, not below it: the QR lands a judge here and the point is
    // that they type nothing.
    expect(phoneBranch.indexOf("<DemoRoleSwitcher")).toBeLessThan(
      phoneBranch.indexOf("styles.phoneFields")
    );
  });
});
