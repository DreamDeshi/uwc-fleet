# UWC Fleet — Code Navigation Guide

> Read-only map of the codebase for the technical review. Every path below was verified against the repo on 2026-07-03. Paths are relative to the repo root; nothing in this doc changes behaviour.

---

## 1. Architecture Overview

One monorepo, two independently deployed Railway services (auto-deploy from GitHub `main`, filtered by per-service watch paths: a push deploys only the services whose directory changed, plus both if the root `package.json`/`package-lock.json` changed):

| Service | Path | Stack | Live URL |
|---|---|---|---|
| **API** | `api/` | Node.js + Express + TypeScript + Prisma + PostgreSQL | `uwc-api-production.up.railway.app` |
| **Mobile (driver + requestor + admin)** | `mobile/` | React Native + Expo SDK 54, also exported as a web app | `uwc-mobile-production.up.railway.app` |

> The legacy Vite admin (`admin/`, `uwc-admin-production`) was retired 2026-07-16; the admin screens now live inside the Expo app (`mobile/src/admin/`), role-routed at login.

```
 mobile (RN/Expo web, incl. admin)  ── HTTPS/JSON ──►  api (Express, /api/v1)  ──► Prisma ──► Railway PostgreSQL
                                                        │
                                                        ├──► Cloudinary  (POD photos / documents)
                                                        └──► Expo Push   (notifications, direct HTTP)
```

- Clients never touch the DB — all business logic and authorization live in the API (three-tier).
- **API entry point:** `api/src/index.ts` — helmet, CORS allowlist (`CORS_ORIGIN`), rate limit (100 req/min/IP), `trust proxy` for Railway, mounts every router under `/api/v1`, global `errorHandler`, and starts the pending-trip background sweep (`startPendingTripAlerts`).
- All time-sensitive logic is in **MYT (UTC+8) explicitly** (`api/src/lib/myt.ts`), never server-local time.
- There is **no Swagger/OpenAPI page mounted** — the route files (Section 3) are the API reference.

---

## 2. Database

- **Schema:** `api/prisma/schema.prisma` — 20 models, PostgreSQL, money is always `Decimal` (never `Float`).
- **Migrations:** `api/prisma/migrations/` — 11 SQL migrations, from `20260623123304_init` to `20260702200000_dedupe_destination_rates` (includes `rate_lock_snapshots`, `public_holiday_calendar`, `driver_leave_calendar`).
- **Seeds:** `api/prisma/seed.ts` (full seed; reads `docs/uwc-spec.json` + the gitignored NDA consignee Excel + private driver-name overlay) · `seed-clean.ts` (reset to blank operational slate) · `seed-demo-trips.ts` (5 demo trips) · `seed-jh-sl-zones.ts` (KL/JH/SL extension zones).

| Model | Purpose | Key relations |
|---|---|---|
| `User` | All 3 roles (admin/driver/requestor); phone = login ID; account `status` gate | → Department, → assigned `Truck` (1:1 for drivers) |
| `Truck` | 7-truck fleet: capacity, weekday/off-peak claim rates, daily deduction, priority zones, doc expiries, operating hours | ← User (driver), ← Trip |
| `Zone` | P1/P2/P3/K1/K2/A1/A2 + KL/JH/SL; adjacency via implicit self-relation join table (`ZoneAdjacency`) | ← Consignee, ← DestinationRate |
| `RouteType` | The 6 route types (Customer/Supplier/Inter-Plant × Delivery/Return) | ← Trip |
| `DestinationRate` | Zone → incentive points table (11 bookable destinations) | → Zone |
| `Trip` | A booking through its lifecycle (`pending → approved/assigned → in_progress → completed`); holds `incentive_earned` (per-trip **marginal**) + **rate-lock snapshot** columns + `auto_dispatch_failed` flag | → requestor/driver (User), → Truck, → RouteType |
| `TripStop` | One delivery stop: sequence, arrived/delivered timestamps, **POD photo URL**, K2 form ack, snapshotted `zone_points` | → Trip, → Consignee |
| `CargoDetail` | Pallet size/qty/cartons per trip (capacity counted in 4×4-pallet units) | → Trip |
| `TripDocument` | Requestor-uploaded booking documents (Cloudinary URLs) | → Trip |
| `Consignee` | Customer/consignee master (~1.5k real NDA records); requestors can self-add | → Zone, → created-by User |
| `LocationLog` | GPS pings: lat/lng/recorded_at per trip+driver; indexed `(trip_id, recorded_at)` | → Trip, → User |
| `PublicHoliday` | Admin-managed holiday calendar (MYT `"YYYY-MM-DD"` strings) → off-peak rate decision | standalone |
| `DriverLeave` | Per-driver inclusive leave date ranges → dispatch availability (not login) | → User |
| `TripStatusHistory` | Append-only lifecycle log backing the status timeline; doubles as audit evidence | → Trip |
| `AuditLog` | Who did what to which table/record (sensitive mutations) | → User |
| `ExternalForwarder` | Outsourced-trip details (company/date/rate) | → Trip (1:1) |
| `VehicleMaintenance` / `FuelLog` | Service history / fuel tracking (FR-CT5) | → Truck (+ driver) |
| `AppSetting` | Single-row (`id="singleton"`): Manual vs Fully-Automatic dispatch toggle | standalone |
| `Department` | The 15 UWC departments (registration requires one) | ← User |

---

## 3. API Routes

All routers live in `api/src/routes/` and mount under `/api/v1` (see `api/src/index.ts:55-73`). Guard column = middleware actually applied (verified). `GET /api/v1/health` is public.

**Middleware:** `api/src/middleware/auth.ts` (`requireAuth` — verifies JWT **and re-checks account status is `active` on every request**) · `roleGuard.ts` (`requireRole(...)`) · `validate.ts` (Zod `validateBody` on every mutating endpoint) · `errorHandler.ts` (uniform `{ error: { code, message } }` shape via `lib/apiError.ts`).

### auth — `api/src/routes/auth.ts`
| Endpoint | Guard | Purpose |
|---|---|---|
| `POST /auth/register` | public | Register (department + employee no. required) → `pending_approval` |
| `POST /auth/login` | public | Phone + password → access (30m) + refresh (7d) tokens |
| `POST /auth/refresh` | public (refresh token) | Rotates the refresh token; **refuses non-active accounts** |
| `POST /auth/forgot-password` | admin | Admin-assisted password reset (sets new hash, revokes refresh token). No self-serve email flow. |

### users & profile — `api/src/routes/me.ts`, `users.ts` (me.ts is mounted first so `/users/me` wins)
| Endpoint | Guard | Purpose |
|---|---|---|
| `GET /users/me` · `PATCH /users/me` | any authed | Own profile read/update (language, password) |
| `PATCH /users/push-token` | any authed | Store the device's Expo push token |
| `GET /users/me/performance` | driver | Driver's own "My Score" |
| `GET /users` · `GET /users/:id/performance` · `GET /users/drivers/performance` | admin | User list, per-driver + leaderboard performance |
| `PATCH /users/:id/approve` | admin | Approve/disable accounts (approval queue) |

### trips — `api/src/routes/trips.ts` (all `requireAuth`; the largest router — booking → dispatch → execution → finalization)
| Endpoint | Guard | Purpose |
|---|---|---|
| `POST /trips` | requestor, admin | Create booking (Zod-validated; past-pickup + oversized-cargo rejection; ticket `TKT-YYYYMMDD-NNN`; auto-dispatch fires here in auto mode) |
| `GET /trips` · `GET /trips/:id` | any authed (row-scoped) | Lists/detail scoped by role (driver sees own, requestor sees own, admin sees all); detail embeds the status timeline |
| `GET /trips/:id/route` · `GET /trips/:id/location` | any authed (row-scoped) | Route polyline / latest GPS fix for live tracking |
| `PATCH /trips/:id/approve` | admin | Manual assign (Serializable claim; scheduling-conflict / operating-window / leave / roadworthiness guards; writes rate snapshot) |
| `PATCH /trips/:id/reject` · `PATCH /trips/:id/assign-external` | admin | Reject with reason / outsource to external forwarder |
| `PATCH /trips/:id/cancel` | authed, ownership checked in handler | Cancel a booking |
| `PATCH /trips/:id/status` | driver | Start trip / per-stop arrived / **delivered branch → incentive finalization** (write-once) |
| `POST /trips/:id/stops/:stopId/pod` | driver | POD photo upload → Cloudinary (gates the incentive) |
| `PATCH /trips/:id/stops/:stopId/docs` | driver | DO-uploaded / K2-form flags (`do_uploaded` requires a real `pod_photo`) |
| `POST /trips/:id/documents` | requestor, admin | Booking document upload |

### trucks — `api/src/routes/trucks.ts` (all `requireAuth`; admin-only from the truck list down)
| Endpoint | Guard | Purpose |
|---|---|---|
| `POST /trucks/:plate/fuel` | admin, driver | Log a fuel fill |
| `GET /trucks` · `GET /trucks/alerts` · `GET /trucks/fuel/summary` · `GET /trucks/:plate/fuel` | admin | Fleet list + capacity, ≤30-day doc-expiry alerts, fuel reports |
| `PATCH /trucks/:plate/rates` | admin | Edit claim rates (audit-logged) |
| `PATCH /trucks/:plate/documents` | admin | Renew insurance/permit/road-tax dates (audit-logged) |
| `POST /trucks/reset-rates` | admin | One-click restore of all rates to the bundled UWC spec (`rate_reset_to_spec` audit row) |

### dispatch, fleet, settings
| Endpoint | Guard | File | Purpose |
|---|---|---|---|
| `POST /dispatch/auto` | admin | `dispatch.ts` | Manually trigger auto-dispatch for a pending trip |
| `GET /fleet/live` | admin | `fleet.ts` | Live fleet map feed (latest GPS fix per active trip) |
| `GET /settings/dispatch-mode` · `PATCH …` | authed / admin | `settings.ts` | Read/flip the Manual ↔ Fully-Automatic toggle |

### locations (GPS ingest) — `api/src/routes/locations.ts`
| Endpoint | Guard | Purpose |
|---|---|---|
| `POST /locations` | driver JWT **or** `GPS_VENDOR_API_KEY` bearer | Batch GPS ingest (1–500 points; offline points keep original `recorded_at`). Vendor key authenticates but ingestion returns `501 NOT_IMPLEMENTED` — see Section 5. |

### rates, incentives, reports, analytics
| Endpoint | Guard | File | Purpose |
|---|---|---|---|
| `GET /rates/destinations` · `PATCH /rates/destinations/:id` · `GET /rates/audit` | admin | `rates.ts` | Zone-points editor (updates all rows of a zone) + rate-change audit trail |
| `GET /incentives/mine` | driver | `incentives.ts` | Driver earnings breakdown |
| `GET /reports/dashboard` · `/drivers` · `/monthly` · `/attention` | admin | `reports.ts` | KPI cards, driver comparison, monthly (MYT-bucketed), stuck-trip report |
| `GET /analytics/mine` | requestor | `analytics.ts` | Requestor booking analytics (FR-RS1–5) |

### calendars & reference data
| Endpoint | Guard | File | Purpose |
|---|---|---|---|
| `GET /holidays` | any authed | `holidays.ts` | Holiday list (mobile fetches it for estimates) |
| `POST /holidays` · `DELETE /holidays/:id` | admin | `holidays.ts` | Manage the public-holiday calendar (audit-logged) |
| `GET/POST /leaves` · `DELETE /leaves/:id` | admin | `leaves.ts` | Driver-leave calendar |
| `GET /consignees` | any authed | `consignees.ts` | Fuzzy consignee search (case/punctuation-insensitive, state-aware) |
| `POST /consignees` | requestor, admin | `consignees.ts` | Self-add with duplicate detection (`409 SIMILAR_EXISTS` + candidates) |
| `GET /departments` | public (needed by registration) | `meta.ts` | Department list |
| `GET /route-types` | any authed | `meta.ts` | The 6 route types |

---

## 4. Core Business Logic (most likely to be probed)

### Incentive calculation
- **Pure engine:** `api/src/services/incentiveEngine.ts` — `scoreDrops()` + `calculateDeliveryIncentive()`, plus `isOffPeak()`/MYT day helpers.
- **Called from:** `api/src/routes/trips.ts` (the `PATCH /:id/status` delivered branch builds the driver's day-ledger and finalizes) via `api/src/services/tripCompletion.ts`.
- **Mobile mirror:** `mobile/src/lib/trip.ts` (`estimateIncentive`, labeled "Estimated" in the UI).

Client-confirmed rule (Mr. Teh): per drop, per zone, per day, per driver — first delivered drop into a zone that day earns full zone points, repeats earn 1 point; the truck's daily deduction is subtracted once, from the day's first drop (floored at 0). Weekday vs off-peak (Sat/Sun/holiday/after 18:00 MYT) picks the rate table. Every function is **pure — no DB, no `Date.now()`** — the route layer fetches and passes data in, which is why the engine has 31 direct unit tests. The trip stores the per-trip **marginal** value so summing a day never double-counts. Finalization is **write-once**: `tripCompletion.ts` (`assertStopDeliverable`, `finalizeTripOnce`) uses a compare-and-set so re-posting "delivered" can never recompute pay. The **POD gate is real**: incentive stays pending until an actual photo exists.

### Auto-dispatch / bin-packing
- **Engine:** `api/src/services/dispatchEngine.ts` — pure `selectTruck()` + `enRouteZones()`; `autoDispatchTrip()` is the thin DB orchestration layer.
- **Concurrency:** `api/src/services/tripAssignment.ts` — `claimPendingTrip()` Serializable transaction + status-guarded update (`409 CONCURRENT_ASSIGNMENT` on a lost race).
- **Triggered from:** trip creation (auto mode), `POST /dispatch/auto`, and the 60s pending sweep `api/src/services/pendingTripAlerts.ts` (which also sets the self-clearing `auto_dispatch_failed` "needs attention" flag).

Best-Fit Decreasing bin-packing per Mr. Teh's spec: smallest available truck that fits (Rule A), consolidation to same/adjacent zones up to `max_pallets` (Rule B), zone-proximity matrix (P2↔K1 adjacency, A1 en-route on P2→A2), A1/A2 driver priority, one-active-trip-per-driver, hard overload block. The selection logic is pure (21 unit tests); candidates are pre-filtered by leave, roadworthiness, scheduling conflicts, and the operating window. The chosen reason is persisted into the trip timeline (`autoAssignNote`) so every auto-assignment is explainable.

### Scheduling-conflict check
- `api/src/services/schedulingConflict.ts` — pure `findSchedulingConflicts()` (9 unit tests).

A candidate conflicts when the same driver **or** truck has another trip in `{approved, assigned, in_progress}` whose pickup falls within a configurable buffer (`ASSIGNMENT_CONFLICT_BUFFER_MIN`, default 120 min). Manual assign returns `409 SCHEDULING_CONFLICT` with the clashing trips and supports an audited `force=true` "Assign anyway" override; auto-dispatch silently skips conflicted candidates.

### Operating-window (07:00–18:00) check
- `api/src/services/operatingWindow.ts` — pure `estimateOperatingWindow()` (17 unit tests).

Estimates completion as `pickup + load + Σ(zone-scaled drive per leg) + Σ(unload per stop)` (envs `OP_LOAD_MIN`/`OP_DRIVE_MIN_PER_LEG`/`OP_UNLOAD_MIN_PER_STOP`; drive time scales with the destination's zone points — Juru ≈15 min vs Ipoh ≈90 min). Compared in MYT against the **per-truck** `operating_hours_start/end`. Auto-dispatch skips + flags routes that would finish past the window; manual assign warns (`409 OPERATING_WINDOW`) with an audited override. Deliberately an estimate, not a routing API — no external dependency.

### Rate snapshot / lock-at-assignment
- `api/src/services/rateSnapshot.ts` — `truckRateSnapshot()` + `snapshotStopZonePoints()` (12 unit tests).

The pay a trip finalizes at must be the pay it was dispatched under: claim rates are snapshotted onto the Trip and zone points onto each TripStop at assignment time, inside the same Serializable claim transaction (both manual and auto paths). Finalization reads the snapshot, so an admin rate edit affects future assignments only — never an in-flight trip. A missing zone mapping now throws `422 ZONE_POINTS_MISSING` instead of silently under-paying.

### Public-holiday + driver-leave wiring
- Holidays: `api/src/lib/holidays.ts` loads the `PublicHoliday` table → passed **into** the pure engine as a parameter (`isOffPeak(date, holidaySet)`), so the engine stays DB-free. Admin CRUD in `routes/holidays.ts`; mobile mirrors via `GET /holidays`.
- Leave: `api/src/services/driverLeave.ts` — pure `leaveCoversDate()`/`leaveDateFilter()` keyed to the trip's pickup MYT date. Auto-dispatch filters leave-covered drivers; manual approve throws a hard `409 DRIVER_ON_LEAVE`. Leave affects availability only — never login (account disable is a separate mechanism).

Also useful: `api/src/lib/tripTimeline.ts` + `lib/tripHistory.ts` (append-only status timeline), `services/attention.ts` (stuck-trip detection), `lib/performanceScore.ts` (driver score), `lib/pallets.ts` (4×4-pallet conversion), `services/truckEligibility.ts` (expired-document dispatch block).

---

## 5. GPS / Location — honest position

**Built and working:**
| Piece | Path |
|---|---|
| Ingest endpoint (batch, 1–500 points) | `api/src/routes/locations.ts` → `POST /api/v1/locations` |
| DB model + index | `LocationLog` in `api/prisma/schema.prisma` (`@@index([trip_id, recorded_at])`) |
| Phone GPS capture (30s interval while a trip is active) | `mobile/src/hooks/useTripLocation.ts` (expo-location) |
| Durable offline queue (AsyncStorage, newest-500, flush on reconnect/foreground) | `mobile/src/lib/locationQueue.ts` |
| Admin live fleet map feed | `api/src/routes/fleet.ts` (`GET /fleet/live`) + `mobile/src/admin/` fleet map |
| Requestor/driver live maps | `GET /trips/:id/location` + `mobile/src/components/LiveTripMap(.web).tsx` / `ActiveTripMap(.web).tsx` |

Row-level security on ingest: each posted point's trip must belong to the authenticated driver. Offline points keep their **original capture time** (`recorded_at` travels through the queue), so a flushed backlog reconstructs the true track.

**Partially built — vendor hardware path:** `POST /locations` already accepts the third-party GPS vendor's static API key (`GPS_VENDOR_API_KEY`, constant-time compared) as an alternative to a driver JWT, but vendor **payload ingestion is not implemented** — a valid vendor key deliberately gets `501 NOT_IMPLEMENTED` (not 401) so the vendor can verify their key while the truckId→trip mapping remains unbuilt. Reason: UWC's GPS vendor has been unresponsive; phone GPS is the agreed fallback. The source is abstracted behind this **single endpoint** — swapping to hardware GPS changes one handler, no schema or app rewrite.

**Not built (by design):**
- **Background tracking.** Tracking runs in the foreground only — the primary delivery target is the mobile **web** build (no install needed at UWC), and browsers cannot post GPS from a killed/backgrounded tab. There is no `expo-task-manager`/background-location code anywhere in `mobile/`. The offline queue compensates for signal gaps while the app is open.
- **Vendor live-device tracking** — blocked on the vendor above; client-accepted fallback.

---

## 6. Auth & Security

| Concern | Where |
|---|---|
| JWT sign/verify (30-min access, 7-day refresh; secrets + expiries from env) | `api/src/lib/jwt.ts` |
| Login / register / refresh-rotation (refresh token stored **hashed** on User) | `api/src/routes/auth.ts` |
| `requireAuth` — verifies token **and re-checks `status === active` on every request** (`401 ACCOUNT_DISABLED`); disabling a user cuts access immediately, tokens can't outlive a disable | `api/src/middleware/auth.ts` |
| `requireRole(...roles)` — server-side role guard on every router (see Section 3 guard column) | `api/src/middleware/roleGuard.ts` |
| Zod validation on every mutating endpoint | `api/src/middleware/validate.ts` + per-route schemas |
| Uniform error shape `{ error: { code, message } }` | `api/src/lib/apiError.ts` + `middleware/errorHandler.ts` |
| Helmet, CORS allowlist, rate limit 100 req/min/IP, Railway TLS | `api/src/index.ts` |
| bcrypt password hashing (cost 10) | `api/src/routes/auth.ts` |
| Audit logging of sensitive mutations | `AuditLog` writes throughout routes; rate history at `GET /rates/audit` |
| Row-level scoping (driver A cannot read driver B's trips/locations) | enforced in handlers, e.g. `trips.ts`, `locations.ts` |

**Recent audit hardening (all committed, tested):** write-once incentive finalization (`tripCompletion.ts` — closes the re-finalization pay hole) · disable-invalidation on `requireAuth` + `/refresh` (`3570647`) · real POD gate (`do_uploaded` requires an existing photo) · rate lock at assignment (`rateSnapshot.ts`, migration `20260702140000`).

---

## 7. External Integrations (both env-swappable)

| Integration | Files | Notes |
|---|---|---|
| **Cloudinary** (POD photos, trip documents) | `api/src/lib/cloudinary.ts` (config + buffer upload → secure URL), `api/src/lib/upload.ts` (multer, in-memory), consumed in `trips.ts` POD/document routes; mobile capture via `mobile/src/lib/photo.ts` (compress ≤500KB) | Entirely behind 3 env vars (`CLOUDINARY_*`); `isCloudinaryConfigured()` fails loudly if unset |
| **Expo Push** (notifications) | `api/src/lib/pushNotifications.ts` (direct HTTP to `exp.host`, 100-message chunks, best-effort); token registration `mobile/src/hooks/usePushNotifications.ts` + `mobile/src/lib/notifications.ts`, stored via `PATCH /users/push-token` | Calls Expo's public API with global `fetch` — the ESM-only SDK was deliberately dropped (API compiles to CommonJS) |
| **Google Maps** | `mobile/src/lib/maps.ts` + platform-split `*.web.tsx` map components; `GOOGLE_MAPS_API_KEY` env | Web build uses a keyless fallback so UWC can test without a paid key |

---

## 8. Frontend

### Admin (`mobile/src/admin/`) — inside the Expo app, role: admin
The legacy Vite SPA (`admin/`) was retired 2026-07-16; the admin surface now lives inside the Expo app, entered at login via `mobile/src/navigation/RootNavigator.tsx` → `mobile/src/admin/navigation/AdminNavigator.tsx` (wide drawer) / `AdminTabs.tsx` (narrow). Data hooks `mobile/src/admin/hooks/queries.ts`; shared libs `mobile/src/admin/lib/` (payroll, csv, format, trip, zones).

| Screen | File | What's on it |
|---|---|---|
| Dashboard | `screens/AdminHomeScreen.tsx` / `DashboardWide.tsx` | KPI tiles, live fleet map, needs-attention panel, dispatch toggle |
| Trips | `screens/TripsScreen.tsx` | Trip board + **dispatch panel** (free-driver grid, capacity, conflict/window overrides, external forwarder, **abort** in-progress) |
| Drivers | `screens/DriversScreen.tsx` | Driver management + **CRUD** (add/retire, bind/free truck) + leave calendar |
| Performance | `screens/PerformanceScreen.tsx` | Driver leaderboard / comparison |
| Trucks | `screens/TrucksScreen.tsx` | Fleet + expiry alerts + document renewal + fuel + **CRUD/retire** |
| Incentives | `screens/IncentivesScreen.tsx` | Rate editor + reset-to-spec + destination points + Public Holidays |
| Approvals / Users | `screens/ApprovalsScreen.tsx`, `AllUsersScreen.tsx`, `UserManagementScreen.tsx` | Approval queue + **all-users** (role/status/reset) |
| Reports | `screens/ReportsScreen.tsx` | Reports + payroll CSV export |
| Settings | `screens/AdminSettingsScreen.tsx` | Language / preferences |

### Mobile (`mobile/src/`) — React Native + Expo, roles: driver + requestor + admin
Navigation: `navigation/RootNavigator.tsx` → `AuthStack` → role tabs (`DriverTabs.tsx` / `RequestorTabs.tsx`). API client `services/api.ts`. i18n (en/ms/zh, all strings via `t()`): `src/i18n/index.ts`.

| Role | Screen | File |
|---|---|---|
| auth | Login / Register | `screens/auth/LoginScreen.tsx`, `RegisterScreen.tsx` |
| driver | Dashboard (today + weekly earnings) | `screens/driver/DriverDashboardScreen.tsx` |
| driver | Assigned trips / detail | `screens/driver/TripListScreen.tsx`, `TripDetailsScreen.tsx` |
| driver | **Active trip** (map hero, per-stop Arrived/Delivered, POD, K2 checkbox) | `screens/driver/ActiveTripScreen.tsx` |
| driver | Earnings / My Score | `screens/driver/EarningsScreen.tsx`, `MyPerformanceScreen.tsx` |
| requestor | Dashboard / analytics | `screens/requestor/RequestorDashboardScreen.tsx`, `AnalyticsScreen.tsx` |
| requestor | **4-step booking form** (multi-stop, consignee search/self-add) | `screens/requestor/BookingFormScreen.tsx` (+ `components/NewConsigneeModal.tsx`) |
| requestor | History / detail + live tracking | `screens/requestor/BookingListScreen.tsx`, `BookingDetailScreen.tsx` |
| shared | Profile (language, password) | `screens/shared/ProfileScreen.tsx` |

---

## 9. Tests

| Suite | Where | Count (verified 2026-07-03) |
|---|---|---|
| **Unit (Vitest)** | `api/tests/*.test.ts` — 20 files | **180 tests, all passing** (~2s run: `npm test` in `api/`) |
| **E2E (Playwright)** | `e2e/tests/*.spec.ts` — 4 files (requestor, requestorEdit, driver, screenshots) | mobile-web only; the admin-UI browser specs were removed with the Vite app (`npx playwright test --list` in `e2e/`) |

- Biggest unit files map 1:1 to the business logic in Section 4: `incentive.test.ts` (31), `dispatch.test.ts` (21), `operatingWindow.test.ts` (17), `performance.test.ts` (14), `rateSnapshot.test.ts` (12), `schedulingConflict.test.ts` (9), `tripCompletion.test.ts` (8), plus timeline, driverLeave, myt, truckEligibility, authStatus, tripValidation, ticketRetry, consigneeDedupe, pallets, rateReset, specSync, attention, tripAssignment.
- Unit tests are possible **because** the engines are pure functions — no DB or clock mocking needed.
- E2E config: `e2e/playwright.config.ts` — runs serially (`workers: 1`); targets are env-driven and default to **local dev servers**, refusing Railway hosts without `E2E_ALLOW_PROD=1` (see `e2e/README.md`). ⚠️ Running against prod creates real bookings — don't run it casually during the trial-run window.
