import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import authRoutes from "./routes/auth";
import usersRoutes from "./routes/users";
import meRoutes from "./routes/me";
import tripsRoutes from "./routes/trips";
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
import dispatchRoutes from "./routes/dispatch";
import holidaysRoutes from "./routes/holidays";
import leavesRoutes from "./routes/leaves";
import { errorHandler } from "./middleware/errorHandler";
import { startPendingTripAlerts } from "./services/pendingTripAlerts";
import { startRateMaturation } from "./services/pendingRates";
import { prisma } from "./lib/prisma";

const app = express();

// Railway terminates TLS at its proxy and forwards X-Forwarded-For. Trust the
// single proxy hop so express-rate-limit keys on the real client IP (and to
// silence its ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation error).
app.set("trust proxy", 1);

app.use(helmet());
// CORS_ORIGIN may be a comma-separated allowlist (e.g. local admin +
// the deployed admin domain). Falls back to the local Vite dev origin.
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(cors({ origin: corsOrigins }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(express.json());

app.get("/api/v1/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/v1/auth", authRoutes);
// meRoutes is mounted first so GET /users/me resolves to the self-profile
// handler (any authenticated user) before the admin-only users router.
app.use("/api/v1/users", meRoutes);
app.use("/api/v1/users", usersRoutes);
app.use("/api/v1/trips", tripsRoutes);
app.use("/api/v1", metaRoutes); // /departments, /route-types
app.use("/api/v1/consignees", consigneesRoutes);
app.use("/api/v1/incentives", incentivesRoutes);
app.use("/api/v1/trucks", trucksRoutes);
app.use("/api/v1/rates", ratesRoutes);
app.use("/api/v1/reports", reportsRoutes);
app.use("/api/v1/analytics", analyticsRoutes);
app.use("/api/v1/locations", locationsRoutes);
app.use("/api/v1/fleet", fleetRoutes);
app.use("/api/v1/settings", settingsRoutes);
app.use("/api/v1/dispatch", dispatchRoutes);
app.use("/api/v1/holidays", holidaysRoutes);
app.use("/api/v1/leaves", leavesRoutes);

app.use(errorHandler);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`UWC Fleet API listening on port ${PORT}`);
  // Background job: ping admins about orders left pending for 15+ minutes.
  startPendingTripAlerts();
  // Background job: fold scheduled (next-day) rate edits into the live truck
  // columns once their MYT effective day arrives. Money exactness doesn't
  // depend on it (the assignment path merges pending rates itself) — this
  // keeps the displayed rates fresh.
  startRateMaturation(prisma);
});
