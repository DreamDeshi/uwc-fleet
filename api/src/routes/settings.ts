import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { prisma } from "../lib/prisma";
import { getDispatchMode, setDispatchMode } from "../lib/settings";

const router = Router();
router.use(requireAuth);

// ── GET /settings/dispatch-mode — current manual/auto mode (any authed user) ──
router.get("/dispatch-mode", async (_req, res, next) => {
  try {
    res.json({ dispatch_mode: await getDispatchMode() });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /settings/dispatch-mode — admin switches manual ↔ auto ──
const dispatchModeSchema = z.object({ dispatch_mode: z.enum(["manual", "auto"]) });

router.patch(
  "/dispatch-mode",
  requireRole("admin"),
  validateBody(dispatchModeSchema),
  async (req, res, next) => {
    try {
      const mode = await setDispatchMode(req.body.dispatch_mode);
      await prisma.auditLog.create({
        data: {
          user_id: req.user!.id,
          action: "settings.dispatch_mode_changed",
          table_name: "AppSetting",
          record_id: "singleton",
        },
      });
      res.json({ dispatch_mode: mode });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
