CREATE INDEX CONCURRENTLY IF NOT EXISTS access_sessions_expiry_idx ON access_sessions (expires_at);
