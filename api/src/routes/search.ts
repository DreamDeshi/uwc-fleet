/**
 * Global search (admin). One query across tickets, people (drivers/requestors)
 * and consignees, so an admin can jump to anything without knowing which screen
 * it lives on. Read-only; capped result sets per category.
 */
import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth, requireRole("admin"));

router.get("/", async (req, res, next) => {
  try {
    const q = (typeof req.query.q === "string" ? req.query.q : "").trim();
    if (q.length < 2) {
      res.json({ trips: [], users: [], consignees: [] });
      return;
    }
    const ci = { contains: q, mode: "insensitive" as const };
    const [trips, users, consignees] = await Promise.all([
      prisma.trip.findMany({
        where: { ticket_number: ci },
        select: { id: true, ticket_number: true, status: true },
        orderBy: { created_at: "desc" },
        take: 8,
      }),
      prisma.user.findMany({
        where: { OR: [{ name: ci }, { phone: { contains: q } }] },
        select: { id: true, name: true, role: true, phone: true },
        take: 8,
      }),
      prisma.consignee.findMany({
        where: { is_active: true, company_name: ci },
        select: { id: true, company_name: true, zone_code: true, area: true },
        orderBy: { company_name: "asc" },
        take: 8,
      }),
    ]);
    res.json({ trips, users, consignees });
  } catch (err) {
    next(err);
  }
});

export default router;
