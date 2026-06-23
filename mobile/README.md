# UWC Trucking — Mobile App (Phase 3)

React Native + Expo app for **Drivers** and **Requestors**. Built with React
Navigation, TanStack Query, Axios (with JWT refresh), and i18next (English +
Bahasa Malaysia). Runs in **Expo Go** — no native build required.

## Run it

```bash
# 1. Start the API (from repo root, in another terminal)
npm run dev:api            # serves http://localhost:3000

# 2. Start the app
cd mobile
npm install                # already done if you installed from the root
npm start                  # opens the Expo dev server + QR code
```

Then press `a` (Android emulator), `i` (iOS simulator), or scan the QR code
with the **Expo Go** app on your phone.

### Pointing the app at the API

`app.json → expo.extra.apiUrl` controls the API base URL (default
`http://localhost:3000`).

- **iOS simulator:** `localhost` works as-is.
- **Android emulator:** use `http://10.0.2.2:3000`.
- **Physical phone (Expo Go):** `localhost` is the phone itself — set
  `apiUrl` to your computer's LAN IP, e.g. `http://192.168.1.20:3000`, and make
  sure the phone is on the same Wi-Fi.

## Test logins (from the seed)

| Role      | Phone           | Password      |
|-----------|-----------------|---------------|
| Driver    | `+60100000101`  | `Password123` |
| Admin     | `+60100000001`  | `Password123` |

The driver phone is typed in the login screen as the local part after `+60`
(e.g. `100000101`). Register new requestor/driver accounts from the app — they
start as **pending approval** until an admin activates them.

## Structure

```
src/
├── components/   Reusable UI (Button, Card, Header, StatusBadge, TripMap, …)
├── context/      AuthContext (token bootstrap, login/logout, language)
├── hooks/        TanStack Query hooks (trips, consignees, incentives, …)
├── i18n/         en.json + ms.json + i18next setup
├── lib/          format, geo (map coords), trip helpers, queryClient
├── navigation/   RootNavigator → Auth stack / Driver tabs / Requestor tabs
├── screens/
│   ├── auth/       Login, Register
│   ├── driver/     Dashboard, TripList, TripDetails, ActiveTrip, Earnings
│   ├── requestor/  Dashboard, BookingForm (4 steps), BookingList, BookingDetail
│   └── shared/     Profile (language picker + logout)
├── services/     api.ts (axios instance + JWT refresh interceptor)
├── theme.ts      Colors, spacing, radius, shadow (UWC design identity)
└── types.ts      API response types
```

## What's wired to the real API

- **Auth:** `POST /auth/login`, `POST /auth/register`, automatic token refresh.
- **Driver:** lists assigned trips, Start → Arrived → Delivered lifecycle
  (`PATCH /trips/:id/status`), document gate via `PATCH /trips/:id/stops/:sid/docs`,
  earnings from `GET /incentives/mine`.
- **Requestor:** create bookings (`POST /trips`, multi-stop), consignee search
  (`GET /consignees`) + self-add (`POST /consignees`), cancel pending bookings
  (`PATCH /trips/:id/cancel`).
- **Reference data:** `GET /departments`, `GET /route-types`, `GET /users/me`.

## Known limitations (this phase)

- **Map is approximate.** The schema stores consignees by zone, not lat/long,
  so `ActiveTrip`/`TripDetails` plot the UWC plant → destination-zone centroid
  with a straight line. No live GPS this phase (see `src/lib/geo.ts`).
- **Documents are confirmed by checkbox**, not photo upload (photo upload is a
  later phase). The driver ticks "DO confirmed" (+ "K2 form" for K2 zones)
  before the Delivered button enables.
- **No push notifications / no Chinese locale yet** — both deferred per brief.
- Inter font falls back to the system font (no custom font load step yet).
```
