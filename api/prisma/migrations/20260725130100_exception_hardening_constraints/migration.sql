-- Exception-workflow hardening constraints (all additive).

-- Backs the composite FK below (id is already the PK; this is a cheap superset).
CREATE UNIQUE INDEX "ExceptionAction_id_exception_id_key" ON "ExceptionAction"("id", "exception_id");

-- ExceptionEvidence.action_id is now a real relation to ExceptionAction.
ALTER TABLE "ExceptionEvidence" ADD CONSTRAINT "ExceptionEvidence_action_id_fkey"
  FOREIGN KEY ("action_id") REFERENCES "ExceptionAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CANONICAL one-open-exception-per-trip invariant: at most one row per trip with
-- closed_at IS NULL. Prisma cannot express a partial index in schema.prisma, so it
-- lives here as raw SQL (Trip.open_exception_id is only a cache/pointer).
CREATE UNIQUE INDEX "TripException_one_open_per_trip" ON "TripException"("trip_id") WHERE "closed_at" IS NULL;

-- Evidence provenance integrity: a set action_id must reference an action of the
-- SAME exception. Composite FK; Prisma cannot express it (it would share the
-- exception_id column with the `exception` relation), so it is raw SQL. A NULL
-- action_id is unconstrained (MATCH SIMPLE) — unattached evidence stays allowed.
ALTER TABLE "ExceptionEvidence" ADD CONSTRAINT "ExceptionEvidence_action_same_exception_fkey"
  FOREIGN KEY ("action_id", "exception_id") REFERENCES "ExceptionAction"("id", "exception_id") ON DELETE SET NULL ON UPDATE CASCADE;
