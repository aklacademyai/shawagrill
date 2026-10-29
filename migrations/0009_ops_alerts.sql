-- Ops alerts: the panel-side inbox for "an order did not go through" style
-- alerts. External systems (mangal-ops / mangal-web workers) POST them to
-- /api/ops/alert with a shared secret; the panel's own Clover sync inserts
-- kind='sync_error' rows here too. @ShawaTeambot polls rows with
-- status='pending', publishes them into the central group's location
-- threads and stamps sent_at. The panel never sends anything itself.
-- location_key: 'sunny_isles' | 'miami_downtown' | 'fort_lauderdale' |
-- 'hallandale' | 'network'.
CREATE TABLE IF NOT EXISTS ops_alerts (
  id INTEGER PRIMARY KEY,
  location_key TEXT NOT NULL DEFAULT 'network',
  kind TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS ops_alerts_status_idx ON ops_alerts(status, id);
CREATE INDEX IF NOT EXISTS ops_alerts_dedupe_idx ON ops_alerts(location_key, kind, created_at);
