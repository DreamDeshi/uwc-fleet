-- Purely additive: one index, no table/column change, no data change.
-- Serves the paged trip list's keyset order (created_at DESC, id DESC) —
-- both columns same-direction, so Postgres walks this ASC composite
-- backwards — and the legacy newest-N limit window on the same endpoint.
CREATE INDEX "Trip_created_at_id_idx" ON "Trip"("created_at", "id");
