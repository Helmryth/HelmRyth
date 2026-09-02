-- Scheduled Reach cleanup retries use a dedicated counter and attempt
-- timestamp for bounded exponential backoff.
ALTER TABLE node_reaches
  ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0);

ALTER TABLE node_reaches
  ADD COLUMN last_cleanup_attempt_at INTEGER;
