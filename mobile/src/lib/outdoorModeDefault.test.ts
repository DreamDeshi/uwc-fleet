import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * OUTDOOR MODE IS OFF UNTIL SOMEONE TURNS IT ON.
 *
 * Asserted because of what merging means the night before a viva: the demo run
 * sheet was walked against the CURRENT driver screens, and a mode that
 * defaulted on — or on any truthy-looking stored value — would move the judge
 * lane under a toggle nobody switched.
 */
const store: Record<string, string> = {};
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (k: string) => (k in store ? store[k] : null),
    setItem: async (k: string, v: string) => {
      store[k] = v;
    },
  },
}));

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe("outdoor mode — default off", () => {
  it("is off when nothing is stored", async () => {
    const { loadOutdoorMode } = await import("./outdoorMode");
    expect(await loadOutdoorMode()).toBe(false);
  });

  it('is off for every value except the exact string "1"', async () => {
    const { loadOutdoorMode } = await import("./outdoorMode");
    for (const v of ["", "0", "true", "yes", "on", "TRUE", " 1"]) {
      store["uwc.outdoorMode"] = v;
      expect(await loadOutdoorMode(), `stored ${JSON.stringify(v)}`).toBe(false);
    }
    store["uwc.outdoorMode"] = "1";
    expect(await loadOutdoorMode()).toBe(true);
  });

  it("is off when storage throws", async () => {
    vi.resetModules();
    vi.doMock("@react-native-async-storage/async-storage", () => ({
      default: {
        getItem: async () => {
          throw new Error("storage unavailable");
        },
        setItem: async () => {},
      },
    }));
    const { loadOutdoorMode } = await import("./outdoorMode");
    expect(await loadOutdoorMode()).toBe(false);
  });
});
