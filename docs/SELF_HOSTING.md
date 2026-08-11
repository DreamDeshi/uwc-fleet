# Running UWC Fleet on your own server

A deployment guide for UWC's IT team. Everything below was read out of this
repository rather than written from memory; where a figure is an estimate rather
than something measured, it says so.

The system today runs on Railway (hosting + managed PostgreSQL) with Cloudinary
for photo/document storage. Nothing in the code is Railway-specific except one
environment variable used for build stamping — the migration is mostly a matter
of providing the same things yourself.

---

## 1. What you are deploying

Three pieces:

| Piece | What it is | Repo folder |
|---|---|---|
| **API** | Node/Express + Prisma. All business logic, auth, money. | `api/` |
| **Web app** | The Expo app exported for browsers, served as static files. Used by office staff and as the driver fallback. | `mobile/` |
| **Database** | PostgreSQL 16. The only stateful component. | — |

The Android app is a separate artifact (section 9). It is **not** served from
your server — it is an APK installed on drivers' phones that talks to your API
over HTTPS.

---

## 2. Server requirements

### Software

| | Version | Why this version |
|---|---|---|
| **Node.js** | **20.x** | CI pins `node-version: "20"` across all jobs; `mobile/package.json` declares `"node": ">=20.19.4"`. Node 22 is untested here. |
| **PostgreSQL** | **16** | `docker-compose.test.yml` uses `postgres:16-alpine` with the comment "matches Railway's PostgreSQL 16"; CI uses `postgres:16`. |
| **OS** | Any Linux with the above | Developed on Windows, built and run on Linux containers. Ubuntu 22.04 or 24.04 LTS is the safe choice. |

No native build toolchain is needed at runtime. `bcrypt` is a native module, so
the **build** machine needs a C++ toolchain (`build-essential`, `python3`) —
or install from a prebuilt binary, which is the default behaviour.

### Sizing

⚠ **These are estimates.** I have not load-tested this deployment, and UWC's
real traffic is a handful of office staff plus 6–8 drivers.

| Resource | Suggested | Reasoning |
|---|---|---|
| **API RAM** | 1 GB (512 MB workable) | A single Node process, no in-memory caching layer, uploads streamed through `multer` memory storage — so peak is driven by concurrent upload size, not dataset size. |
| **Web RAM** | 256 MB | `serve.mjs` is a zero-dependency static file server. |
| **DB RAM** | 1–2 GB | 25 tables, ~1,600 consignees, and trip volume in the tens per day. |
| **Disk (DB)** | 20 GB | Vastly more than the data needs; sized for WAL, backups and years of growth. |
| **Disk (app)** | 5 GB | `node_modules` for both workspaces plus build output. |
| **CPU** | 2 vCPU | Comfortable for build and run. |

**The only axis that grows without bound is media storage** (POD photos, K2
documents, exception evidence) — see section 8. Database growth is modest: trips
and their child rows.

### Network

- One **HTTPS** endpoint for the API and one for the web app. They can be
  separate hostnames or the same host on different paths behind a reverse proxy.
- The API sets `app.set("trust proxy", 1)` — it expects **exactly one** reverse
  proxy hop (nginx/Caddy/ALB). If you chain two proxies, rate limiting will key
  on the wrong IP.
- Outbound HTTPS from the API to: Cloudinary, `exp.host` (push), Google Maps
  (geocoding), and Sentry if enabled.

---

## 3. External services you must provide

| Service | Currently | Needed for | Can you drop it? |
|---|---|---|---|
| **PostgreSQL 16** | Railway managed | Everything | No |
| **Media storage** | Cloudinary | POD photos, K2 docs, exception evidence, feedback images | No — but replaceable, see §8 |
| **Google Maps Platform** | Google Cloud | Server-side geocoding of consignee addresses; map rendering in the Android app | Partially — geocoding is a one-off/occasional batch job |
| **Expo push (`exp.host`)** | Expo | Push notifications to drivers and admins | Only by replacing with raw FCM (code change) |
| **Expo EAS** | Expo | Building the APK and shipping OTA JS updates | Only by building Android locally, see §9 |
| **Sentry** | Optional | Error reporting | Yes — no-ops without a DSN |

---

## 4. Environment variables

Set on the **API** service unless stated. The API reads `api/.env` in
development; in production use your process manager's environment.

### Required — the API will not work without these

| Variable | What it is |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string, e.g. `postgresql://user:pass@host:5432/uwc?schema=public`. |
| `JWT_ACCESS_SECRET` | Signing key for access tokens. `lib/jwt.ts` throws `Missing required env var` at first use if absent. Generate a long random string. |
| `JWT_REFRESH_SECRET` | Signing key for refresh tokens. Same, and must be **different** from the access secret. |
| `NODE_ENV=production` | ⚠ **Load-bearing — see the warning below.** |

> ### ⚠ Without `NODE_ENV=production` the API refuses to start
>
> `src/index.ts` runs a safety check on boot: unless it detects a deployed
> runtime, it asserts `DATABASE_URL` points at **localhost** and calls
> `process.exit(1)` if not. This exists so a developer's `npm run dev` can never
> hit the live database.
>
> `isDeployedRuntime()` (`src/lib/dbGuard.ts`) returns true if any `RAILWAY_*`
> variable is present **or** `NODE_ENV === "production"`. Off Railway, only the
> second applies. So on your server: **set `NODE_ENV=production`**, or the API
> will exit with "DATABASE_URL points at a NON-LOCAL database".
>
> The escape hatch `ALLOW_REMOTE_DB=1` also works, but `NODE_ENV=production` is
> the correct setting for a production box.

### Required for file uploads

Uploads throw a clear error if these are missing; the rest of the app works.

| Variable | What it is |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account identifier. |
| `CLOUDINARY_API_KEY` | API key. |
| `CLOUDINARY_API_SECRET` | API secret. **Secret** — this signs private delivery URLs. |

### Strongly recommended

| Variable | Default | What it is |
|---|---|---|
| `CORS_ORIGIN` | `http://localhost:8081` | Comma-separated allowlist of browser origins. **Set this to your web app's URL** or the browser app cannot call the API. |
| `PORT` | `3000` | API listen port. |
| `PUBLIC_BASE_URL` | derived from the request | Base URL used to build public trip-tracking links. Set it explicitly so links are correct behind a proxy. |
| `TRACKING_SECRET` | falls back to `JWT_ACCESS_SECRET` | HMAC key for public tracking tokens. Setting a dedicated one is cleaner. |
| `EXPO_ACCESS_TOKEN` | none | Bearer token for Expo's push API. Optional today; Expo can enforce it per project, at which point push silently stops without it. |
| `GOOGLE_MAPS_KEY` *(or `GOOGLE_MAPS_API_KEY`)* | none | Server-side geocoding of consignee addresses. |

### Optional — tuning and features

| Variable | Default | What it is |
|---|---|---|
| `JWT_ACCESS_EXPIRY` | `30m` | Access token lifetime. Note: role is carried in the token, so a demoted admin keeps access until it expires. |
| `JWT_REFRESH_EXPIRY` | `7d` | Refresh token lifetime. |
| `RATE_LIMIT_MAX` | `300` | Requests/minute **per user** (per IP when unauthenticated). `0` disables — testing only. Invalid values keep the default so a typo cannot weaken it. |
| `SENSITIVE_RATE_LIMIT_MAX` | `10` | Requests/minute for auth endpoints (login etc.). **`RATE_LIMIT_MAX=0` does not disable this one.** |
| `LOGIN_LOCKOUT_MAX_ATTEMPTS` | `10` | Failed sign-ins before a single **account** is locked. The two limiters above throttle a *caller*; this protects one phone against a slow, patient guesser, which a per-minute cap never sees. `0` disables — **neither limiter variable disables it.** |
| `LOGIN_LOCKOUT_MINUTES` | `15` | How long a lock lasts. It then expires by itself; an admin can also end one early from the Users screen. |
| `FEATURE_EXCEPTIONS` | off | Driver "cannot deliver" exception workflow. Built and merged but **dark** — do not enable without the owner's sign-off. |
| `FEATURE_CHANGE_REQUESTS` | off | Requestor booking amendments. Same — built, dark, owner-gated. |
| `DOC_EXPIRY_REMIND_DAYS` | see code | How far ahead truck document expiry reminders fire. |
| `FUEL_CO2E_KG_PER_LITRE` | see code | Emissions factor for the sustainability report. |
| `OP_DRIVE_POINTS_BASELINE` | see code | Operating-window drive-points baseline. |
| `GPS_VENDOR_API_KEY` | none | Shared key for the third-party GPS hardware ingest endpoint. |
| `CLOUDINARY_POD_URL_TTL_SECONDS` | see code | Lifetime of signed POD photo URLs. |
| `CLOUDINARY_POD_TOKEN_KEY` | none | Key for Cloudinary token-based delivery, if used. |
| `SENTRY_DSN` | none | Enables error reporting. Absent = Sentry no-ops entirely. |
| `SENTRY_ENVIRONMENT` | `NODE_ENV` | Environment label in Sentry. |
| `UWC_SPEC_PATH` | `docs/uwc-spec.json` | Override the authoritative spec file location. |

### Railway-injected — you must replace one

| Variable | Consequence off Railway |
|---|---|
| `RAILWAY_GIT_COMMIT_SHA` | Feeds `GET /api/v1/health` → `release`, and the Sentry release tag. Without it `/health` returns `"release": null` and you lose the ability to confirm *which build* is running. **Set this yourself at deploy time** to the deployed git SHA. |
| `RAILWAY_ENVIRONMENT` / `_PROJECT_ID` / `_SERVICE_ID` | Only used as deployed-runtime signals — covered by `NODE_ENV=production`. |

### Web app

| Variable | What it is |
|---|---|
| `PORT` | Port for `serve.mjs`. Default `4173`. |

⚠ The web app's **API URL is not an environment variable at runtime.** It is
baked into the JS bundle at build time from `mobile/app.json` → `expo.extra.apiUrl`.
See section 9.

### Operational scripts only

Never set these as service environment variables — they are safety opt-ins for
one-off maintenance commands, and several are destructive:
`ALLOW_PROD_ROTATE`, `ROTATE_PASSWORDS`, `ROTATE_INVALIDATE`,
`ALLOW_BREAK_GLASS`, `BREAK_GLASS_PHONE`, `BREAK_GLASS_PASSWORD`,
`BREAK_GLASS_NAME`, `ALLOW_DESTRUCTIVE`, `ALLOW_TRIP_WIPE`, `CONFIRM_WIPE_HOST`,
`EXPECT_TRIPS`, `ALLOW_ASSET_PURGE`, `EXPECT_ORPHANS`, `APPLY`,
`E2E_STUB_UPLOADS`.

⚠ `E2E_STUB_UPLOADS` fakes all uploads. If it is ever set in production, POD
photos are silently discarded and pay evidence is lost.

---

## 5. Database setup and migrations

1. Create a database and a user with ownership of it:

   ```sql
   CREATE DATABASE uwc;
   CREATE USER uwc_app WITH PASSWORD '...';
   GRANT ALL PRIVILEGES ON DATABASE uwc TO uwc_app;
   ALTER DATABASE uwc OWNER TO uwc_app;   -- see the warning below
   ```

   The Prisma migrations create tables, enums, indexes and constraints, so the
   user needs DDL rights on the schema.

   > ### ⚠ On PostgreSQL 15 and later, the `GRANT` alone is not enough
   >
   > `GRANT ALL PRIVILEGES ON DATABASE` confers CONNECT, TEMP and the right to
   > create *new* schemas — it does **not** confer `CREATE` on the existing
   > `public` schema. PostgreSQL 15 revoked that from `PUBLIC`, and 16 keeps it.
   >
   > Without the `ALTER DATABASE ... OWNER` line above, `migrate deploy` fails on
   > its first statement with **`permission denied for schema public`**.
   >
   > `GRANT ALL ON SCHEMA public TO uwc_app;` is an equivalent fix if you would
   > rather not transfer database ownership.

2. Apply the schema — **41 migrations** currently:

   ```bash
   cd api
   npm run migrate:deploy      # prisma migrate deploy
   ```

   `migrate deploy` only applies pending migrations and never resets data. It is
   safe to re-run and is the correct command for production.

   ⚠ Never use `prisma migrate dev` against a real database — it can reset.

3. Seed master data (trucks, zones, rates, route types, departments, holidays,
   consignees, bootstrap admin):

   ```bash
   npm run seed
   ```

   The seed uses upserts with `update: {}`, so it is idempotent and will not
   overwrite a rotated password or edited rate on re-run.

⚠ **Seeded accounts ship with a well-known default password.** Rotate every
account before go-live using `api/prisma/rotate-passwords.ts`, and confirm with
the owner what the current credential policy is — it has changed more than once.

### Migrating the existing data

Take a dump from the current Railway database and restore it into yours:

```bash
pg_dump --format=custom --no-owner --no-acl "$RAILWAY_DATABASE_URL" > uwc.dump
pg_restore --no-owner --no-acl --dbname="$NEW_DATABASE_URL" uwc.dump
```

Then run `npm run migrate:deploy` to confirm the schema is current. `--no-owner`
matters because the role names will differ between the two servers.

⚠ **The database dump does not include the media.** POD photos and documents
live in Cloudinary and are referenced by URL/public-id from the database rows.
Moving the database without moving the media leaves every photo link broken —
see section 8.

---

## 6. Build and start

### API

```bash
cd api
npm ci
npm run build          # prisma generate && tsc  → dist/
npm run migrate:deploy # run BEFORE starting the new build
npm start              # node dist/index.js
```

`prisma generate` is part of `build` and must run on the deployment machine —
the generated client is platform-specific.

### Web app

```bash
cd mobile
npm ci
npm run build:web      # expo export --platform web → dist/
npm run serve          # node serve.mjs  (PORT, default 4173)
```

### Process management

Use systemd, PM2 or a container runtime. The current setup restarts on failure
with a retry cap; replicate that. The API handles `SIGTERM`/`SIGINT` cleanly
(it flushes Sentry then exits), so ordinary restarts are safe.

> ### ⚠ Run exactly ONE API instance
>
> Five background jobs run **in-process** via `setInterval`, started in
> `src/index.ts` when the server begins listening:
>
> - pending-trip alerts (bookings idle 15+ min)
> - rate maturation (next-day rate edits taking effect)
> - stale-ticket sweep (**03:00 MYT** — auto-cancels prior-day undelivered trips)
> - document expiry reminders (**09:00 MYT**)
> - exception alerts (no-op while `FEATURE_EXCEPTIONS` is off)
>
> There is no distributed lock. **Two instances = every sweep runs twice**, which
> means duplicate admin notifications and a stale-ticket sweep cancelling trips
> twice. If you need redundancy, run one instance and rely on fast restart, or
> add a lock before scaling horizontally.
>
> A corollary: you do **not** need external cron. The jobs are self-scheduling.

### Timezone

The business day is Malaysia time (MYT) — the 03:00 sweep, day-keys and rate
tiers are all MYT concepts. **Set `TZ=Asia/Kuala_Lumpur`** on the API host.

⚠ I have not verified every date path against a non-MYT server clock, and a
timezone-band bug has been seen in this codebase's test suite before. Setting
the host timezone to MYT keeps you on the path that is actually exercised.

---

## 7. Replacing what Railway provides

| Railway gives you | Replace with |
|---|---|
| Container hosting + restart policy | systemd / PM2 / Docker + your orchestrator |
| Managed PostgreSQL 16 | Your own PostgreSQL 16 — **plus a backup schedule you test restoring from** |
| TLS termination + a public domain | nginx/Caddy + certbot, or your load balancer |
| Private service networking | Keep the DB on a private interface; do not expose 5432 publicly |
| Environment variable storage | Your secret store; keep secrets out of the repo and off command lines |
| Deploy on git push | Your CI, or a documented manual sequence: `npm ci → build → migrate:deploy → restart` |
| `RAILWAY_GIT_COMMIT_SHA` | Export the git SHA at deploy time (see §4) |

Nothing else in the codebase depends on Railway. The `railway.json` files simply
declare the same build/start commands listed in section 6.

**Backups are the important one.** Railway's managed database is doing this for
you today. At minimum: nightly `pg_dump`, stored off-box, with a restore you
have actually performed at least once.

---

## 8. Replacing Cloudinary

This is the biggest piece of work in a migration, and worth understanding before
committing to it.

### What Cloudinary is doing today

1. **Storage** for POD photos, K2 documents, exception evidence, feedback images
   — organised into folders such as `uwc/pod` and `uwc/documents`.
2. **Private assets.** POD photos are uploaded with `type: "authenticated"`, so
   their plain URL returns 401. They are delivered only through **short-lived
   server-signed URLs** (`api/src/lib/podPhotos.ts`). This is a deliberate
   privacy control — POD photos can show customer premises and signatures.
3. **CDN delivery and transformation** — format/quality optimisation on read.
4. **Mixed asset types.** Documents upload with `resource_type: "auto"`, so
   Cloudinary decides `image` vs `raw`, and the stored value is needed to sign
   the delivery URL correctly.

### If you replace it

The seams are `api/src/lib/cloudinary.ts` (upload) and `api/src/lib/podPhotos.ts`
(signed delivery). A replacement must provide:

- object storage — **S3, MinIO, or similar**
- **presigned, expiring URLs** for private objects (S3 presigned GET is a direct
  equivalent)
- a migration of existing objects, **and** a rewrite of the stored
  URLs/public-ids in `TripDocument` and related rows

⚠ **A known trap, already hit once here:** a PDF stored with an image resource
type will be transformed as an image, and format-auto delivery keeps only
**page one**. Any replacement must branch on the real file format, not assume
images.

⚠ Media is the only storage that grows without bound. Whatever you move to,
plan for accumulation — and note that deleting a database row does **not**
delete the stored object.

**Recommendation:** migrate hosting and the database first, leave Cloudinary in
place, and treat storage replacement as a separate project. The two changes have
independent risk and there is no benefit to coupling them.

### If UWC's server provides storage only, not application hosting

A reasonable middle path is to leave the application where it is and move only
the media and the backups onto UWC storage. **Backups work in that arrangement
unconditionally** — a nightly `pg_dump` is a one-way write with no latency or
reachability constraint, and putting it on UWC-controlled storage is a straight
improvement.

**Media is conditional, and these are the two questions to answer first:**

1. **Is the storage reachable from the application host over the public
   internet, on HTTPS?** The API writes every upload and the phones read every
   photo back — both from outside UWC's network, on mobile data. Storage that
   lives behind the corporate firewall (an SMB/NFS share, a NAS appliance) is
   not reachable from a cloud-hosted API, and no amount of application change
   makes it so. If the answer is no, media cannot move while the application is
   hosted externally. This question gates everything else.

2. **Is it S3-compatible?** If yes (MinIO, Ceph, StorageGRID, ECS and similar),
   presigned expiring URLs map directly onto what §8 describes and the change is
   contained to the two seams above. If it is plain file storage with no
   presigned-URL support, the API has to stream the bytes itself on every read —
   which works, but adds bandwidth and latency on the application host and gives
   up CDN delivery.

⚠ Note what a media-only move does **not** achieve. The database holds consignee
names, addresses, phone numbers, driver identities and GPS traces. If the goal
is for UWC's own data to sit on UWC's own infrastructure, moving the photos while
the database stays hosted externally addresses the smaller half of that.

---

## 9. The mobile app

Moving the server does **not** move the app. Both the web bundle and the Android
APK bake the API URL in at build time.

### Web app

`mobile/app.json` → `expo.extra.apiUrl` is inlined into the JS bundle by
`expo export`. To point the web app at your API:

1. Set `expo.extra.apiUrl` to your API's public HTTPS URL.
2. Rebuild: `npm run build:web`.
3. Add that web origin to the API's `CORS_ORIGIN`.

⚠ The bundle is cached aggressively. If a rebuild appears not to have taken
effect, rebuild with `--clear` before concluding the change failed.

### Android APK

The installed APK also has the old API URL compiled in, so **drivers need a new
APK.** It is built today with Expo EAS. Options:

- **Keep EAS** — simplest; requires an Expo account. Change `apiUrl`, rebuild,
  redistribute.
- **Build locally** — `expo prebuild` then Gradle. This needs Android SDK and a
  signing keystore, and you must reuse the **same keystore**, or the new APK
  cannot install over the old one and the Google Maps key restriction (tied to
  the signing certificate's SHA-1) stops matching.

### Over-the-air updates

JS-only changes currently ship via EAS Update without a reinstall. If you leave
Expo, you lose that channel: every change becomes a full APK redistribution to
every driver. Self-hosting the update protocol is possible but is its own
project.

### Google Maps

The Android app's Maps key is restricted to the app's package name and signing
SHA-1. A new keystore means updating that restriction, or maps render blank with
no visible error.

---

## 10. Verifying a deployment

```bash
curl https://<your-api>/api/v1/health
# {"status":"ok","release":"<git sha>"}
```

- `status: ok` means the process is up **and** the database answered.
- `release` should equal the SHA you deployed. If it is `null`, you have not set
  `RAILWAY_GIT_COMMIT_SHA` (§4).
- ⚠ Health can report the **previous** build for up to a minute after a restart.
  Compare the value; do not assume.

Then, end to end: log in as an admin on the web app, create a booking, and
confirm it appears. That exercises auth, the database and CORS in one pass.

---

## 11. What this guide does not cover

Stated plainly so nobody is caught out:

- **No load testing has been done.** The sizing in §2 is reasoned from the
  architecture and UWC's user count, not measured.
- **Non-MYT server clocks are unverified** (§6).
- **No high-availability story.** The single-instance constraint in §6 is real;
  multi-instance needs a distributed lock for the sweeps.
- **The storage replacement in §8 is scoped, not designed.** Presigned URLs,
  object migration and the database URL rewrite each need their own plan.
- **Restoring a database backup into a fresh server has not been rehearsed
  end-to-end as part of writing this.** Do it once before you rely on it.
