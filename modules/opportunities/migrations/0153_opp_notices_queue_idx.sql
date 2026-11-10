CREATE INDEX CONCURRENTLY IF NOT EXISTS opp_notices_queue_idx ON opp_notices (status, next_attempt_at);
