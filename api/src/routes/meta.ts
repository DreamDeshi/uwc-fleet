import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

// Reference-data endpoints the mobile app reads to fill dropdowns.
const router = Router();

// ── GET /departments — public (the Register screen needs it pre-login) ──
router.get("/departments", async (_req, res, next) => {
  try {
    const departments = await prisma.department.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json(departments);
  } catch (err) {
    next(err);
  }
});

// ── GET /route-types — the 6 UWC route types (auth required) ────────────
router.get("/route-types", requireAuth, async (_req, res, next) => {
  try {
    const routeTypes = await prisma.routeType.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    res.json(routeTypes);
  } catch (err) {
    next(err);
  }
});

export default router;
