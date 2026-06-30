# UWC Trip Status Timeline — Test Guide (A5 evidence)

> Manual test script for the **visual trip status timeline** (improvement roadmap
> item #1). The timeline is built once server-side in
> `api/src/lib/tripTimeline.ts` (`buildTripTimeline`) and returned on
> `GET /trips/:id` as the `timeline` array; all three clients render the same
> data. Milestones below are documented **exactly as implemented** in that file.

---

## 1. Setup

**Logins & password:** use the seeded test accounts — **1 admin, 1 requestor, and
6 drivers**. The exact phone numbers and the shared test password are listed in
`UWC_MASTER_PROJECT_DOCUMENT.md` §6 (kept out of this public repo). Driver 1 is
Mohd Driver 1 (truck PLX 2406).

| App | URL |
|---|---|
| Admin (web) | https://uwc-admin-production.up.railway.app |
| Mobile (web) | https://uwc-mobile-production.up.railway.app |

## 2. Where the timeline shows

| Role | Location |
|---|---|
| **Admin** | Trips → click a trip → **right-hand detail panel** ("Status timeline" section) |
| **Requestor** | open a booking → **Booking Detail** ("Timeline" card) |
| **Driver** | open a trip → **Trip Details** ("Status timeline" card) |

## 3. Colour / state legend

| Marker | State | Meaning |
|---|---|---|
| 🟢 green ✓ | `done` | milestone reached (carries a timestamp once a history row exists) |
| 🔵 blue dot | `current` | the next actionable milestone while the trip is live |
| ⚪ grey | `upcoming` | not reached yet (shows "Pending") |
| 🔴 red ✕ | terminal | `rejected` or `cancelled` |

## 4. Milestone sequence (as implemented)

**Happy path:**

```
Booked → Assigned → En route → [ per stop, in sequence: Arrived → Delivered ] → Completed
```

- The **Arrived → Delivered** pair **repeats once per stop** on a multi-stop trip
  (labelled `Stop 1 · <place>`, `Stop 2 · <place>`, …).
- **Assigned** carries a note: `"<Driver> · <PLATE>"` for a manual admin dispatch,
  or `"<Driver> · <PLATE> (auto)"` when the auto-dispatch engine assigned it.

**Terminal branches** (the timeline stops there — no later steps):

| Status | Timeline |
|---|---|
| Rejected | `Booked → Rejected` 🔴 (note = rejection reason) |
| Cancelled | `Booked → [Assigned, if it had been assigned] → Cancelled` 🔴 |
| External forwarder | `Booked → Assigned to forwarder` (note = forwarder company) |

Timestamps come from the append-only `TripStatusHistory` log; where a row is
missing they fall back to fields the trip already stores (`created_at`, stop
`arrived_at` / `delivered_at`) — see the caveat in §6.

---

## 5. Test scenarios

### Scenario A — Full happy path, multi-stop (requestor → admin → driver)

| # | Do | Predicted timeline outcome |
|---|---|---|
| A1 | **Requestor** logs in → New Booking → route type *Customer Delivery* → stop 1 consignee in **Kulim** (zone K1) → **+ Add Stop** → stop 2 consignee in **Penang** (P1) → cargo 4×4 × 2 → submit. Open the booking. | **Booked** 🟢 (with submit time). **Assigned** 🔵 current. En route, `Stop 1 · Kulim — Arrived/Delivered`, `Stop 2 · Penang — Arrived/Delivered`, Completed all ⚪ grey ("Pending"). |
| A2 | **Admin** → Trips → select the pending booking → choose a free driver + truck → Approve/Dispatch. Re-open the trip. | **Assigned** flips 🟢 with a timestamp and note **`<Driver> · <PLATE>`**. **En route** becomes 🔵 current. |
| A3 | **Driver** (the one assigned) → open trip → **Start Trip**. | **En route** 🟢. `Stop 1 · Kulim — Arrived` becomes 🔵 current. |
| A4 | **Driver** → Active Trip → **Arrived** on stop 1 → upload **POD photo** → **Delivered**. Repeat for stop 2. | After stop 1 Arrived: `Stop 1 · Kulim — Arrived` 🟢. After Delivered: `… — Delivered` 🟢 and `Stop 2 · Penang — Arrived` 🔵 current. After the **last** stop's Delivered: **Completed** 🟢. (Delivered is blocked until a POD photo is uploaded — that gate is expected.) |
| A5 | Re-open the same trip as **requestor** and **admin**. | Identical milestones + timestamps everywhere (computed once server-side). Requestor sees the driver·plate note on Assigned. |

### Scenario B — Rejected booking

| Do | Predicted |
|---|---|
| Requestor creates a booking → Admin **Rejects** it with reason "No capacity today" → reopen detail. | Timeline is exactly **Booked** 🟢 → **Rejected** 🔴 (✕), reason shown as the note. No Assigned/En route/stops/Completed rows. |

### Scenario C — Cancelled while pending

| Do | Predicted |
|---|---|
| Requestor creates a booking, then **Cancel Request** while it is still pending. | **Booked** 🟢 → **Cancelled** 🔴 (✕). Nothing after it. |

### Scenario D — Auto-dispatch note

| Do | Predicted |
|---|---|
| Admin flips the dispatch toggle to **Fully Automatic** → requestor creates a booking → open admin detail. (Flip back to Manual after.) | Trip is assigned immediately; **Assigned** note reads **`<Driver> · <PLATE> (auto)`**, distinguishing system dispatch from a manual approve. |

---

## 6. Known caveat (fallback behaviour — by design)

Trips created **before** this feature shipped (e.g. older demo/seed trips) have **no
`TripStatusHistory` rows**. For those, reached steps still render 🟢 **done** (derived
from the trip's current status and each stop's `arrived_at` / `delivered_at`), but
milestones with no stored timestamp show **"—" instead of a time**, and Assigned shows
no note. This is the **fallback working as designed**, not a bug.

**Any booking created now** is fully instrumented and shows real timestamps + the
driver·plate note on every step.

---

## 7. Optional — 30-second API smoke test (no UI)

Replace `<ADMIN_PHONE>` / `<PASSWORD>` with the seeded admin credentials from the
master doc §6.

```bash
API=https://uwc-api-production.up.railway.app/api/v1
TOKEN=$(curl -s -X POST $API/auth/login -H "Content-Type: application/json" \
  -d '{"phone":"<ADMIN_PHONE>","password":"<PASSWORD>"}' \
  | python -c "import sys,json;print(json.load(sys.stdin)['accessToken'])")
TID=$(curl -s $API/trips -H "Authorization: Bearer $TOKEN" \
  | python -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
curl -s $API/trips/$TID -H "Authorization: Bearer $TOKEN" \
  | python -m json.tool | grep -A40 '"timeline"'
```

**Predicted:** a `timeline` array of `{event, state, timestamp, note, stopLabel}`
objects matching the trip's status (e.g. an `assigned` trip →
`booked(done) → assigned(done) → started(current) → stop_arrived(upcoming) → … → completed(upcoming)`).
