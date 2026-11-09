CREATE INDEX CONCURRENTLY IF NOT EXISTS tender_notices_status_idx ON tender_notices (status, created_at);
