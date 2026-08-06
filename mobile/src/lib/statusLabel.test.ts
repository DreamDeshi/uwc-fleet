import { describe, it, expect } from "vitest";
import type { Role, TripStatus } from "../types";
import { STATUS_LABEL_KEY, statusLabelKey } from "./statusLabel";
import en from "../i18n/en.json";
import ms from "../i18n/ms.json";
import zh from "../i18n/zh.json";

const ALL_STATUSES: TripStatus[] = [
  "pending",
  "approved",
  "rejected",
  "assigned",
  "in_progress",
  "pending_approval",
  "completed",
  "cancelled",
];

const ALL_ROLES: Role[] = ["admin", "driver", "requestor"];

/** Resolve a dotted i18n key against a locale bundle. */
function lookup(bundle: Record<string, any>, key: string): unknown {
  return key.split(".").reduce<any>((node, part) => (node == null ? undefined : node[part]), bundle);
}

describe("statusLabelKey", () => {
  it("narrows pending_approval to Delivered for the requestor only", () => {
    expect(statusLabelKey("pending_approval", "requestor")).toBe("trip.statusDelivered");
    expect(statusLabelKey("pending_approval", "driver")).toBe("trip.statusPendingApproval");
    expect(statusLabelKey("pending_approval", "admin")).toBe("trip.statusPendingApproval");
  });

  // The driver's money is held by exactly this status, and the admin is the one
  // who releases it. Narrowing it for them would hide the pay gate, so this is
  // the assertion that must fail if anyone widens the rule to "everyone".
  it("keeps the pay gate visible to the roles it concerns", () => {
    for (const role of ["driver", "admin"] as const) {
      expect(statusLabelKey("pending_approval", role)).not.toBe("trip.statusDelivered");
    }
  });

  it("changes nothing else, for any role", () => {
    for (const role of ALL_ROLES) {
      for (const status of ALL_STATUSES) {
        if (role === "requestor" && status === "pending_approval") continue;
        expect(statusLabelKey(status, role)).toBe(STATUS_LABEL_KEY[status]);
      }
    }
  });

  // A null user is the pre-/me state on a cold launch. Falling back to the
  // unnarrowed label is the safe direction: it can never claim goods arrived.
  it("falls back to the unnarrowed label for an unknown or absent role", () => {
    expect(statusLabelKey("pending_approval", null)).toBe("trip.statusPendingApproval");
    expect(statusLabelKey("pending_approval", undefined)).toBe("trip.statusPendingApproval");
  });

  it("resolves every key it can return in all three locales", () => {
    const bundles: [string, Record<string, any>][] = [
      ["en", en],
      ["ms", ms],
      ["zh", zh],
    ];
    for (const [name, bundle] of bundles) {
      for (const role of ALL_ROLES) {
        for (const status of ALL_STATUSES) {
          const key = statusLabelKey(status, role);
          const value = lookup(bundle, key);
          expect(typeof value, `${name}: ${key} (${role}/${status})`).toBe("string");
          expect(String(value).length, `${name}: ${key} is empty`).toBeGreaterThan(0);
        }
      }
    }
  });

  // The requestor's booking-detail banner and this badge describe the same
  // booking; they disagreed before this change and must not drift apart again.
  it("matches the requestor booking-detail banner wording", () => {
    const bundles: [string, Record<string, any>][] = [
      ["en", en],
      ["ms", ms],
      ["zh", zh],
    ];
    for (const [name, bundle] of bundles) {
      expect(lookup(bundle, "trip.statusDelivered"), name).toBe(
        lookup(bundle, "bookingDetail.bannerCompleted")
      );
    }
  });
});
