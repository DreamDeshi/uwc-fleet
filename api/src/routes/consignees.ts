import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
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

// Normalise for matching: lowercase and drop everything that isn't a letter or
// digit (dots, dashes, brackets, spaces, "&", etc.). This makes the search
// punctuation- and spacing-insensitive, so "ace" and "ace engineering" both hit
// "A.C.E ENGINEERING SDN BHD". The same expression runs on the DB column inside
// the raw query below so both sides are compared in the same normalised form.
const PG_NORMALISE_REGEX = "[^a-z0-9]";
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Strip the "SDN BHD" / "BHD" company suffix for display only — the full legal
// name stays in the database; this just declutters the search list. Never
// returns empty (falls back to the original if the name was only the suffix).
function stripCompanySuffix(name: string): string {
  const cleaned = name
    .replace(/\bsdn\.?\s*bhd\.?/gi, " ")
    .replace(/\bbhd\.?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,]+$/, "")
    .trim();
  return cleaned.length > 0 ? cleaned : name;
}

interface ConsigneeRow {
  id: string;
  company_name: string;
  vendor_code: string | null;
  contact_person: string | null;
  phone: string | null;
  area: string | null;
  state: string | null;
  zone_code: string;
  zone_name: string | null;
}

router.get("/", async (req, res, next) => {
  try {
    const rawSearch = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const zone = typeof req.query.zone === "string" ? req.query.zone : undefined;
    const ns = normalise(rawSearch);
    // Only search once there are 2+ real characters AND something survives
    // normalisation (typing just "--" shouldn't match the whole directory).
    const searching = rawSearch.length >= MIN_SEARCH_LEN && ns.length > 0;

    let rows: ConsigneeRow[];

    if (searching) {
      const like = `%${ns}%`;
      const prefix = `${ns}%`;
      // Match the normalised search against the normalised company name, area,
      // STATE, address lines, contact and vendor code. Rank in SQL: company
      // names that start with the query first, then ones that contain it, then
      // matches found only on another field. Alphabetical within each tier.
      const nameNorm = Prisma.sql`regexp_replace(lower(c.company_name), ${PG_NORMALISE_REGEX}, '', 'g')`;
      const fieldNorm = (col: Prisma.Sql) =>
        Prisma.sql`regexp_replace(lower(coalesce(${col}, '')), ${PG_NORMALISE_REGEX}, '', 'g')`;
      rows = await prisma.$queryRaw<ConsigneeRow[]>(Prisma.sql`
        SELECT c.id, c.company_name, c.vendor_code, c.contact_person, c.phone,
               c.area, c.state, c.zone_code, z.name AS zone_name
        FROM "Consignee" c
        LEFT JOIN "Zone" z ON z.code = c.zone_code
        WHERE c.is_active = true
          ${zone ? Prisma.sql`AND c.zone_code = ${zone}` : Prisma.empty}
          AND (
            ${nameNorm} LIKE ${like}
            OR ${fieldNorm(Prisma.sql`c.area`)} LIKE ${like}
            OR ${fieldNorm(Prisma.sql`c.state`)} LIKE ${like}
            OR ${fieldNorm(Prisma.sql`c.address_1`)} LIKE ${like}
            OR ${fieldNorm(Prisma.sql`c.address_2`)} LIKE ${like}
            OR ${fieldNorm(Prisma.sql`c.contact_person`)} LIKE ${like}
            OR ${fieldNorm(Prisma.sql`c.vendor_code`)} LIKE ${like}
          )
        ORDER BY
          CASE
            WHEN ${nameNorm} LIKE ${prefix} THEN 0
            WHEN ${nameNorm} LIKE ${like} THEN 1
            ELSE 2
          END,
          c.company_name ASC
        LIMIT ${RESULT_LIMIT}
      `);
    } else {
      const head = await prisma.consignee.findMany({
        where: { is_active: true, ...(zone ? { zone_code: zone } : {}) },
        select: {
          id: true,
          company_name: true,
          vendor_code: true,
          contact_person: true,
          phone: true,
          area: true,
          state: true,
          zone_code: true,
          zone: { select: { name: true } },
        },
        orderBy: { company_name: "asc" },
        take: RESULT_LIMIT,
      });
      rows = head.map((c) => ({ ...c, zone_name: c.zone?.name ?? null }));
    }

    // Strip the company suffix for display; keep the same response shape the
    // mobile app expects (zone as { code, name }).
    res.json(
      rows.map((r) => ({
        id: r.id,
        company_name: stripCompanySuffix(r.company_name),
        vendor_code: r.vendor_code,
        contact_person: r.contact_person,
        phone: r.phone,
        area: r.area,
        state: r.state,
        zone_code: r.zone_code,
        zone: r.zone_name ? { code: r.zone_code, name: r.zone_name } : null,
      }))
    );
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
