-- Add the append-only `evidence_added` action type (driver evidence resubmission).
-- Isolated in its own migration so the new enum value is committed before any
-- later statement or runtime insert uses it (Postgres enum-add semantics).
ALTER TYPE "ExceptionActionType" ADD VALUE 'evidence_added';
