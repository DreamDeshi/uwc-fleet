import { app } from "./app";
import { startPendingTripAlerts } from "./services/pendingTripAlerts";
import { startRateMaturation } from "./services/pendingRates";
import { startStaleTicketSweep } from "./services/staleTicketSweep";
import { prisma } from "./lib/prisma";
import { checkLocalDb, isDeployedRuntime } from "./lib/dbGuard";

// Safety net for local dev: `npm run dev` must talk to the Docker test DB, not
// the live trial DB. On the real Railway deployment (RAILWAY_* /
// NODE_ENV=production) this is skipped so prod boots against its own database.
// Set ALLOW_REMOTE_DB=1 to deliberately run a local server against a remote DB.
if (!isDeployedRuntime()) {
  const dbCheck = checkLocalDb("api dev server");
  if (!dbCheck.ok) {
    console.error(`\n✖ ${dbCheck.message}\n`);
    process.exit(1);
  }
}

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
  // Background job (feedback item 8): every 03:00 MYT, auto-cancel undelivered
  // tickets from prior days so their drivers/trucks are freed for the new day.
  startStaleTicketSweep();
});
