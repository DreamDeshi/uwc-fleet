/**
 * Audit-log viewer (admin, read-only). AuditLog rows are written across the app
 * (rate edits, approvals, overrides, assignments, fleet changes) but were only
 * ever read internally — this exposes them so an admin can answer "who changed
 * what, and when" without a DB query. Read-only: no create/update/delete here.
 */
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

// GET /audit — newest-first, keyset-paged, optional table/action filters.
router.get("/", async (req, res, next) => {
  try {
    const take = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;
    const table = typeof req.query.table === "string" && req.query.table ? req.query.table : undefined;
    const action = typeof req.query.action === "string" && req.query.action ? req.query.action : undefined;

    const where = {
      ...(table ? { table_name: table } : {}),
      ...(action ? { action } : {}),
    };

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: take + 1, // one extra to detect another page
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        action: true,
        table_name: true,
        record_id: true,
        timestamp: true,
        user: { select: { id: true, name: true, role: true } },
      },
    });

    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    res.json({ rows: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (err) {
    next(err);
  }
});

// GET /audit/filters — distinct action + table values, for the filter dropdowns.
router.get("/filters", async (_req, res, next) => {
  try {
    const [actions, tables] = await Promise.all([
      prisma.auditLog.findMany({ distinct: ["action"], select: { action: true }, orderBy: { action: "asc" } }),
      prisma.auditLog.findMany({ distinct: ["table_name"], select: { table_name: true }, orderBy: { table_name: "asc" } }),
    ]);
    res.json({ actions: actions.map((a) => a.action), tables: tables.map((t) => t.table_name) });
  } catch (err) {
    next(err);
  }
});

export default router;
