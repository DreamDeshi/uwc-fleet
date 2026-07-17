import { Router } from "express";
import { prisma } from "../lib/prisma";
import { statusBreakdown } from "../lib/statusBreakdown";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth);

// Malaysia is UTC+8 year-round (no DST); we bin trips by their MYT calendar month
// so a UTC-hosted server still buckets activity into the right local month —
// matching the convention used elsewhere (users.ts / trucks.ts).
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** MYT (UTC+8) calendar-month key "YYYY-MM" for a UTC instant. */
function mytMonthKey(date: Date): string {
  const myt = new Date(date.getTime() + MYT_OFFSET_MS);
  return `${myt.getUTCFullYear()}-${pad2(myt.getUTCMonth() + 1)}`;
}

// AuditLog actions whose timestamp marks a trip's "first assignment" — the Trip
// model stores no assigned_at, so the audit trail is the source of that moment.
// Covers manual approve, external assignment, and auto-dispatch.
const ASSIGN_ACTIONS = ["trip.approved", "trip.assigned_external", "trip.auto_dispatched"];

// ── GET /analytics/mine — the logged-in requestor's own analytics (FR-RS1-5) ──
// Everything is scoped to req.user.id as the requestor; a new requestor with no
// trips gets all-zero structures (the client renders a friendly empty state).
router.get("/mine", requireRole("requestor"), async (req, res, next) => {
  try {
    const requestorId = req.user!.id;

    const trips = await prisma.trip.findMany({
      where: { requestor_id: requestorId },
      select: {
        id: true,
        status: true,
        created_at: true,
        stops: {
          orderBy: { sequence: "asc" },
          take: 1,
          select: { consignee: { select: { area: true, zone_code: true } } },
        },
        cargo_details: { select: { pallet_type: true, quantity: true } },
      },
    });

    // ── FR-RS1: monthly_activity — trip count per MYT month, last 6 months ──
    const nowMyt = new Date(Date.now() + MYT_OFFSET_MS);
    const y = nowMyt.getUTCFullYear();
    const m = nowMyt.getUTCMonth();
    const monthly_activity: { month: string; count: number }[] = [];
    const monthIndex = new Map<string, number>();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      const key = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
      monthIndex.set(key, monthly_activity.length);
      monthly_activity.push({ month: key, count: 0 });
    }
    for (const t of trips) {
      const idx = monthIndex.get(mytMonthKey(t.created_at));
      if (idx !== undefined) monthly_activity[idx].count += 1;
    }

    // ── FR-RS2: status_breakdown — counts by status, five buckets that always
    // sum to the requestor's total. The folds and the exhaustiveness guard live
    // in lib/statusBreakdown so they can be unit-tested; this route had no test
    // of any kind, which is how item 9 silently broke the sum contract. ──
    const status_breakdown = statusBreakdown(trips.map((t) => t.status));

    // ── FR-RS3: top_destinations — 5 most frequent first-stop area/zone ──
    const destCounts = new Map<string, number>();
    for (const t of trips) {
      const c = t.stops[0]?.consignee;
      const name = c?.area || c?.zone_code;
      if (!name) continue;
      destCounts.set(name, (destCounts.get(name) ?? 0) + 1);
    }
    const top_destinations = [...destCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // ── FR-RS4: cargo_history — total pallets + breakdown by pallet size ──
    let total_pallets = 0;
    const sizeCounts = new Map<string, number>();
    for (const t of trips) {
      for (const c of t.cargo_details) {
        total_pallets += c.quantity;
        sizeCounts.set(c.pallet_type, (sizeCounts.get(c.pallet_type) ?? 0) + c.quantity);
      }
    }
    const by_size = [...sizeCounts.entries()]
      .map(([size, count]) => ({ size, count }))
      .sort((a, b) => b.count - a.count);

    // ── FR-RS5: avg_approval_time_hours — created_at → first assignment audit,
    // across trips that reached assignment (assigned/in_progress/completed). ──
    const assignedIds = trips
      .filter((t) => t.status === "assigned" || t.status === "in_progress" || t.status === "completed")
      .map((t) => t.id);
    let avg_approval_time_hours: number | null = null;
    if (assignedIds.length > 0) {
      const events = await prisma.auditLog.findMany({
        where: { table_name: "Trip", action: { in: ASSIGN_ACTIONS }, record_id: { in: assignedIds } },
        orderBy: { timestamp: "asc" },
        select: { record_id: true, timestamp: true },
      });
      const firstAssign = new Map<string, Date>();
      for (const e of events) if (!firstAssign.has(e.record_id)) firstAssign.set(e.record_id, e.timestamp);

      const createdById = new Map(trips.map((t) => [t.id, t.created_at]));
      const durations: number[] = [];
      for (const [tripId, ts] of firstAssign) {
        const created = createdById.get(tripId);
        if (!created) continue;
        const hrs = (ts.getTime() - created.getTime()) / (60 * 60 * 1000);
        if (hrs >= 0) durations.push(hrs);
      }
      if (durations.length > 0) {
        const avg = durations.reduce((s, h) => s + h, 0) / durations.length;
        avg_approval_time_hours = Math.round(avg * 10) / 10;
      }
    }

    res.json({
      monthly_activity,
      status_breakdown,
      top_destinations,
      cargo_history: { total_pallets, by_size },
      avg_approval_time_hours,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
