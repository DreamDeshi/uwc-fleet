# Multi-booking consolidation (A13) — design

**Status: DESIGN ONLY. No code in this PR.** The blocking unknown is named in §5;
§6 is the question to put to Mr. Teh so that unknown is the *only* thing left.

---

## 1. What he actually asked for

A13, R3, 29 Jul 2026. **The verbatim answer is in `CLIENT_ANSWERS.md` on Drive
(`$UWC_REFS_DIR`) — this repo is public, so it is paraphrased here.**

In summary: he rejects one-booking-one-lorry. A lorry should be filled as much as
possible, and **not** first-come-first-served — before a cut-off, the system may
still rearrange for the best allocation. He gave the pipeline as
*Booking → group compatible bookings → select lorry by pallet capacity →
optimise delivery sequence → assign*, and named **four factors**: pallet
capacity, customer location, delivery deadline, route sequence.

Two fragments are quoted because the exact wording is load-bearing:

Two things in there are easy to skim past:

- **"not based on first come first serve basis"** — a rejection of what the engine
  does today. `autoDispatchTrip` places ONE booking at a time, in arrival order. No
  amount of tuning inside that shape produces consolidation; the unit of the
  decision has to change from *a booking* to *a set of bookings*.
- **"Before the cut off time"** implies a scheduled decision point that does not
  exist anywhere in the system today. See §6 — this is a second unknown, and
  unlike the deck dimensions nobody is currently waiting on an answer for it.

Reinforced by **A18** (paraphrase): assign only once a whole trip finishes — the
morning trip completes, then the system consolidates bookings for the afternoon
one. Capacity already frees on trip completion; consolidation is expected to run
against the freed truck.

## 2. Provenance of the "2D packing" idea — read this before quoting it

This matters because the repo has a standing rule about it.

He raised it **himself**, in the Q1/Q10 cargo thread — but framed as something he
had asked LLMs about, not as a rule. Two short fragments, because the exact
wording is what settles the provenance:

> "we not sure its can really fully utilize the truck"

> "as I tried all of them suggested me to use Grid System or a 2D Bin Packing
> Algorithm"

Full context in `CLIENT_ANSWERS.md` on Drive.

So:

| | |
|---|---|
| **His requirement** | area arithmetic **over-promises** — a load whose areas sum under capacity may still not physically fit |
| **His suggestion** | a grid system or 2D bin packing, explicitly relayed as *what LLMs told him* |
| **NOT his** | the "LCU" unit (1 LCU = 4ft×4ft, full lorry = 16 LCU). That is ChatGPT's, pasted into the thread. ⚠ **Never attribute LCU to him as a rule** |

The concern is client-sourced and real. The algorithm is a proposal. Design to the
concern; treat the algorithm as one option that has to earn its place.

⚠ **The 31 Jul WhatsApp asking for the 2D packing visual — no weight, no height,
2D only — is now logged in `CLIENT_ANSWERS.md`.** It remains the WEAKEST source
tier under WORKBOOK > EMAIL > WhatsApp, so it should be confirmed in the workbook
or by email before code is built on it.

## 3. Why area-sum over-promises — worked

`palletEquivalents` converts every line to 4×4-pallet units and sums. A 14-pallet
truck accepts anything summing to ≤ 14.

Two loads, both "14":

```
A   14 × (4×4)          14 units   fits any 14-pallet deck
B    2 × (5×10) + rest  ~14 units   5×10 = 3.125 units each
```

Load B's two items are **10 ft long**. On a deck narrower than 10 ft they cannot
lie across it, so they consume length no area model can see. Area says yes; the
lorry says no. That is exactly the concern he raised, and it is a
**pre-existing** property of today's single-booking dispatch —
consolidation does not create it, it multiplies it, because a consolidated load is
several requestors' odd shapes rather than one.

## 4. What data exists today

| Input | Have it? | Where |
|---|---|---|
| Cargo footprint per line | **yes** | `width_ft` / `length_ft` on `CargoDetail` (crate/rack/custom) |
| Pallet sizes | **yes, in feet** | `"4×4"`, `"5×10"` … — the labels *are* the dimensions |
| Box | **count only, by his rule** | he asked for a count and no dimension → admin assigns by hand, never auto |
| Truck capacity | **yes, as a COUNT** | `Truck.max_pallets`, in 4×4-equivalents |
| Truck deck **length** | **partly inferable, unconfirmed** | `Truck.type`: `"10t-30ft"`, `"5t-17.5ft"` carry a figure; `"1t"` (PRH 5292) and `"Generic"` (4 Wheel) carry **none** |
| Truck deck **width** | **NO — nowhere** | — |
| Delivery deadline | **partial** | `pickup_datetime` + the operating window. There is no per-booking "deliver by" |
| Customer location | **yes** | zone + real geocode for ~990 consignees |
| Route sequence | **partial** | `enRouteZones` corridor map + `stops[].sequence` |

**The blocking gap for the packing visual is deck WIDTH.** Length can probably be
read off the type label for two of the four types, but "30ft" may be overall
vehicle length rather than usable deck — that needs confirming, not assuming.

⚠ **And note the shape of the problem, which is not what it first looks like.**
The only cargo carrying explicit `width_ft`/`length_ft` is crate, rack and custom
— and all three are `ALWAYS_MANUAL`, so they never reach auto-dispatch at all.
The cargo that *does* auto-dispatch is plain pallets, whose dimensions are already
known exactly from their names. So a 2D packing model would today be applied to
the loads whose shapes we already know perfectly, while the genuinely awkward
shapes are being routed to a human anyway. **Q4 is therefore probably worth more
than Q1** — and neither of them was on anyone's list before this document.

## 5. Proposed pipeline, staged by what unblocks it

His five steps, with the dependency marked:

```
1. Booking                       exists
2. Group compatible bookings     BUILDABLE NOW
3. Select lorry by capacity      BUILDABLE NOW (count model) / better with deck dims
4. Optimise delivery sequence    BUILDABLE NOW
5. Assign trip                   exists (tryAssign + the whole guard ladder)
```

### Stage 2 — grouping (no dimensions needed)

A candidate set is compatible when **all** hold:

- same MYT pickup day, and every pickup inside the chosen truck's operating window
  (`operatingWindow.ts` already computes this — it must be run on the COMBINED
  itinerary, not per booking, or the estimate is wrong in the safe-looking direction)
- zones form a corridor: identical, or adjacent under `enRouteZones`
- combined `palletEquivalents` ≤ the truck's `max_pallets`
- no cargo line that is `ALWAYS_MANUAL`. ⚠ That set is wider than it sounds:
  `["box", "crate", "rack", "custom"]`. Crate and rack **do** carry dimensions —
  he asked for them to be sized like pallets — and are still routed to a human. **So the auto path only ever sees PALLET lines** — which
  bounds what consolidation can do today far more than the deck dimensions do,
  and is worth putting to him directly (Q4)
- neither booking is `is_external`, paused, or already assigned

### Stage 3 — lorry selection

Today: smallest truck that fits, with the A1/A2 primary lock. Both survive; the
input becomes the combined footprint. ⚠ **`primaryZone` reads `stops[0]`**, so a
consolidated trip's stop ORDER decides the A1/A2 lock and therefore the
RM-per-point rate — see `lib/stopSequence`. Stage 4 must run **before** stage 3, or
the sequence chosen for efficiency silently re-prices the trip.

*(That ordering constraint is the most consequential thing in this document.)*

### Stage 4 — sequence

Small n (2–4 bookings, ≤ ~6 stops): exact nearest-neighbour over the geocodes,
falling back to zone centroids where a consignee has none. No heuristic search
needed at this size.

### The capacity model, and where the dimensions land

Three options, in ascending cost:

1. **Keep area-sum, add a FIT WARNING.** Any item whose longest side exceeds the
   deck length is flagged for manual review. Needs deck length only. Cheap, honest,
   and directly answers his concern without claiming to solve packing.
2. **Shelf/strip packing (2D, no rotation).** Needs deck W × L. Deterministic and
   explainable — "row 1: two 5×10, row 2: …" — which matters because a dispatcher
   has to trust it.
3. **Full 2D bin packing with rotation.** What the LLMs suggested. Materially more
   complex, and its output is hard to argue with when a driver says it does not fit.

**Recommendation: (1) now, (2) when the dimensions arrive, (3) only if (2) proves
insufficient in practice.** He asked for a *visual*, and (2) produces one; (3)
produces the same visual at much higher cost.

⚠ **No weight, no height, 2D only** — per the 31 Jul WhatsApp. Worth noting the
consequence out loud: a 2D-feasible load can still be overweight, so the model
must never be described to the office as proof the lorry can legally carry it.

## 6. What is outstanding — the questions

**Q1 (blocking the packing visual). Usable deck dimensions per truck type.**
> For each lorry type — 10t-30ft, 5t-17.5ft, 1t, and the 4-Wheel — what is the
> **usable cargo deck** length and width in feet? Two of those names carry a
> figure and two do not (`1t`, `Generic`), and even where there is one we do not
> know whether "30ft" is the deck or the whole vehicle.

**Q2 (blocking stage 2, and not currently on anyone's list). The cut-off time.**
> A13 refers to rearranging bookings "before the cut off time". What is the
> cut-off — a fixed daily time, a fixed lead time before pickup, or the
> dispatcher pressing a button?

Q2 is the one to notice: it is as blocking as Q1 and nobody is waiting on it.
Consolidation cannot be scheduled without knowing when the decision is made.

**Q3 (nice to have).** Is there a per-booking "deliver by" time, or is the pickup
slot the only deadline? His factor list says "delivery deadline"; the system only
has a pickup.

**Q4 (raised by this design, not previously asked).** Crate, rack and custom are
currently routed to **manual** assignment, so consolidation would only ever group
plain pallet loads. Is that intended? He asked for crate/rack to carry dimensions
"like pallet", which suggests he may expect them to auto-dispatch too — and if so,
that is a bigger unlock than the packing visual.

## 7. Why no code in this PR

Stage 2 is buildable without the dimensions, and it was tempting.

It is not built because **consolidation changes which lorry runs which booking, and
the lorry sets the RM-per-point rate.** A partial engine that groups bookings
without a defined cut-off (Q2) would make that money-affecting decision at an
arbitrary moment, and the sequence-before-selection constraint in §5 means a
half-built pipeline can re-price a trip as a side effect of an efficiency choice.

Building it in the right order — Q2 answered, then stages 2–4 together, behind a
flag, with the money-review discipline the exception workflow got — is worth more
than a head start that has to be unpicked.

## 8. What this replaces

Supersedes the design half of PR #44. The reasoning that survives is here; the
outstanding items are §6, not "the whole feature".
