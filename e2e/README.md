# UWC Fleet — End-to-End Tests (Playwright)

Browser end-to-end tests covering the three real user roles.

**Targets are env-driven** (`helpers/accounts.ts`) — the suite defaults to
**local dev servers** and refuses to touch the deployed Railway apps unless you
explicitly opt in:

| Env var | Effect |
| --- | --- |
| *(none)* | Local targets: API `localhost:3000`, admin `localhost:5173`, mobile web `localhost:8081` — start them yourself. |
| `E2E_ALLOW_PROD=1` | Targets the deployed Railway apps (post-deploy verification). Prints a loud warning. |
| `E2E_API_URL` / `E2E_ADMIN_URL` / `E2E_MOBILE_URL` | Explicit per-service overrides (e.g. staging). A Railway host still requires `E2E_ALLOW_PROD=1`. |
| `E2E_PASSWORD` | Account password override (default: the seeded `Password123`). Use after prod credentials are rotated. |

> ⚠ **The suite modifies real data on whatever backend it targets.** The
> per-spec reset cancels **every** pending/approved trip, completes the test
> driver's active trips with a stub POD photo, and the rate-reset spec edits a
> truck's rates. Never run it against production while the client trial has
> live work in flight — `E2E_ALLOW_PROD=1` is a conscious decision, not a
> default.

This folder is standalone (its own `package.json`, not part of the npm
workspace), so install its dependencies separately.

## Prerequisites

- Node 18+ (uses the global `fetch`).
- The seeded test accounts must exist in the target DB (they are created by
  `api/prisma/seed.ts` / kept by `seed-clean.ts`):

  | Role | Phone | Password |
  | --- | --- | --- |
  | Admin | `+60100000001` | `Password123` (or `E2E_PASSWORD`) |
  | Driver (PLX 2406) | `+60100000101` | `Password123` (or `E2E_PASSWORD`) |
  | Requestor | `+60199990001` | `Password123` (or `E2E_PASSWORD`) |

## Install

```bash
cd e2e
npm install
npm run install:browsers   # downloads Chromium for Playwright
```

## Run

```bash
npm test                 # headless, all specs — LOCAL targets by default
npm run test:headed      # watch it drive a real browser
npm run test:ui          # Playwright UI mode (pick/inspect tests)
npm run report           # open the HTML report from the last run

# single role
npm run test:requestor
npm run test:admin
npm run test:driver

# post-deploy verification against the live Railway apps (conscious opt-in;
# modifies real data — see the warning above)
E2E_ALLOW_PROD=1 npm test
```

On PowerShell, set the variable first: `$env:E2E_ALLOW_PROD = "1"; npm test`
(and `Remove-Item Env:E2E_ALLOW_PROD` afterwards).

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

## Database isolation — run the local API against the Docker test DB

> ⚠ **`E2E_ALLOW_PROD` only guards the front-end URLs, not the database.** A
> locally-run API reads `api/.env` → `DATABASE_URL` → the **live Railway prod
> DB**, so "local" targets still mutate production unless you repoint the API.

The sanctioned way to run this suite locally is against the throwaway Docker
Postgres (see the repo-root [`TESTING.md`](../TESTING.md)):

```bash
npm run test:db:up      # start + migrate + seed the Docker test DB (repo root)
npm run test:db:api     # run the API dev server pointed at the Docker test DB
# …start the admin + mobile web dev servers as usual, then:
cd e2e && npm test
```

`test:db:api` starts the same API dev server but with `DATABASE_URL` pointed at
`localhost:55432` (the Docker DB), so every trip the suite creates/cancels lands
in the disposable test database, never prod. When you're done:
`npm run test:db:down`.

## How isolation works

The apps share one backend, so the suite **does not** rely on test ordering.
Before each test, `helpers/reset.ts`:

1. sets dispatch mode back to **manual** (so freshly seeded trips stay pending),
2. **frees the driver** — any active trip for the test driver is driven to completion through
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
> `ALLOW_DESTRUCTIVE=1 npx tsx prisma/seed-clean.ts` in the `api` workspace —
> it refuses to run against the production DB host (see
> `api/prisma/destructive-guard.ts`).

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
