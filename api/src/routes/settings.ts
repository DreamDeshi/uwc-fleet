import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { ApiError } from "../lib/apiError";
import { prisma } from "../lib/prisma";
import { getDispatchMode, setDispatchMode } from "../lib/settings";
import {
  getSettingDef,
  listEffectiveSettings,
  resetSetting,
  updateSetting,
  zodSchemaFor,
} from "../lib/settingsRegistry";

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

// ── GET /settings — every admin-editable setting + its effective value ──
//
// Open to any authenticated user, same as GET /dispatch-mode above: none of
// these are secrets, and the requestor booking picker needs the live cut-off
// minutes to keep offering only what the server will actually accept (the
// exact reason the picker mirrors these constants at all — see
// mobile/src/lib/bookingEdit.ts). Only WRITES are admin-only.
router.get("/", async (_req, res, next) => {
  try {
    const settings = await listEffectiveSettings();
    res.json({
      settings: settings.map(({ def, value, source }) => ({
        key: def.key,
        category: def.category,
        label: def.label,
        description: def.description,
        type: def.type,
        min: def.min,
        max: def.max,
        default: def.default,
        value,
        source,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const settingValueSchema = z.object({ value: z.union([z.number(), z.string(), z.boolean()]) });

// ── PATCH /settings/:key — admin sets one setting, validated + audited ──
router.patch("/:key", requireRole("admin"), async (req, res, next) => {
  try {
    const def = getSettingDef(req.params.key);
    if (!def) {
      throw new ApiError(404, "SETTING_NOT_FOUND", "Unknown setting.");
    }
    const body = settingValueSchema.safeParse(req.body);
    if (!body.success) {
      throw new ApiError(400, "VALIDATION_ERROR", "A `value` field is required.");
    }
    const typed = zodSchemaFor(def).safeParse(body.data.value);
    if (!typed.success) {
      throw new ApiError(
        400,
        "INVALID_SETTING_VALUE",
        typed.error.issues.map((i) => i.message).join("; ")
      );
    }
    const { oldValue, newValue } = await updateSetting(def.key, typed.data);
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `setting.updated ${def.key} ${String(oldValue)}→${String(newValue)}`,
        table_name: "Setting",
        record_id: def.key,
      },
    });
    res.json({ key: def.key, value: newValue });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /settings/:key — admin resets one setting back to its default ──
router.delete("/:key", requireRole("admin"), async (req, res, next) => {
  try {
    const def = getSettingDef(req.params.key);
    if (!def) {
      throw new ApiError(404, "SETTING_NOT_FOUND", "Unknown setting.");
    }
    const { oldValue, newValue } = await resetSetting(def.key);
    await prisma.auditLog.create({
      data: {
        user_id: req.user!.id,
        action: `setting.reset ${def.key} ${String(oldValue)}→${String(newValue)}`,
        table_name: "Setting",
        record_id: def.key,
      },
    });
    res.json({ key: def.key, value: newValue });
  } catch (err) {
    next(err);
  }
});

export default router;
