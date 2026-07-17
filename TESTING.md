# UWC Fleet — Testing

Three test tiers, each with a clear job. The **unit** and **integration** tiers
run locally with one command each and are the day-to-day safety net; the
**browser E2E** tier is a smaller, manually-run set for genuine UI flows.

| Tier | Runner | Database | What it covers | Command |
| --- | --- | --- | --- | --- |
| **Unit** | vitest | none (pure) | scoring math, dispatch decisions, boundaries, CAS semantics, validation — pure functions | `npm test --workspace=api` |
| **Integration** | vitest + **supertest** | **Docker** test DB | full API flows: money finalize/ledger, dispatch orchestration, **real concurrency**, failure paths, full lifecycle | `npm run test:integration` |
| **Browser E2E** | Playwright | **Docker** test DB (via a locally-run API) | genuine per-role UI flows | see [`e2e/README.md`](e2e/README.md) |

Current counts: **unit 354 / 34 files**, **integration 45 / 8 files**. The unit
tier needs no Docker and is what `npm test` runs; integration and E2E run against
a **local, throwaway Docker Postgres** so destructive tests never touch prod.

## The Docker test database

A single `postgres:16-alpine` container (`docker-compose.test.yml`), data in
tmpfs (ephemeral), on host port **55432**. Credentials are trivial (`uwc/uwc`) —
local-only, disposable fixtures.

```bash
npm run test:db:up       # start + wait-healthy + migrate deploy + seed  (ONE command)
npm run test:integration # run the integration suite against it
npm run test:db:down     # stop + remove (discards all data)
```

Helpers:

```bash
npm run test:db:reset    # truncate transactional tables + restore trucks + re-seed fixtures (fast)
npm run test:db:seed     # re-run seed + seed-test only (idempotent)
npm run test:db:api      # run the API dev server pointed at the test DB (for local browser E2E)
```

`test:db:up` runs `prisma migrate deploy` (committed migrations only — never
`migrate dev`), then `prisma/seed.ts` (master data) + `prisma/seed-test.ts`
(the test requestor `+60199990001` and synthetic consignees a fresh DB lacks).

## Why this exists — the isolation hole it closes

`api/.env`'s `DATABASE_URL` points at the live Railway prod proxy, so a
locally-run API talks to **production** by default. The browser E2E suite drove
that prod-backed API, so "local" E2E silently read and mutated production
(`E2E_ALLOW_PROD` only guarded the *front-end URLs*). The Docker DB + `test:db:api`
give the local API a real, isolated database to talk to instead.

## Safety guards (why a test can't hit prod)

Destructive tests (they `TRUNCATE`) are gated at **three independent layers**,
each refusing any host that isn't `localhost`/`127.0.0.1`/`::1`/`0.0.0.0` (and
explicitly refusing Railway host markers):

1. **`scripts/test-db.mjs`** — the orchestrator aborts before spawning anything.
2. **`api/tests-integration/setup.ts`** — aborts the whole vitest suite before
   the app/Prisma modules load, so no connection is even opened. It also
   overrides `DATABASE_URL` to the Docker DB before anything imports Prisma
   (dotenv never overrides an already-set variable, so `api/.env`'s prod URL
   can't win).
3. **`api/prisma/reset-test.ts` (`assertLocalTestDb`)** — the truncate helper
   itself refuses, as defense-in-depth in the code path that does the deleting.

## Per-test isolation (integration)

`resetDb()` (harness `beforeEach`) does three things, keeping tests fast and
independent without re-seeding the whole DB:

1. `truncateTransactional` — wipe trips/stops/cargo/docs/leave/audit/logs (the
   transactional tables); master data (users, zones, rates, holidays) is kept.
2. `restoreTruckDefaults` — reset every truck's rates + document expiries to spec
   defaults (far-future expiries → roadworthy). Dispatch/guard tests legitimately
   mutate a truck's expiries/rates; this undoes that so it can't leak between
   tests (and undoes any drift a prior run left behind).
3. `ensureRequestor` + `ensureConsignees` — re-assert the test fixtures.

## What the integration tier covers (money-first)

| File | Focus |
| --- | --- |
| `money.test.ts` | per-zone-per-day ledger (RM44+RM11=RM55 through Postgres), midnight-straddle summation, rate-lock across a mid-day edit |
| `dispatch.test.ts` | cargo-estimate consequence (unsized → manual, not smallest truck), capacity boundaries, KL long-haul, candidate filtering |
| `guardLadder.test.ts` | manual-approve ladder — overload/leave not forcible, unroadworthy hard, permit/conflict forcible + audit rows |
| `concurrency.test.ts` | real Serializable→409 under contention — double-assign, one-active-trip, reassign-vs-start, leave collision, ticket race, cancel/reject-vs-claim |
| `arrivedGuard.test.ts` | the arrived guard + the outbox-critical `INVALID_STATUS`-before-`TRIP_NOT_STARTED` ordering |
| `failurePaths.test.ts` | duplicate-submission no-double-pay, expired-doc enforcement, consignee lock/dedupe, no-valid-truck, attention 3rd case |
| `lifecycle.test.ts` | one trip through the whole chain (book → assign → start → arrived → POD → delivered → completed → pay) across all three roles |
| `smoke.test.ts` | Phase 0 isolation proof (login → book → read back → row in Docker DB) |

## Open findings (surfaced by tests, NOT fixed — decide separately)

These are documented in the tests and were deliberately not changed (the
build-out adds tests only):

- **Ticket-number retry budget** (`concurrency.test.ts`): under >~4 truly-
  simultaneous same-day bookings, `TICKET_CREATE_RETRIES = 3` is exhausted and
  the losers return **500** (a raw `P2002`) instead of a graceful retry/409. **No
  duplicate is ever produced** — the `@unique` constraint holds; this is a
  robustness/UX limitation, not a correctness bug.
- **Payroll exact-tie ordering** (`payrollTie.test.ts`): `buildPayrollRows` is a
  stable sort with no secondary key, so a tie resolves to the caller's driver
  order — the route must supply a deterministic order for reproducible sheets.
- **2026 holiday dates** (`holidayCalendar.test.ts`): the Islamic (moon-sighting)
  dates are estimates locked for deliberate re-review vs the JAKIM gazette.

## Proposed follow-ups (not implemented)

- Factor a pure `assertStopArrivable(trip, stop)` mirroring `assertStopDeliverable`
  so the arrived-guard ordering can also be unit-tested without a DB.

## Layout

```
docker-compose.test.yml            # the test Postgres
scripts/test-db.mjs                # up / reset / seed / down / api orchestrator
api/vitest.config.ts               # unit config (tests/, no DB)
api/vitest.integration.config.ts   # integration config (tests-integration/, Docker DB)
api/prisma/seed-test.ts            # requestor + synthetic consignees (idempotent)
api/prisma/reset-test.ts           # transactional truncate + truck restore + fixtures
api/src/app.ts                     # the Express app (exported for supertest)
api/src/index.ts                   # listen() + background jobs entrypoint
api/tests-integration/
  setup.ts                         # env override + hard localhost guard
  helpers/harness.ts               # supertest client, prisma, resetDb, login helpers
  helpers/flow.ts                  # book/approve/start/arrive/deliver + raw variants
  *.test.ts                        # the integration suites (table above)
```

## Windows / PowerShell notes

- Use `npm run test:db:*` — the Node orchestrator injects `DATABASE_URL` into
  each child's environment, so you never need `$env:X=...` vs `X=... cmd`.
- Override the port/URL with `TEST_DATABASE_URL` before the command.
- Stop the API dev server before `test:db:up` if it's holding the Prisma engine
  DLL (a known Windows lock during migrate).
