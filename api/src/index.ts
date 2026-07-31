// FIRST, before anything else is required. Sentry's instrumentation can only
// see modules loaded after it initialises, and a crash during startup — the
// worst kind, because the service never comes up — is only reported if the
// client already exists. No-ops entirely without SENTRY_DSN.
import { initSentry, flushSentry } from "./lib/sentry";
initSentry();

import { app } from "./app";
import { startPendingTripAlerts } from "./services/pendingTripAlerts";
import { startRateMaturation } from "./services/pendingRates";
import { startStaleTicketSweep } from "./services/staleTicketSweep";
import { startDocExpiryReminders } from "./services/docExpiryReminders";
import { startExceptionAlerts } from "./services/exceptionAlerts";
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
  // Background job: once a day (09:00 MYT), push admins about trucks whose
  // insurance/permit/road-tax expires within the reminder window.
  startDocExpiryReminders();
  // Background job: ping admins about exceptions left open past the threshold
  // (the trip is operationally paused until they act). No-op while
  // FEATURE_EXCEPTIONS is off — the flag is read per sweep.
  startExceptionAlerts();
});

// Railway sends SIGTERM on every redeploy. Sentry buffers events, so without a
// flush the reports from the seconds before a restart — often the interesting
// ones, because a crash loop restarts constantly — are dropped on exit.
//
// Registered LAST, and it re-exits itself: adding the first SIGTERM/SIGINT
// listener overrides Node's default terminate-on-signal, so a handler that
// forgot to exit would leave the container hanging until Railway killed it.
// No-op without a DSN, and the exit happens either way.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void flushSentry(2000).finally(() => process.exit(0));
  });
}
