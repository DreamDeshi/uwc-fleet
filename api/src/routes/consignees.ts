import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();
router.use(requireAuth);

// ── GET /consignees?search=&zone= — search the consignee directory ──────
router.get("/", async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const zone = typeof req.query.zone === "string" ? req.query.zone : undefined;

    const consignees = await prisma.consignee.findMany({
      where: {
        is_active: true,
        ...(zone ? { zone_code: zone } : {}),
        ...(search
          ? {
              OR: [
                { company_name: { contains: search, mode: "insensitive" } },
                { area: { contains: search, mode: "insensitive" } },
                { vendor_code: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        company_name: true,
        vendor_code: true,
        contact_person: true,
        phone: true,
        area: true,
        state: true,
        zone_code: true,
        zone: { select: { code: true, name: true } },
      },
      orderBy: { company_name: "asc" },
      take: 50,
    });
    res.json(consignees);
  } catch (err) {
    next(err);
  }
});

// ── POST /consignees — requestor self-adds a consignee not in the list ──
const createConsigneeSchema = z.object({
  company_name: z.string().min(1, "Company name is required."),
  zone_code: z.string().min(1, "Zone is required."),
  contact_person: z.string().optional(),
  phone: z.string().optional(),
  address_1: z.string().optional(),
  address_2: z.string().optional(),
  area: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  vendor_code: z.string().optional(),
});

router.post(
  "/",
  requireRole("requestor", "admin"),
  validateBody(createConsigneeSchema),
  async (req, res, next) => {
    try {
      const { zone_code } = req.body;

      const zone = await prisma.zone.findUnique({ where: { code: zone_code } });
      if (!zone) {
        throw new ApiError(400, "ZONE_NOT_FOUND", "That delivery zone does not exist.");
      }

      const consignee = await prisma.consignee.create({
        data: { ...req.body, created_by: req.user!.id },
        select: {
          id: true,
          company_name: true,
          area: true,
          state: true,
          zone_code: true,
          zone: { select: { code: true, name: true } },
        },
      });

      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: "consignee.created",
          table_name: "Consignee",
          record_id: consignee.id,
        },
      });

      res.status(201).json(consignee);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
