import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createGlobalRateLimiter, resolveRateLimit } from "./middleware/rateLimit";
import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import meRoutes from "./routes/me";
import tripsRoutes from "./routes/trips";
import exceptionsRoutes from "./routes/exceptions";
import { redactRequestorMoneyLayer, REQUESTOR_REDACTED_PREFIXES } from "./lib/requestorMoney";
import metaRoutes from "./routes/meta";
import consigneesRoutes from "./routes/consignees";
import incentivesRoutes from "./routes/incentives";
import trucksRoutes from "./routes/trucks";
import ratesRoutes from "./routes/rates";
import reportsRoutes from "./routes/reports";
import analyticsRoutes from "./routes/analytics";
import locationsRoutes from "./routes/locations";
import fleetRoutes from "./routes/fleet";
import settingsRoutes from "./routes/settings";
import clientErrorsRoutes from "./routes/clientErrors";
import feedbackRoutes from "./routes/feedback";
import dispatchRoutes from "./routes/dispatch";
import holidaysRoutes from "./routes/holidays";
import leavesRoutes from "./routes/leaves";
import auditRoutes from "./routes/audit";
import publicRoutes from "./routes/public";
import searchRoutes from "./routes/search";
import { errorHandler } from "./middleware/errorHandler";

// The Express app is constructed here and exported so it can be driven
// in-process by tests (supertest) WITHOUT binding a port or starting the
// background jobs. index.ts imports this app and owns listen() + the jobs.
export const app = express();

// Railway terminates TLS at its proxy and forwards X-Forwarded-For. Trust the
// single proxy hop so express-rate-limit keys on the real client IP (and to
// silence its ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation error).
app.set("trust proxy", 1);

app.use(helmet());
// CORS_ORIGIN may be a comma-separated allowlist. In prod Railway sets it
// explicitly (the deployed mobile-web origin); this default only covers local
// dev — the Expo web app's origin. (Was localhost:5173, the retired Vite admin.)
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:8081")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins }));
// Requests per minute per USER (per IP when unauthenticated) — see
// middleware/rateLimit for why the key is not the IP alone. RATE_LIMIT_MAX
// overrides the default; 0 disables throttling entirely, intended ONLY for
// local testing (the browser e2e suite drives one API instance from one IP).
// Unset, blank or invalid values keep the production default, so a typo can
// never weaken the deployed limiter.
//
// 300/min is sized against real client behaviour rather than picked: the admin
// board polls ~20 req/min per open session with nobody touching it, so this is
// ~15x idle and ~3x a heavy interaction minute. Because the budget is per
// PERSON it no longer has to grow with UWC's headcount — the old per-IP 100 was
// already exhausted by five idle office sessions.
const RATE_LIMIT_MAX = resolveRateLimit(process.env.RATE_LIMIT_MAX, 300);
app.use(createGlobalRateLimiter(RATE_LIMIT_MAX));
app.use(express.json());

/**
 * Liveness, plus WHICH BUILD IS ANSWERING.
 *
 * `release` closes a real gap: after a merge there was no way to confirm from
 * outside that the new code was actually serving. "It deployed" was an inference
 * from the merge, not an observation — and on 1 Aug the only thing that could
 * answer it was a temporary debug route, which then had to be removed.
 *
 * Safe to expose: the SHA identifies a commit in a PUBLIC repository, so it
 * reveals nothing that `git log` does not. Null locally, where Railway does not
 * set the variable.
 */
app.get("/api/v1/health", (_req, res) => {
  res.json({ status: "ok", release: process.env.RAILWAY_GIT_COMMIT_SHA ?? null });
});

app.use("/api/v1/auth", authRoutes);

// ── SC7: the requestor field guard leads EVERY prefix it protects ──────────
// Driven by REQUESTOR_REDACTED_PREFIXES so the mount and the assertion in
// tests/requestorMoneyMount are the same fact rather than two copies that can
// drift. Registered here, ahead of every router below, because the layer only
// covers what is mounted AFTER it — and because "anything added later is
// covered without anyone remembering" is the entire point.
//
// The role is read when res.json is CALLED, not when this middleware runs:
// requireAuth lives inside each router, so req.user does not exist yet at
// registration time. Being first also makes it the LAST transform applied
// (each wrapper captures the res.json it finds), so nothing downstream —
// including the POD-signing wrapper — can put an amount back.
for (const prefix of REQUESTOR_REDACTED_PREFIXES) {
  app.use(prefix, redactRequestorMoneyLayer);
}

// meRoutes is mounted first so GET /users/me resolves to the self-profile
// handler (any authenticated user) before the admin-only users router.
app.use("/api/v1/users", meRoutes);
app.use("/api/v1/users", usersRoutes);
// Driver pay is not requestor-visible. The choke point for this prefix is
// mounted in the loop above, ahead of BOTH routers on it — it lives there
// rather than inside tripsRoutes because exceptionsRoutes shares the prefix,
// and a router-local `router.use()` would cover it only because tripsRoutes
// happens to be mounted first.
app.use("/api/v1/trips", tripsRoutes);
// Failed-delivery / exception workflow (Phase 1, feature-flagged off by default).
// Mounted on the same /trips prefix; its paths (/:id/exception*) don't collide
// with the trips router's routes.
app.use("/api/v1/trips", exceptionsRoutes);
app.use("/api/v1", metaRoutes); // /departments, /route-types
app.use("/api/v1/consignees", consigneesRoutes);
app.use("/api/v1/incentives", incentivesRoutes);
app.use("/api/v1/trucks", trucksRoutes);
app.use("/api/v1/audit", auditRoutes);
app.use("/api/v1/search", searchRoutes);
// Public (unauthenticated) read-only delivery tracking page. Not under /api/v1
// so the shareable link stays clean: <host>/track/<token>.
app.use("/track", publicRoutes);
app.use("/api/v1/rates", ratesRoutes);
app.use("/api/v1/reports", reportsRoutes);
app.use("/api/v1/analytics", analyticsRoutes);
app.use("/api/v1/locations", locationsRoutes);
app.use("/api/v1/fleet", fleetRoutes);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/client-errors", clientErrorsRoutes);
app.use("/api/v1/feedback", feedbackRoutes);
app.use("/api/v1/dispatch", dispatchRoutes);
app.use("/api/v1/holidays", holidaysRoutes);
app.use("/api/v1/leaves", leavesRoutes);

app.use(errorHandler);
