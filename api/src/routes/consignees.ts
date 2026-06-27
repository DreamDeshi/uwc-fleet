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
const RESULT_LIMIT = 10;
// Require 2+ chars before filtering — a single letter matches almost every
// consignee in a small directory, so the result list looked identical no matter
// what was typed. Below this we just return the alphabetical head of the list.
const MIN_SEARCH_LEN = 2;

router.get("/", async (req, res, next) => {
  try {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const zone = typeof req.query.zone === "string" ? req.query.zone : undefined;
    const searching = search.length >= MIN_SEARCH_LEN;

    const consignees = await prisma.consignee.findMany({
      where: {
        is_active: true,
        ...(zone ? { zone_code: zone } : {}),
        ...(searching
          ? {
              // Case-insensitive CONTAINS across name, contact and address fields
              // so partial matches anywhere hit (e.g. "pen" → "PENANG PORT").
              OR: [
                { company_name: { contains: search, mode: "insensitive" } },
                { contact_person: { contains: search, mode: "insensitive" } },
                { address_1: { contains: search, mode: "insensitive" } },
                { address_2: { contains: search, mode: "insensitive" } },
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
      // When searching, pull a wider candidate pool so the relevance sort below
      // has something to rank before we trim to RESULT_LIMIT.
      take: searching ? 50 : RESULT_LIMIT,
    });

    // Rank by relevance: company names that START WITH the query first, then
    // names that merely contain it, then matches found only on a secondary
    // field (contact/address/area/vendor). Alphabetical within each tier.
    if (searching) {
      const q = search.toLowerCase();
      const tier = (c: (typeof consignees)[number]) => {
        const name = c.company_name.toLowerCase();
        if (name.startsWith(q)) return 0;
        if (name.includes(q)) return 1;
        return 2;
      };
      consignees.sort((a, b) => tier(a) - tier(b) || a.company_name.localeCompare(b.company_name));
    }

    res.json(consignees.slice(0, RESULT_LIMIT));
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
