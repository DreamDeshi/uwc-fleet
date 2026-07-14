import { app } from "./app";
import { startPendingTripAlerts } from "./services/pendingTripAlerts";
import { startRateMaturation } from "./services/pendingRates";
import { prisma } from "./lib/prisma";

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
