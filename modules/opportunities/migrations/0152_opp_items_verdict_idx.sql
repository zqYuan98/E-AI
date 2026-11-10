CREATE INDEX CONCURRENTLY IF NOT EXISTS opp_items_verdict_idx ON opp_items (verdict, created_at DESC);
