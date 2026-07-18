# UWC Fleet — Incentive & Dispatch Conformance Report

_Generated from the live engines against the authoritative spec (`docs/uwc-spec.json`). Every figure below is produced by the same code that runs in production, and is pinned by the automated conformance suite (`tests/conformance`). Regenerate with `npm run conformance:report`._

## 1. What each delivery pays

Incentive for a driver whose **only** delivery that day is one drop into the zone (the full daily deduction lands on it; on multi-delivery days the deduction is spread once across the day — see the worked examples below). Weekday = peak (Mon–Fri 08:00–18:00); off-peak = weekends, public holidays, and before 08:00 / after 18:00.

| Zone (points) | PLX 2406 | PND 1888 | PRJ 5292 | PQL 5292 | PPE 1804 | PRH 5292 |
| --- | --- | --- | --- | --- | --- | --- |
| P2 (1) · weekday | RM 0.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 0.00 |
| P2 (1) · off-peak | RM 0.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 0.00 |
| K1 (3) · weekday | RM 11.00 | RM 11.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 9.00 |
| K1 (3) · off-peak | RM 13.00 | RM 13.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 9.00 |
| P1 (3) · weekday | RM 11.00 | RM 11.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 9.00 |
| P1 (3) · off-peak | RM 13.00 | RM 13.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 9.00 |
| P3 (3) · weekday | RM 11.00 | RM 11.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 9.00 |
| P3 (3) · off-peak | RM 13.00 | RM 13.00 | RM 0.00 | RM 0.00 | RM 0.00 | RM 9.00 |
| K2 (4) · weekday | RM 22.00 | RM 22.00 | RM 10.00 | RM 10.00 | RM 10.00 | RM 18.00 |
| K2 (4) · off-peak | RM 26.00 | RM 26.00 | RM 10.00 | RM 10.00 | RM 12.00 | RM 18.00 |
| A1 (5) · weekday | RM 33.00 | RM 33.00 | RM 20.00 | RM 20.00 | RM 20.00 | RM 27.00 |
| A1 (5) · off-peak | RM 39.00 | RM 39.00 | RM 20.00 | RM 20.00 | RM 24.00 | RM 27.00 |
| A2 (6) · weekday | RM 44.00 | RM 44.00 | RM 30.00 | RM 30.00 | RM 30.00 | RM 36.00 |
| A2 (6) · off-peak | RM 52.00 | RM 52.00 | RM 30.00 | RM 30.00 | RM 36.00 | RM 36.00 |
| KL (8) · weekday | RM 66.00 | RM 66.00 | RM 50.00 | RM 50.00 | RM 50.00 | RM 54.00 |
| KL (8) · off-peak | RM 78.00 | RM 78.00 | RM 50.00 | RM 50.00 | RM 60.00 | RM 54.00 |

## 2. Worked full-day examples (deduction spent once, on the day total)

**Driver on PLX 2406** — Ipoh, Ipoh again (repeat = 1 pt), Penang

| Trip | Drops | Points earned | This trip pays |
| --- | --- | --- | --- |
| 1 | A2 | 6 | RM 44.00 |
| 2 | A2 | 1 | RM 11.00 |
| 3 | P1 | 3 | RM 33.00 |
| **Day total** | | **10 pts − deduction** | **RM 88.00** |

**Driver on PND 1888** — Kuala Ketil, Kulim

| Trip | Drops | Points earned | This trip pays |
| --- | --- | --- | --- |
| 1 | K2 | 4 | RM 22.00 |
| 2 | K1 | 3 | RM 33.00 |
| **Day total** | | **7 pts − deduction** | **RM 55.00** |

**Driver on PRJ 5292** — Juru (1 pt, floors to 0), then Ipoh — deduction carries

| Trip | Drops | Points earned | This trip pays |
| --- | --- | --- | --- |
| 1 | P2 | 1 | RM 0.00 |
| 2 | A2 | 6 | RM 40.00 |
| **Day total** | | **7 pts − deduction** | **RM 40.00** |

## 3. Which truck the system assigns

For an idle fleet, by destination zone and load size (4×4-pallet equivalents). A1/A2 (Taiping/Ipoh) are locked to **PLX 2406** while it's free per the rate sheet; otherwise the system picks the **smallest truck that fits** so the big lorries stay free for big loads. “—” means the load exceeds every truck (needs splitting).

| Zone | 1 plt | 2 plt | 3 plt | 8 plt | 9 plt | 14 plt | 15 plt | 16 plt | 17 plt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P2 | PRH 5292 | PRH 5292 | PPE 1804 | PPE 1804 | PND 1888 | PND 1888 | PLX 2406 | PLX 2406 | — |
| K1 | PRH 5292 | PRH 5292 | PPE 1804 | PPE 1804 | PND 1888 | PND 1888 | PLX 2406 | PLX 2406 | — |
| P1 | PRH 5292 | PRH 5292 | PPE 1804 | PPE 1804 | PND 1888 | PND 1888 | PLX 2406 | PLX 2406 | — |
| P3 | PRH 5292 | PRH 5292 | PPE 1804 | PPE 1804 | PND 1888 | PND 1888 | PLX 2406 | PLX 2406 | — |
| K2 | PRH 5292 | PRH 5292 | PPE 1804 | PPE 1804 | PND 1888 | PND 1888 | PLX 2406 | PLX 2406 | — |
| A1 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | — |
| A2 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | PLX 2406 | — |
| KL | PRH 5292 | PRH 5292 | PPE 1804 | PPE 1804 | PND 1888 | PND 1888 | PLX 2406 | PLX 2406 | — |

> Note: **4 Wheel** has no assigned driver in the workbook, so the system never auto-assigns it (manual/standby only — an open question with Mr. Teh).

## 4. Flagged for confirmation (not bugs — open rules)

- **A delivery run crossing 6pm** is currently paid entirely at the *first drop's* rate (one tier for the whole run). Whether it should instead be priced drop-by-drop is an open question with Mr. Teh.
- **Which public-holiday list** drives the off-peak rate (national / Penang state / company) is admin-entered and needs confirming.
