# Multi-booking consolidation — design proposal

**Status: PROPOSAL. No code. Requested design-only by the owner.**

Source: Mr. Teh, written answer A13, 29 July 2026. **Document tier — authority 1.**

> "I don't understand your statement of one lorry one booking. The booking should be fill as much as possible, but not based on first come first serve basis. Before the cut off time, system can still arrange within the best allocation. The ideal auto-dispatch logic should be: Booking → Group compatible bookings → Select suitable lorry based on pallet capacity → Optimize delivery sequence → Assign trip. Build the multi-booking auto-dispatch capability. Make the algorithm consider 4 factors: pallet capacity + customer location + delivery deadline + route sequence."

Corroborated by A18:

> "I think better whole trip finish only assign, like morning trip they complete, then system assign by consolidating the booking for afternoon trip."

---

## 1. What he is actually asking for, and what we got wrong

His opening line matters: *"I don't understand your statement of one lorry one booking."* He never asked for one-booking-one-lorry — **we built it and then described it to him as though it were the requirement.** He is correcting a misunderstanding, not requesting a new feature.

Two distinct changes are bundled in his answer:

1. **Batch, not greedy.** Today dispatch runs per booking, on arrival, first-come-first-served. He wants bookings **held until a cut-off** and then allocated together — "before the cut off time, system can still arrange within the best allocation."
2. **One trip may serve several bookings.** Today `Trip` is 1:1 with a booking. He wants a lorry filled "as much as possible" across bookings.

(2) is the structural change. (1) is the reason (2) is worth anything: you cannot pack a lorry well if you must decide the moment each booking arrives.

## 2. Why this is a rewrite, not a tweak

Today: one booking → one `Trip` row → one lorry, chosen by Best-Fit-Decreasing on arrival (`api/src/services/dispatchEngine.ts`). `Trip` carries `requestor_id` as a **scalar**, and the whole app assumes one requestor per trip: the requestor's booking list, the tracking page, the DG-R1 lifecycle pushes, the "your booking" ownership checks.

A trip serving three bookings has three requestors. That single fact touches:

- **Ownership** — `GET /trips/:id` checks `trip.requestor_id === user.id`. With consolidation, "my booking" is a *stop set*, not a trip.
- **Notifications** — each requestor may only hear about their own stops, not the whole run.
- **Cancellation** — one requestor cancelling must remove their stops, not the trip. If that drops the load below another lorry's threshold, does dispatch re-plan?
- **The tracking page** — currently a whole-trip view; would leak other customers' consignees.
- **Money** — see §5. This is the part that must not be improvised.

## 3. Proposed model

Keep `Trip` as the **execution** unit (a lorry, a driver, a run) and introduce a separate **request** unit above it:

```
Booking  (what a requestor asked for: consignee(s), cargo, deadline)
   │  many-to-one
   ▼
Trip     (what a lorry does: driver, plate, ordered stops, rate snapshot)
```

- `TripStop` gains a `booking_id` — every stop already knows its consignee; it must now also know **whose booking it came from**.
- Requestor-facing reads filter to *their* stops. Admin-facing reads see the whole trip.
- A booking's status becomes derived from its stops (all pending → pending, any in a running trip → in transit, all delivered → delivered).

**This is a Prisma schema change of significant size, and the schema is frozen.** It also needs a data migration for existing trips (each becomes a one-booking trip), which is prod work. Neither should start before §5 is answered.

## 4. The allocation algorithm

His four factors, in the order they can actually be applied:

1. **Cut-off trigger.** Consolidation runs on a schedule (and on demand from the admin), not per booking. The existing pickup window already ends at 02:00; the cut-off he means is an operational one per shift — **needs his number.** A18 suggests he also wants it to run when a truck finishes ("morning trip they complete, then system assign … for afternoon trip"), so the trigger is *both* a clock and a fleet event.
2. **Group compatible bookings** — same MYT day, same direction. Zone adjacency already exists (`Zone` + the adjacency map used by `selectTruck`) and is the natural compatibility test. Interplant bookings are **excluded** from grouping with customer work (A4: interplant may only pick up and deliver between UWC Plant 1–9).
3. **Select the lorry** — Best-Fit-Decreasing already does this; it just needs to run on a *group's* total pallet-equivalents instead of one booking's. `palletEquivalents` and the overload guard are reusable as-is.
4. **Optimise the delivery sequence** — with real consignee coordinates now on prod (990 geocoded), a nearest-neighbour + 2-opt pass over the group's stops is enough. ⚠ **Stop order is currently the requestor's to set and he confirmed it is free** — so an optimiser must not silently reorder a requestor's own stops unless he agrees it may.

Deliberately **not** proposed: the "Lorry Capacity Unit" / 2D bin-packing idea from his earlier message. That was AI advice he pasted, not a UWC rule, and area-packing a lorry is a much harder problem than the 4 factors he actually listed. Best-Fit on pallet-equivalents is what the workbook's own capacity column supports.

## 5. The money questions — must be answered BEFORE any code

Consolidation changes what a "trip" is, and **the incentive is calculated per trip**. Three unanswered questions, all of them real money:

1. **Does the daily deduction apply once per trip or once per day?** The rule is once per driver-day off the day total, so consolidating four bookings into one trip should not change it — but today deduction lands per finalization, and one trip instead of four means the arithmetic shifts. Needs confirming against a worked example.
2. **Does the per-zone-per-day repeat rule survive consolidation?** If two bookings both go to P1 and are consolidated, that is one trip with two P1 stops — the second is a 1-point repeat. Under today's separate trips it is *also* a repeat (the cross-trip day ledger sees it). So this should be neutral — but it must be **proved with a conformance case**, not assumed.
3. **Rate snapshots.** Rates are frozen at assignment. A consolidated trip is assigned once, so all its bookings share one snapshot even though they were booked at different times. Is that what he wants?

None of these can be inferred. They go on the R4 ask-list.

## 6. What I would do first, if asked to proceed

In this order, because each step is independently useful and reversible:

1. **Ask the money questions in §5 and the cut-off time in §4.1.**
2. **Admin-driven manual consolidation.** Let an admin add a second booking's stops to an existing assigned trip, with the capacity guard enforced. No schema for the algorithm, no automatic behaviour, and it makes the ownership/notification/cancellation problems concrete on a small surface before they are automated.
3. **Batch the dispatch trigger** (hold to cut-off, then allocate) *without* consolidation — this alone gets him "not first come first serve" and is a scheduling change, not a model change.
4. **Then** the `Booking`/`Trip` split and automatic grouping.

Steps 2 and 3 deliver most of what he is complaining about. Step 4 is the rewrite.

## 7. Answer him now

He also asked (A17) whether an admin can see the latest dispatch on a whole-fleet map. **Yes — it exists.** Worth telling him in the same reply, since it is the one question in the round we can simply answer.
