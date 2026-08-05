# UWC Fleet

A trucking and delivery management system: bookings come in from office staff,
get dispatched to trucks and drivers, and are tracked through to proof of
delivery and driver incentive calculation.

Built as a final year project for UWC Berhad, a Malaysian logistics operation.

---

## What it does

A delivery starts as a **booking** — a requestor says what needs to go where.
An admin approves it and it becomes a **trip** assigned to a truck and driver,
either manually or by automatic dispatch based on cargo size and truck capacity.

The driver works the trip from their phone: sees the stop list, navigates to each
consignee, and confirms each delivery with a photo. The photo is required — a
stop cannot be marked delivered without one, because it is the evidence the
driver's pay is calculated from.

When the trip completes, the system scores it: distance-based rates, a
zone-based incentive scheme, fuel and expense deductions. Admins review and
approve, and the result feeds a payroll export.

Around that core: live truck tracking on a map, customs document handling for
the routes that need it, truck document expiry reminders, a public tracking link
for customers, and reporting.

## Who uses it

| Role | Uses | What they do |
|---|---|---|
| **Requestor** | Phone or browser | Raises booking requests, uploads delivery orders and invoices, tracks their own jobs. |
| **Driver** | Android app or browser | Receives assigned trips, navigates stop to stop, captures proof-of-delivery photos, logs fuel and expenses. |
| **Admin** | Browser (desktop layout) | Approves bookings, dispatches trucks, reviews delivery evidence, approves incentives, exports payroll, manages fleet and users. |

All three are the same codebase — one Expo application that runs as a native
Android app and in the browser, with the interface adapting per role.

## Tech stack

**API** — Node.js 20, Express, TypeScript, Prisma ORM, PostgreSQL 16.
JWT authentication with refresh tokens, Zod validation, bcrypt, Helmet,
per-user rate limiting. Cloudinary for private photo and document storage,
served through short-lived signed URLs. Sentry for error reporting (optional).

**Client** — React Native with Expo, running on Android and on the web from the
same source. React Navigation, TanStack Query, Axios, i18next for English,
Bahasa Malaysia and Chinese. Maps are `react-native-maps` on Android and Leaflet
with OpenStreetMap tiles on the web.

**Testing** — Vitest for unit and integration tiers, Supertest for API flows,
Playwright for browser end-to-end. Integration and E2E run against a disposable
Docker PostgreSQL, never a live database.

**Infrastructure** — currently Railway for hosting and managed PostgreSQL, with
Expo EAS for Android builds and over-the-air JavaScript updates.

## Running locally

**Prerequisites:** Node.js 20.x and Docker (for the local database).

```bash
git clone https://github.com/DreamDeshi/uwc-fleet.git
cd uwc-fleet
npm ci                          # installs both workspaces
```

Create the API environment file and fill in the blanks:

```bash
cp api/.env.example api/.env
```

At minimum set `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to two different
random strings. The Cloudinary values are only needed if you want to exercise
photo uploads; the rest of the application runs without them.

Start the database — one command brings up a `postgres:16-alpine` container on
port 55432, applies the migrations and seeds master data:

```bash
npm run test:db:up
```

Then the API and the client, in separate terminals:

```bash
npm run dev:api                 # http://localhost:3000
npm start --workspace=mobile    # Expo — press w for the browser
```

The default `api/.env.example` already points `DATABASE_URL` at that local
container. The API refuses to start against a non-local database unless it is
explicitly running in a deployed environment, so a local run cannot reach
production by accident.

### Tests

```bash
npm test --workspace=api        # unit tier, no database needed
npm run test:integration        # integration tier, needs the Docker database
```

See [TESTING.md](TESTING.md) for the full picture, including the browser E2E
tier.

## Documentation

| Document | What it covers |
|---|---|
| [TESTING.md](TESTING.md) | The three test tiers, the Docker test database, how to run each. |
| [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) | Deploying the system on your own server: requirements, environment variables, migrations, and what replacing each hosted service involves. |
| [docs/HOSTING_INTAKE.md](docs/HOSTING_INTAKE.md) | The questions to settle with an IT team before a hosting migration, and what each answer implies. |
| [docs/CODE_NAVIGATION.md](docs/CODE_NAVIGATION.md) | A map of the codebase — where each feature lives. |
| [docs/CONFORMANCE_REPORT.md](docs/CONFORMANCE_REPORT.md) | Incentive and dispatch behaviour, generated from the live engines and pinned by an automated suite. |
| [docs/CONSOLIDATION_DESIGN.md](docs/CONSOLIDATION_DESIGN.md) | Design notes for multi-booking consolidation. Design only — not built. |
| [docs/TIMELINE_TEST_GUIDE.md](docs/TIMELINE_TEST_GUIDE.md) | Manual test script for the trip status timeline. |
| [e2e/README.md](e2e/README.md) | Running the Playwright browser suite. |
| [mobile/README.md](mobile/README.md) | Client application detail. |

`AGENTS.md` holds the working conventions for this repository.

## Repository layout

```
api/          Express + Prisma backend, database schema and migrations
mobile/       Expo client — Android app, web build, admin interface
e2e/          Playwright browser tests
docs/         Documentation
scripts/      Local development helpers
```

## Status

Functionally complete and deployed, in acceptance testing with the client.
Some features are built but held behind environment flags pending sign-off.
