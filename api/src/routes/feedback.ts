// In-app user feedback — the owner's channel for bug reports, gripes and
// feature ideas from ANY signed-in role (driver / requestor / admin), asked
// for 28 Jul 2026. Distinct from /client-errors (automatic, uncaught JS
// errors only) and from the driver exception report (delivery incidents).
//
// NO schema change (the Prisma schema is frozen): each submission is an
// AuditLog row — table_name "Feedback", record_id = the category, action =
// the user's text — durable across redeploys (unlike the client-errors
// ring) and joined to the submitting user. Free-text-in-action has
// precedent (abort reasons, rate-edit reasons). If feedback outgrows this,
// a dedicated Feedback table is the upgrade path once a schema change is
// approved.
import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { prisma } from "../lib/prisma";
import { upload } from "../lib/upload";
import { uploadBuffer } from "../lib/cloudinary";
import { signedAssetUrl } from "../lib/podPhotos";

const router = Router();
router.use(requireAuth);

const CATEGORIES = ["bug", "idea", "other"] as const;

const submitSchema = z.object({
  category: z.enum(CATEGORIES),
  message: z.string().trim().min(5).max(1000),
  screen: z.string().max(200).optional(),
});

// ── Optional screenshot, without a schema change ─────────────────────────────
// Feedback rows are AuditLog rows (the Prisma schema is frozen), so there is no
// column to hang an image on. The Cloudinary PUBLIC ID is appended to the same
// free-text `action` field behind a marker, and GET parses it back out.
//
// The public id is stored, NOT a URL: the asset is uploaded `authenticated`
// (same private pipeline as POD/K2 evidence — a screenshot can show customer
// data), so its delivery URL has to be freshly signed on every read. Storing a
// URL would bake in a signature that later expires.
const IMAGE_MARKER = /\n\[image: ([^\]]+)\]$/;

/** Split a stored action back into the user's text and the image public id. */
export function parseFeedbackAction(action: string): { message: string; imageId: string | null } {
  const m = action.match(IMAGE_MARKER);
  if (!m) return { message: action, imageId: null };
  return { message: action.slice(0, m.index), imageId: m[1] };
}

// ── POST /feedback — any signed-in user files a bug / idea / gripe ──
// Accepts JSON (no attachment) or multipart with an optional `image` field —
// "just a small area to show bugs for the dev to know" (owner, 29 Jul 2026).
// `upload.single` runs FIRST so multipart text fields are populated before the
// schema validates them; on a JSON request multer is a no-op.
router.post("/", upload.single("image"), validateBody(submitSchema), async (req, res, next) => {
  try {
    const { category, message, screen } = req.body as z.infer<typeof submitSchema>;

    let imageId: string | null = null;
    if (req.file) {
      const { publicId } = await uploadBuffer(req.file.buffer, "uwc/feedback", {
        type: "authenticated",
      });
      imageId = publicId;
    }

    const parts = [message];
    if (screen) parts.push(`[screen: ${screen}]`);
    // The image marker goes LAST — parseFeedbackAction anchors on the end of
    // the string, so text a user types cannot spoof it.
    if (imageId) parts.push(`[image: ${imageId}]`);

    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: parts.join("\n"),
        table_name: "Feedback",
        record_id: category,
      },
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /feedback — admin reads the inbox, newest first ──
router.get("/", requireRole("admin"), async (_req, res, next) => {
  try {
    const rows = await prisma.auditLog.findMany({
      where: { table_name: "Feedback" },
      orderBy: { timestamp: "desc" },
      take: 200,
      include: { user: { select: { name: true, role: true } } },
    });
    res.json({
      feedback: rows.map((r) => {
        // Rows filed before screenshots existed have no marker and parse to
        // {message: <the whole action>, imageId: null} — unchanged output.
        const { message, imageId } = parseFeedbackAction(r.action);
        return {
          id: r.id,
          category: r.record_id,
          message,
          // Freshly signed per read: the asset is private, so a stored URL
          // would expire (see the marker note above).
          image_url: imageId ? signedAssetUrl(imageId, { resourceType: "image" }) : null,
          user_name: r.user.name,
          role: r.user.role,
          at: r.timestamp,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
