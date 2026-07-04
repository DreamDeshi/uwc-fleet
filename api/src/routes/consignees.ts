import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/apiError";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { activeBookingsForConsigneeWhere, updateConsignee } from "../services/consigneeUpdate";

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

// Two company names are "similar" (dedupe warning on self-add) when their
// normalised forms are equal or one contains the other — so "A.C.E Sdn Bhd"
// matches "ACE SDN. BHD." and "ACE Engineering" matches "ACE ENGINEERING SDN
// BHD". Containment requires 4+ normalised chars so a very short name doesn't
// flag half the directory. Exported for unit tests; the create route's SQL
// prefilter mirrors this rule.
export function isSimilarCompanyName(a: string, b: string): boolean {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.includes(na)) return true;
  if (nb.length >= 4 && na.includes(nb)) return true;
  return false;
}

// Similar-active candidates from a prefiltered row set: similarity rule
// applied, self excluded (a rename must not collide with the row being
// renamed), capped at 5 for the response. Shared by self-add (POST) and the
// admin rename path (PATCH) so the directory can't be renamed into the very
// near-duplicate the create path refuses. Exported for unit tests.
export function pickSimilarCandidates<T extends { id: string; company_name: string }>(
  rows: T[],
  companyName: string,
  excludeId?: string
): T[] {
  return rows
    .filter((r) => r.id !== excludeId && isSimilarCompanyName(companyName, r.company_name))
    .slice(0, 5);
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
  is_active: boolean;
}

router.get("/", async (req, res, next) => {
  try {
    const rawSearch = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const zone = typeof req.query.zone === "string" ? req.query.zone : undefined;
    // Admin directory management needs to see (and reactivate) deactivated
    // consignees; requestor search never does — the flag is admin-gated.
    const includeInactive = req.query.include_inactive === "1" && req.user!.role === "admin";
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
               c.area, c.state, c.zone_code, z.name AS zone_name, c.is_active
        FROM "Consignee" c
        LEFT JOIN "Zone" z ON z.code = c.zone_code
        WHERE ${includeInactive ? Prisma.sql`1 = 1` : Prisma.sql`c.is_active = true`}
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
        where: { ...(includeInactive ? {} : { is_active: true }), ...(zone ? { zone_code: zone } : {}) },
        select: {
          id: true,
          company_name: true,
          vendor_code: true,
          contact_person: true,
          phone: true,
          area: true,
          state: true,
          zone_code: true,
          is_active: true,
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
        // The FULL legal name — the admin editor must initialise from this,
        // or saving would write the display-stripped name back to the DB.
        company_name_full: r.company_name,
        vendor_code: r.vendor_code,
        contact_person: r.contact_person,
        phone: r.phone,
        area: r.area,
        state: r.state,
        zone_code: r.zone_code,
        is_active: r.is_active,
        zone: r.zone_name ? { code: r.zone_code, name: r.zone_name } : null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

// SQL prefilter + similarity pass for "a similar active consignee already
// exists" — shared by self-add (POST) and the admin rename path (PATCH).
async function similarActiveConsignees(
  companyName: string,
  excludeId?: string
): Promise<{ id: string; company_name: string; area: string | null; state: string | null; zone_code: string }[]> {
  const ns = normalise(companyName);
  if (ns.length === 0) return [];
  const like = `%${ns}%`;
  const nameNorm = Prisma.sql`regexp_replace(lower(c.company_name), ${PG_NORMALISE_REGEX}, '', 'g')`;
  const rows = await prisma.$queryRaw<
    { id: string; company_name: string; area: string | null; state: string | null; zone_code: string }[]
  >(Prisma.sql`
    SELECT c.id, c.company_name, c.area, c.state, c.zone_code
    FROM "Consignee" c
    WHERE c.is_active = true
      AND (${nameNorm} LIKE ${like} OR ${ns} LIKE '%' || ${nameNorm} || '%')
    ORDER BY c.company_name ASC
    LIMIT 8
  `);
  return pickSimilarCandidates(rows, companyName, excludeId);
}

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
  // Re-submit with force=true to create despite a SIMILAR_EXISTS warning.
  force: z.boolean().optional(),
});

router.post(
  "/",
  requireRole("requestor", "admin"),
  validateBody(createConsigneeSchema),
  async (req, res, next) => {
    try {
      // `force` is control flow, not consignee data — it must never reach the
      // Prisma create spread below.
      const { force, ...data } = req.body;
      const { zone_code, company_name } = data;

      const zone = await prisma.zone.findUnique({ where: { code: zone_code } });
      if (!zone) {
        throw new ApiError(400, "ZONE_NOT_FOUND", "That delivery zone does not exist.");
      }

      // Dedupe warning: the directory already grows junk near-duplicates from
      // self-adds ("ACE" vs "A.C.E Sdn Bhd"). Reuse the search normalisation to
      // find similar actives; without force, return them as candidates so the
      // requestor can pick the existing entry instead.
      if (!force) {
        const candidates = await similarActiveConsignees(company_name);
        if (candidates.length > 0) {
          throw new ApiError(
            409,
            "SIMILAR_EXISTS",
            "A similar consignee already exists — pick it from the list, or create anyway.",
            { candidates }
          );
        }
      }

      const consignee = await prisma.consignee.create({
        data: { ...data, created_by: req.user!.id },
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

// ── PATCH /consignees/:id — admin corrects a consignee (zone/name/active) ──
// The correction path for wrong-zone self-adds. Affects FUTURE bookings only:
// past pay is protected by the assignment + finalization snapshots (see
// services/consigneeUpdate.ts and its tests).
const updateConsigneeSchema = z
  .object({
    company_name: z.string().min(1).optional(),
    zone_code: z.string().min(1).optional(),
    is_active: z.boolean().optional(),
    // Re-submit with force=true past a SIMILAR_EXISTS rename warning.
    force: z.boolean().optional(),
  })
  .refine((b) => b.company_name !== undefined || b.zone_code !== undefined || b.is_active !== undefined, {
    message: "Nothing to update.",
  });

router.patch(
  "/:id",
  requireRole("admin"),
  validateBody(updateConsigneeSchema),
  async (req, res, next) => {
    try {
      // `force` is control flow, not consignee data (same as the create route).
      const { force, ...patch } = req.body as {
        force?: boolean;
        company_name?: string;
        zone_code?: string;
        is_active?: boolean;
      };

      // A RENAME goes through the same dedupe the self-add path enforces —
      // otherwise the directory could be renamed into the very near-duplicate
      // the create path refuses (audit 2026-07-05 #9). Only an actual name
      // CHANGE is checked (re-saving the modal with the same name is a no-op),
      // and the row being renamed is excluded from its own candidates.
      if (patch.company_name !== undefined && !force) {
        const existing = await prisma.consignee.findUnique({
          where: { id: req.params.id },
          select: { company_name: true },
        });
        if (existing && existing.company_name !== patch.company_name) {
          const candidates = await similarActiveConsignees(patch.company_name, req.params.id);
          if (candidates.length > 0) {
            throw new ApiError(
              409,
              "SIMILAR_EXISTS",
              "A similar consignee already exists — is this rename creating a duplicate?",
              { candidates }
            );
          }
        }
      }

      // DEACTIVATING while live bookings still route here deserves a warning
      // (audit #10): those trips keep dispatching and delivering to the
      // deactivated entry with no signal at either end. Warning, not a block —
      // force proceeds, and dispatch behaviour for existing bookings is
      // deliberately unchanged either way.
      if (patch.is_active === false && !force) {
        const activeBookings = await prisma.trip.count({
          where: activeBookingsForConsigneeWhere(req.params.id),
        });
        if (activeBookings > 0) {
          throw new ApiError(
            409,
            "CONSIGNEE_IN_USE",
            `${activeBookings} active booking${activeBookings === 1 ? " still routes" : "s still route"} to this consignee — they will keep delivering here after deactivation. Deactivate anyway?`,
            { count: activeBookings }
          );
        }
      }

      await updateConsignee(prisma, req.params.id, patch, req.user!.id);
      const updated = await prisma.consignee.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          company_name: true,
          area: true,
          state: true,
          zone_code: true,
          is_active: true,
          zone: { select: { code: true, name: true } },
        },
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
