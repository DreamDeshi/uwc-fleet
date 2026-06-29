# UWC Fleet — End-to-End Tests (Playwright)

Browser end-to-end tests covering the three real user roles against the **deployed**
apps on Railway:

| Target | URL |
| --- | --- |
| Mobile web (requestor + driver) | https://uwc-mobile-production.up.railway.app |
| Admin dashboard | https://uwc-admin-production.up.railway.app |
| API (used for seeding/reset) | https://uwc-api-production.up.railway.app |

There is **no local server to start** — the tests run straight against production.
This folder is standalone (its own `package.json`, not part of the npm workspace),
so install its dependencies separately.

## Prerequisites

- Node 18+ (uses the global `fetch`).
- The seeded test accounts must exist in the Railway DB (they are created by
  `api/prisma/seed-clean.ts`):

  | Role | Phone | Password |
  | --- | --- | --- |
  | Admin | `+60100000001` | `Password123` |
  | Driver (Driver 1 / PLX 2406) | `+60100000101` | `Password123` |
  | Requestor | `+60199990001` | `Password123` |

## Install

```bash
cd e2e
npm install
npm run install:browsers   # downloads Chromium for Playwright
```

## Run

```bash
npm test                 # headless, all specs
npm run test:headed      # watch it drive a real browser
npm run test:ui          # Playwright UI mode (pick/inspect tests)
npm run report           # open the HTML report from the last run

# single role
npm run test:requestor
npm run test:admin
npm run test:driver
```

## What's covered

**Requestor (mobile web)** — `tests/requestor.spec.ts`
1. Login with correct credentials → lands on home.
2. Login with the wrong password → shows the error.
3. Book a single-stop delivery → it appears in history as **Pending**.

**Admin (dashboard)** — `tests/admin.spec.ts`
4. Login → sees the dashboard.
5. A requestor's pending trip appears on the board.
6. Manually assign a driver → status becomes **Assigned**.
7. With auto mode on, a new booking is auto-dispatched → **Assigned**.
8. Toggle dispatch mode between manual and auto.

**Driver (mobile web)** — `tests/driver.spec.ts`
9. Login → home shows the assigned trip.
10. Start trip → status becomes **in progress**.
11. Upload a DO/POD photo and mark delivered → trip **completed**, incentive shown.

## How isolation works

The apps share one backend, so the suite **does not** rely on test ordering.
Before each test, `helpers/reset.ts`:

1. sets dispatch mode back to **manual** (so freshly seeded trips stay pending),
2. **frees the driver** — any active trip for Driver 1 is driven to completion through
   the API, because the "one active trip per driver" rule would otherwise reject a
   new assignment with `409 DRIVER_BUSY`, and
3. cancels all open (pending/approved) trips.

Each test then seeds exactly the fixture it needs via the API
(`helpers/seed.ts` → `POST /auth/login` then the trip endpoints) and scopes its
assertions to the specific ticket it created. Tests run serially (`workers: 1`)
because they share the single driver account.

> Trips already **assigned to other drivers** can't be cancelled via the API
> (only pending/approved can), so they may linger between tests without affecting
> the (ticket-scoped) assertions. For a guaranteed blank slate, run
> `npx tsx prisma/seed-clean.ts` in the `api` workspace.

## Selector strategy (no test IDs)

Neither front-end ships `data-testid`/`accessibilityLabel` hooks, so selectors use
**rendered text** and **input placeholders**:

- The mobile app is React Native Web — buttons render as clickable `<div>`s, so we
  click by visible text (`getByText("Sign In")`). Status badges render **UPPERCASE**
  (e.g. `ASSIGNED`).
- The admin app uses real `<button>`s with stable labels
  (`getByRole("button", { name: "Assign" })`).
- The mobile login phone field shows a fixed `+60` prefix and submits `+60` + the
  digits typed, so helpers enter only the national part.

If the apps later add `testID`/`data-testid` attributes, prefer those — they'd make
these tests far more robust than text matching.

## Config

`playwright.config.ts`: Chromium only, desktop viewport (1440×900, so the admin app
shows the full dashboard instead of its `/m` mobile-lite view), English locale,
serial execution, traces/screenshots/video retained on failure.
