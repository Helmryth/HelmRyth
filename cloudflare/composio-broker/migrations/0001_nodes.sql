CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  composio_user_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  disabled_at INTEGER
);

CREATE INDEX nodes_last_seen_idx ON nodes(last_seen_at);
