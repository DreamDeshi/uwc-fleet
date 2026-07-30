import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import meRoutes from "./routes/me";
import tripsRoutes from "./routes/trips";
import exceptionsRoutes from "./routes/exceptions";
import { redactRequestorMoney } from "./lib/requestorMoney";
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
// Requests per minute per IP. RATE_LIMIT_MAX overrides the default 100; 0
// disables throttling entirely — intended ONLY for local testing (the browser
// e2e suite drives one API instance from one IP, so the whole Playwright run
// shares a single budget and trips it after a few specs). Unset, blank, or
// invalid values keep the production default, so a typo can never weaken the
// deployed limiter.
const rateLimitRaw = process.env.RATE_LIMIT_MAX?.trim();
const rateLimitParsed = rateLimitRaw ? Number(rateLimitRaw) : NaN;
const RATE_LIMIT_MAX =
  Number.isInteger(rateLimitParsed) && rateLimitParsed >= 0 ? rateLimitParsed : 100;
if (RATE_LIMIT_MAX > 0) {
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );
}
app.use(express.json());

app.get("/api/v1/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/v1/auth", authRoutes);
// meRoutes is mounted first so GET /users/me resolves to the self-profile
// handler (any authenticated user) before the admin-only users router.
app.use("/api/v1/users", meRoutes);
app.use("/api/v1/users", usersRoutes);
// Driver pay is not requestor-visible — one choke point for the WHOLE /trips
// prefix, ahead of both routers mounted on it.
//
// It lives here rather than inside tripsRoutes because exceptionsRoutes shares
// this prefix. A router-local `router.use()` IS prefix-level, so it does cover
// the exceptions router's paths — but only because tripsRoutes happens to be
// mounted above it. Swap the two app.use lines below and redaction silently
// disappears from every exceptions-router response, with no test going red.
// The argument for a choke point is "anything added later is covered without
// anyone remembering"; a guarantee that depends on the order of two mount
// lines is not that.
//
// The role is read when res.json is CALLED, not when this middleware runs:
// requireAuth lives inside each router, so req.user does not exist yet at
// registration time. Registered before the routers, so it is the LAST transform
// applied (each wrapper captures the res.json it finds) — nothing downstream,
// including the POD-signing wrapper, can put an amount back.
app.use("/api/v1/trips", (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) =>
    req.user?.role === "requestor" ? json(redactRequestorMoney(body)) : json(body);
  next();
});
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
