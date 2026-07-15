# UWC Trucking — Admin Dashboard (Phase 4)

Fleet management web dashboard for UWC Trucking. **Vite + React 18 + TypeScript**,
wired to the live API at `/api/v1`.

## Run

```bash
# from the repo root (npm workspace) or this folder
npm run dev --workspace=admin    # → http://localhost:5173
```

The API must be running (`npm run dev:api`) at `http://localhost:3000`. The API's
default CORS allowlist already includes `http://localhost:5173`.

To point at a different API host, copy `.env.example` to `.env` and set
`VITE_API_URL`.

**Admin login:** phone `+60100000001`. On a fresh local seed the password is a
placeholder; on any shared/live deployment it is rotated (see
`api/prisma/rotate-passwords.ts`) — ask an admin for the current one. Locked out
with no admin at all? Use the break-glass recovery (`api/prisma/break-glass-admin.ts`).

> The dashboard is admin-only. Logging in with a driver/requestor account is
> rejected client-side and server-side.

## Build / typecheck

```bash
npm run typecheck --workspace=admin   # tsc --noEmit
npm run build --workspace=admin       # tsc -b && vite build → dist/
```

## Pages

| Route          | Page              | Notes |
|----------------|-------------------|-------|
| `/`            | Fleet Dashboard   | KPI cards, fleet map with **zone overlays** (P1/P2/P3/K1/K2/A1/A2), **load-capacity visualiser**, doc-expiry alerts, recent trips, **Manual/Auto dispatch toggle** |
| `/trips`       | Trip Management   | Pending/Active/Completed/Cancelled board + **dispatch panel** (assign free driver+truck, external forwarder, approve/reject, cancel) |
| `/drivers`     | Driver Management | Status filter, search, per-driver performance |
| `/trucks`      | Truck Management  | Status filter, **document-expiry alerts (≤30 days highlighted)**, claim rates, live load |
| `/incentives`  | Incentive Rates   | Editable truck claim rates + destination points (**every change audit-logged**), formula explainer |
| `/approvals`   | User Approval Queue | Approve/reject `pending_approval` registrations |
| `/reports`     | Reports           | Monthly incentive chart, route-type split, driver summary, monthly table, CSV export |

## Architecture

- **Routing:** React Router v6 (`src/App.tsx`); auth gate in `src/context/AuthContext.tsx`.
- **Data:** TanStack Query + Axios with a JWT refresh interceptor (`src/services/api.ts`,
  `src/hooks/queries.ts`).
- **Design identity:** Corporate Blue `#003087`, Yellow `#FFCC00`, Navy sidebar,
  Inter font — tokens in `src/theme.ts`. Styling is inline (matching the prototype).
- **Map:** `react-leaflet` + OpenStreetMap tiles (no API key). Truck positions are
  **approximate** — placed at their primary zone centroid because there is no live
  GPS yet (Development Brief §12).

## Notes / current limitations

- **Manual/Auto dispatch toggle is UI only** — the auto-dispatch bin-packing engine
  is Phase 5. The toggle is labelled to make this clear.
- On-time rate is a proxy (trips delivered on the same calendar day they were picked
  up), since no per-stop scheduled ETA is stored.
- Truck map markers are approximate (zone centroid + small deterministic offset).
