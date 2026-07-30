-- THROWAWAY PROBE — DO NOT MERGE.
--
-- Exists only to prove that the "Migration safety (destructive SQL guard)"
-- required check physically blocks the merge button, rather than merely
-- reporting red. This branch is deleted as soon as that is confirmed.
--
-- Both statements are IF EXISTS no-ops against objects that do not exist, so
-- even in the catastrophic case where this reached production it could not
-- destroy anything. The guard is TEXTUAL, so it flags them regardless.

DROP TABLE IF EXISTS "ProbeThrowawayTable";

DROP INDEX IF EXISTS "ProbeThrowawayIndex";
