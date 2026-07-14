# UWC Fleet — Testing

Three test tiers, each with a clear job:

| Tier | Runner | Database | What it covers | Command |
| --- | --- | --- | --- | --- |
| **Unit** | vitest | none (pure) | scoring math, dispatch decisions, CAS semantics, validation — pure functions, data in → result out | `npm test --workspace=api` |
| **Integration** | vitest + supertest | **Docker** test DB | full API flows: money finalize/ledger, dispatch orchestration, concurrency, failure paths — the real Express app against a real Postgres | `npm run test:integration` |
| **E2E** | Playwright | **Docker** test DB (via a locally-run API) | genuine per-role browser flows | see [`e2e/README.md`](e2e/README.md) |

The unit tier needs no Docker and stays fast; it is what `npm test` runs. The
integration and e2e tiers run against a **local, throwaway Docker Postgres** so
destructive tests never touch the live Railway production database.

## The Docker test database

A single `postgres:16-alpine` container (see `docker-compose.test.yml`), data in
tmpfs (ephemeral, RAM-backed), published on host port **55432**. Credentials are
intentionally trivial (`uwc/uwc`) — it is local-only and holds only disposable
fixtures.

```bash
npm run test:db:up      # start + wait-healthy + migrate deploy + seed (ONE command)
npm run test:integration # run the integration suite against it
npm run test:db:down    # stop + remove (discards all data)
```

Other helpers:

```bash
npm run test:db:reset   # truncate transactional tables + re-seed fixtures (fast, no restart)
npm run test:db:seed    # re-run seed + seed-test only (idempotent)
npm run test:db:api     # run the API dev server pointed at the test DB (for local e2e)
```

`test:db:up` runs `prisma migrate deploy` (committed migrations only — never
`migrate dev`), then `prisma/seed.ts` (master data) and `prisma/seed-test.ts`.
The latter adds the two things a fresh DB lacks: the **test requestor**
(`+60199990001`) and a small set of **synthetic consignees** across the real
zones (the real consignee list is an NDA Excel that is gitignored/absent on a
clean checkout).

## Why this exists — the isolation hole it closes

`api/.env` points `DATABASE_URL` at the live Railway prod proxy. A locally-run
API therefore talks to **production** by default. The old Playwright e2e suite
defaulted to "local" front-end targets but drove that prod-backed API, so
"local" e2e silently read and mutated production. (`E2E_ALLOW_PROD` only guarded
the front-end URLs — it gave false safety about the database.)

The Docker DB + `test:db:api` give the local API a real, isolated database to
talk to instead.

## Safety guards (why a test can't hit prod)

Destructive tests (they `TRUNCATE`) are gated at **three independent layers**,
each refusing any host that isn't `localhost`/`127.0.0.1`/`::1`/`0.0.0.0` (and
explicitly refusing Railway host markers):

1. **`scripts/test-db.mjs`** — the orchestrator aborts before spawning anything.
2. **`api/tests-integration/setup.ts`** — aborts the whole vitest suite before
   the app/Prisma modules load, so no connection is even opened.
3. **`api/prisma/reset-test.ts` (`assertLocalTestDb`)** — the truncate helper
   itself refuses, as defense-in-depth in the code path that does the deleting.

The integration setup also **overrides** `DATABASE_URL` to the Docker DB before
anything imports Prisma — dotenv never overrides an already-set variable, so
`api/.env`'s prod URL can't win.

## Layout

```
docker-compose.test.yml            # the test Postgres
scripts/test-db.mjs                # up / reset / seed / down / api orchestrator
api/vitest.config.ts               # unit config (tests/, no DB)
api/vitest.integration.config.ts   # integration config (tests-integration/, Docker DB)
api/prisma/seed-test.ts            # requestor + synthetic consignees (idempotent)
api/prisma/reset-test.ts           # transactional truncate + fixture re-ensure
api/src/app.ts                     # the Express app (exported for supertest)
api/src/index.ts                   # listen() + background jobs entrypoint
api/tests-integration/
  setup.ts                         # env override + hard localhost guard
  helpers/harness.ts               # supertest client, prisma, resetDb, login helpers
  smoke.test.ts                    # Phase 0 isolation smoke test
```

## Windows / PowerShell notes

- Use `npm run test:db:*` — the Node orchestrator injects `DATABASE_URL` into
  each child's environment, so you never need `$env:X=...` vs `X=... cmd`.
- To override the port/URL: `$env:TEST_DATABASE_URL="postgresql://…"` before the
  command (PowerShell), or `TEST_DATABASE_URL=… npm run …` (bash).
- Stop the API dev server before `test:db:up` if it's holding the Prisma engine
  DLL (a known Windows lock during migrate/generate).
