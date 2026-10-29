-- Staff checklist results written by @ShawaTeambot (opening/closing,
-- kitchen/front). One row per finished run. The panel reads:
--   SELECT * FROM checklist_runs WHERE location = ? AND day = ?
-- detail_json: [{"item": "...", "done": true, "by": "Name", "at": "ISO"}]
-- shift_json: MyTeam shifts for that location/day (best effort, may be []).
CREATE TABLE IF NOT EXISTS checklist_runs (
  id INTEGER PRIMARY KEY,
  location TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('opening','closing')),
  area TEXT NOT NULL CHECK (area IN ('kitchen','front')),
  day TEXT NOT NULL,
  started_by TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','finished_early')),
  total_items INTEGER NOT NULL DEFAULT 0,
  done_items INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL DEFAULT '[]',
  shift_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS checklist_runs_loc_day_idx ON checklist_runs(location, day);
