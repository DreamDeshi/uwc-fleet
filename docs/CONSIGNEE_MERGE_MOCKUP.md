# Consignee Merge — flow mockup (for approval, NOT built)

You asked to see the flow before any code. Here it is. Nothing below is
implemented; this is the proposed UX + the data-safety rules for review.

## The problem
~1,500 consignees, with real duplicates (same company entered twice with slightly
different names/addresses; the `UWC BERHAD (P1..P9)` plants; multiple Jabil / Lam
rows). Today the app only **warns** when you *create* a similar one — there's no
way to fix the dupes that already exist. A merge tool folds two records into one.

## Where it lives
Admin → Consignees screen → a new **"Merge duplicates"** action next to "Add".

## The flow (3 steps)

**Step 1 — pick the two records**
```
┌ Merge consignees ─────────────────────────────┐
│ Keep this one (survives):                      │
│  ▸ [ search / pick ]  UWC BERHAD (P7)          │
│ Merge this INTO it (removed):                  │
│  ▸ [ search / pick ]  UWC BERHAD (P7) - dup    │
│                                   [ Preview → ] │
└────────────────────────────────────────────────┘
```

**Step 2 — preview (what will change) — nothing saved yet**
```
┌ Preview merge ─────────────────────────────────┐
│ KEEP:   UWC BERHAD (P7)   · zone P2 · Batu Kawan │
│ REMOVE: UWC BERHAD (P7)-dup · zone P2            │
│                                                  │
│ • 14 trips will be repointed to the kept record  │
│     – 9 completed  → pay/zone UNCHANGED (frozen) │
│     – 5 open       → future pay uses KEPT record │
│ • The removed record is DEACTIVATED, not deleted │
│ ⚠ Zones differ? (P2 vs P1) → shown in red, must  │
│     tick "I understand" before confirming        │
│                              [ Cancel ][ Merge ] │
└──────────────────────────────────────────────────┘
```

**Step 3 — confirm** → toast "Merged. 14 trips repointed." → back to the list,
the duplicate gone from the active picker.

## Data-safety rules (the important part — money-adjacent)
1. **Completed trips keep their finalized pay.** A trip carries a snapshotted
   `zone_code` / `zone_points` (rate lock). Merging **repoints the FK only**; it
   never recomputes a completed trip's pay. This mirrors the existing
   consignee-zone-change rule ("completed trips keep their finalized pay").
2. **Repoint, don't delete.** All of the removed consignee's trips/bookings move
   to the kept `consignee_id`; the removed row is **deactivated** (kept for
   history/audit), never hard-deleted.
3. **Zone mismatch is a guard, not a silent choice.** If the two records sit in
   different zones, the merge surfaces it in red and requires an explicit ack —
   because the kept record's zone drives FUTURE pay for repointed open trips.
4. **Audited.** One `AuditLog` row (`consignee.merged`, kept id + removed id +
   trip count) so the audit-log viewer shows exactly what happened.
5. **Atomic.** Repoint + deactivate + audit commit in one transaction; a failure
   rolls the whole merge back.

## Open question for you
- When zones differ, should the merge be **blocked outright**, or **allowed with
  the ack** (as drawn)? I lean "allowed with ack" — a genuine dupe can have a
  mistyped zone — but it's your call.

Approve this flow (and the zone-mismatch behaviour) and I'll build it: a
`POST /consignees/merge` endpoint (transactional repoint + deactivate + audit) and
the two-step UI above.
