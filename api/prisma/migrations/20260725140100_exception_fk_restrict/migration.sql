-- Correct the evidence->action FK deletion semantics to RESTRICT (actions are
-- append-only and never deleted; SET NULL could not fire correctly on the
-- composite FK's NOT NULL exception_id). Drops and recreates CONSTRAINTS ONLY —
-- no tables, columns, rows or enums are touched. The composite same-exception
-- provenance constraint is preserved (recreated with RESTRICT).
-- DESTRUCTIVE-OK: constraint swap, not data loss — the FK is recreated on the
-- very next line with RESTRICT. No table, column, row or enum is touched.
ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT "ExceptionEvidence_action_id_fkey";
ALTER TABLE "ExceptionEvidence" ADD CONSTRAINT "ExceptionEvidence_action_id_fkey"
  FOREIGN KEY ("action_id") REFERENCES "ExceptionAction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DESTRUCTIVE-OK: same swap for the composite same-exception provenance FK,
-- recreated with RESTRICT immediately below. This is the constraint that later
-- `prisma migrate diff` runs keep trying to drop for real — it must survive.
ALTER TABLE "ExceptionEvidence" DROP CONSTRAINT "ExceptionEvidence_action_same_exception_fkey";
ALTER TABLE "ExceptionEvidence" ADD CONSTRAINT "ExceptionEvidence_action_same_exception_fkey"
  FOREIGN KEY ("action_id", "exception_id") REFERENCES "ExceptionAction"("id", "exception_id") ON DELETE RESTRICT ON UPDATE CASCADE;
