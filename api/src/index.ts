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
import locationsRoutes from "./routes/locations";
import fleetRoutes from "./routes/fleet";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  })
);
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
app.use("/api/v1/locations", locationsRoutes);
app.use("/api/v1/fleet", fleetRoutes);

app.use(errorHandler);

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`UWC Fleet API listening on port ${PORT}`);
});
