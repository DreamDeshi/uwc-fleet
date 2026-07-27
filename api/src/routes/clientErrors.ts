// Client-side error intake — the owner's ask: "report any bugs so I fix it
// when live, for all users." Every uncaught JS error in the app lands here.
//
// NO schema change (the Prisma schema is frozen): the durable record is the
// server log line (Railway's log stream), plus an in-memory ring buffer the
// admin can read back for quick triage. The buffer resets on redeploy —
// acceptable: it's a triage window, not an archive.
//
// POST is UNAUTHENTICATED by design (crashes happen before login too) but
// size-capped, schema-validated and bounded by the ring + the app-level
// rate limiter, so it cannot become a spam or storage vector. No PII is
// collected — screen name, platform and versions only.
import { Router } from "express";
import { z } from "zod";
import { validateBody } from "../middleware/validate";
import { requireAuth } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";

const router = Router();

const reportSchema = z.object({
  message: z.string().min(1).max(1000),
  stack: z.string().max(8000).optional(),
  screen: z.string().max(200).optional(),
  platform: z.string().max(40).optional(),
  app_version: z.string().max(40).optional(),
  update_id: z.string().max(80).optional(),
  is_fatal: z.boolean().optional(),
});

interface ClientErrorEntry extends z.infer<typeof reportSchema> {
  at: string;
}

const RING_MAX = 200;
const ring: ClientErrorEntry[] = [];

router.post("/", validateBody(reportSchema), (req, res) => {
  const entry: ClientErrorEntry = { ...req.body, at: new Date().toISOString() };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
  // The log line is the durable record — greppable in Railway logs.
  console.error(
    `[client-error]${entry.is_fatal ? " FATAL" : ""} ${entry.platform ?? "?"} ${entry.update_id ?? "?"} ` +
      `${entry.screen ?? "?"}: ${entry.message}`
  );
  res.status(202).json({ ok: true });
});

// Admin triage view: newest first.
router.get("/", requireAuth, requireRole("admin"), (_req, res) => {
  res.json({ errors: [...ring].reverse() });
});

export default router;
