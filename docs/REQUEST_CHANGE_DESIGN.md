# Request Change — design proposal

**Status: PROPOSAL. Not implemented. Needs a schema decision from the owner before any code.**

Source: Mr. Teh's written answer A19, 29 July 2026 (`QUESTIONS_FOR_TEH_2026-07-29 [Answered].docx`, archived on Drive). **Document tier — authority 1.**

> "if pending, they still can edit everything, once a lorry is assigned, the requestor should not be able to directly change information that affects auto-dispatch"

| Booking status | Requestor | Admin |
| --- | --- | --- |
| PENDING | Can edit everything | Can edit everything |
| ASSIGNED | Can edit non-critical details / request change | Can approve and edit |
| IN TRANSIT | Cannot edit | Can make controlled changes |
| DELIVERED | Cannot edit | Can correct records with audit trail |
| CANCELLED | Cannot edit | Can reopen if necessary |

> "The most important point is that once a lorry is assigned, the requestor should not be able to directly change information that affects auto-dispatch, such as: Delivery location / Delivery date/time / Pallet quantity / Pallet size / Priority / Customer. Instead, the requestor can click 'Request Change', and the system sends the change to the dispatcher/admin for approval."

---

## 1. Why this is a proposal and not a pull request

The Request Change record has to be **persisted**: who asked, on which trip, which fields, old value → new value, pending/approved/rejected, who decided and when. There is nowhere to put it.

`prisma/schema.prisma` is **frozen** (AGENTS.md: must not be changed, migrated or committed without explicit owner approval), and the audit below found no existing model that can hold it honestly:

- **`AuditLog`** — `user_id, action String, table_name, record_id, timestamp`. No mutable state column, no Trip relation, no unique constraint. "Pending vs approved" would be derived by scanning for a later row, with **no CAS to make approve-once atomic** and no index for the dispatcher's queue. This is a money-adjacent approval flow; deriving its state from free text is how you get a change approved twice.
- **`TripStatusHistory`** — has the trip FK and a note, but `event` is an **enum** with no `change_requested` value, so it needs an enum migration anyway.
- **No JSON column anywhere in the schema**, and `Trip` has no spare free-text field (`rejection_reason` and `auto_dispatch_note` are single-purpose and cleared by the dispatch lifecycle).

The in-app feedback channel already does the `AuditLog`-as-storage hack (`api/src/routes/feedback.ts`, `table_name: "Feedback"`), and its own header calls a real table the upgrade path. Repeating that trick for an approval workflow would be worse: feedback is append-only and has no state machine.

**So: the enforcement half of the matrix is buildable today; the Request Change channel itself is not.**

---

## 2. What the code does today, cell by cell

Audited at `937688a`.

| Cell | Today | Verdict |
|---|---|---|
| PENDING / Requestor | `PATCH /trips/:id` (`trips.ts:609`) — route_type, pickup_datetime, stops, cargo. Status guard `pending` only. | ✅ correct |
| PENDING / Admin | **Nothing.** The route is `requireRole("requestor")`; an admin gets 403, even on a booking they created. | ❌ missing — **no schema needed** |
| ASSIGNED / Requestor | **Nothing.** 400 `INVALID_STATUS`. | ❌ the "no critical edits" half is over-enforced; the Request Change half **needs schema** |
| ASSIGNED / Admin | Can approve/unassign/reassign a **driver**, but cannot edit booking content, and has no change-request queue. | ❌ edit half needs no schema; approval half **needs schema** |
| IN TRANSIT / Requestor | Blocked. ⚠ except `POST /:id/documents` (`trips.ts:2261`), which has **no status guard** | ✅ correct (minor leak, below) |
| IN TRANSIT / Admin | Only `abort` and the exception workflow. No field edits, no reroute — `TripEvent.rerouted` is reserved and unimplemented. | ❌ missing — field edits need no schema |
| DELIVERED / Requestor | Blocked (same documents leak) | ✅ correct |
| DELIVERED / Admin | Only `approve-incentive`. Nothing corrects stops/cargo/pickup on a completed trip. | ❌ missing — **no schema needed**; `AuditLog` already carries the trail |
| CANCELLED / Requestor | Blocked; `cancelled` is terminal everywhere | ✅ correct |
| CANCELLED / Admin | **No route moves `cancelled` → anything.** | ❌ missing — CAS needs no schema, but an auditable timeline entry needs a `TripEvent` enum value |

### Two findings worth acting on regardless

1. **`POST /trips/:id/documents` has no status guard at all.** The owning requestor can attach paperwork to a `completed` or `cancelled` booking. It is append-only so nothing is *altered*, but it is the one place "requestor cannot edit" leaks. Cheap fix, no schema.
2. **There is no `priority` field on a booking.** He lists it among the critical fields. Nothing in `Trip`, `createTripSchema` or the mobile form has it — the only `priority` in the schema is `Truck.priority_zones`, which is unrelated. So "requestor may not change priority once assigned" is currently **vacuous**, and if he wants priority as a booking attribute that is a separate schema request. **Worth asking him whether he believes this field already exists.**

---

## 3. Proposed design

### 3.1 The critical/non-critical split

His critical list maps onto the data model as:

| His words | Field today |
|---|---|
| Delivery location | `TripStop.consignee_id` → the consignee's zone |
| Customer | the same `consignee_id` |
| Delivery date/time | only `Trip.pickup_datetime` exists — there is no delivery datetime |
| Pallet quantity | `CargoDetail.quantity` |
| Pallet size | `CargoDetail.pallet_type` / `custom_size` / `width_ft` / `length_ft` |
| Priority | **does not exist** |

Every field the edit route currently accepts is on that list. The only genuinely non-critical thing a booking carries is `CargoDetail.remark`.

**Consequence: on an ASSIGNED booking, "edit non-critical details" is nearly an empty set, and Request Change is the whole feature.** Worth telling him that plainly rather than shipping a direct-edit path that covers one free-text field.

### 3.2 Schema needed (for approval — NOT applied)

```prisma
model TripChangeRequest {
  id           String    @id @default(cuid())
  trip_id      String
  trip         Trip      @relation(fields: [trip_id], references: [id])
  requested_by String
  requested_at DateTime  @default(now())
  // The proposed booking, as the SAME shape PATCH /trips/:id already accepts,
  // so approval replays the existing validated edit path rather than a second
  // one that could drift from it.
  payload      Json
  // Human summary, built by the existing summarizeTripChanges() so the
  // dispatcher reads the same wording the timeline uses.
  summary      String
  status       ChangeRequestStatus @default(pending)
  decided_by   String?
  decided_at   DateTime?
  decision_note String?
  version      Int       @default(0)   // optimistic concurrency, as TripException

  @@index([status, requested_at])
  @@index([trip_id, requested_at])
}

enum ChangeRequestStatus { pending approved rejected superseded }
```

Notes on the shape:

- **`payload Json`** rather than a column per field: the set of editable fields is already defined by `updateTripSchema`, and duplicating it in columns guarantees the two drift. Approval re-validates through the same zod schema.
- **`superseded`** exists so a second request on the same trip closes the first, rather than leaving two pending requests that can both be approved into conflicting states.
- **`version`** for the same reason `TripException` has one: approve-once must be a CAS, not a read-then-write.
- One **pending** request per trip, enforced the way `Trip.open_exception_id` does it — a partial unique index, or the same pointer trick.

### 3.3 Flow

1. Requestor opens an ASSIGNED booking, taps **Request Change**, edits the same form they use for a pending booking.
2. Client `POST /trips/:id/change-request` with the edit payload + a client-supplied idempotency key (same discipline as the exception report).
3. Server validates through `updateTripSchema`, diffs against the live trip, refuses a no-op, stores `pending`.
4. **Admin is pushed immediately** — reuse the pattern just built for at-report exception alerts (#42). A change request on an assigned truck is time-critical in exactly the same way.
5. Admin sees it in a queue, and either:
   - **approves** → the stored payload replays through the existing edit path inside one transaction with the trip row locked, then **re-runs the dispatch guards** (capacity, scheduling conflict, roadworthiness) because the truck was chosen for the *old* cargo. If a guard now fails, the approval fails loudly rather than silently overloading a truck.
   - **rejects** with a note.
6. Either way the requestor is pushed, and a `TripStatusHistory` entry records it.

### 3.4 The part that needs a decision beyond schema

**Approving a change on an ASSIGNED trip can invalidate the assignment.** If the pallet count goes from 6 to 14, the assigned 8-pallet truck no longer fits. Options:

- (a) refuse the approval and make the admin unassign first — safest, most clicks;
- (b) approve and auto-unassign back to `pending` for re-dispatch;
- (c) approve and let the admin force it, as the existing `force` flag does for scheduling conflicts.

**Recommendation: (a), with the error naming the guard that failed.** It never silently changes who is driving what. But this is an operations call and should be put to him alongside the schema ask.

Also unresolved: **rates are snapshotted at assignment.** If an approved change alters the destination zone, the snapshot no longer matches the work. That is a money question, so it must not be guessed — it goes on the R4 list with the rest.

---

## 4. Recommended order

1. **Ask him the two questions** (does he believe a *priority* field exists? and the (a)/(b)/(c) call above) — added to `QUESTIONS_FOR_TEH_R4.md`.
2. **Get the schema approved**, then build the channel.
3. **Meanwhile, the no-schema cells can ship independently** and are worth doing on their own merits: admin booking edit at PENDING, admin correction at DELIVERED with an audit trail, admin reopen of CANCELLED, and the `documents` status-guard leak.
