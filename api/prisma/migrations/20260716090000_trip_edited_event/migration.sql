-- Requestor booking-edit (pending-only): one new immutable timeline milestone.
-- PG16 allows ADD VALUE inside a transaction as long as the value isn't USED in
-- the same transaction — this migration only adds it (same shape as the proven
-- 20260703110000_unassign_reassign_events migration).
ALTER TYPE "TripEvent" ADD VALUE 'edited';
