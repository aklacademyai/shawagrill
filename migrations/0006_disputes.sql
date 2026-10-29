-- Disputes module (Adam's IT task #3, design:
-- goals/shawa-ceo/files/it-tasks-2026-10-26/disputes-workflow.md).
-- One registry for both dispute kinds, four channels:
--   * adjustment   — Uber Eats / DoorDash / Grubhub returned money to the
--                    guest and withheld it from the restaurant payout;
--   * chargeback   — card payment disputed at the guest's bank, answered
--                    via the acquirer (Fiserv / Conectados), channel 'clover'.
-- The panel prepares everything up to the Submit click: case registry,
-- channel deadline rules, an evidence package from the synced panel/Clover
-- order and a ready dispute text. Filing itself is manual in each portal
-- (no public dispute API exists in any of the four channels).
--
-- deadline_at is a NY calendar date (YYYY-MM-DD) computed at creation from
-- the channel rule and stored, so the deadline the staff member saw is the
-- deadline of record:
--   uber     -> order_date + 30 days
--   doordash -> order_date + 10 days (Merchant Terms say 14, help says 10;
--               the registry also tracks the internal 7-day target)
--   grubhub  -> order_date + 30 days
--   clover   -> the exact date printed in the acquirer notice (required
--               input; internal SLA: answer within 3 days of the notice)
CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('uber','doordash','grubhub','clover')),
  kind TEXT NOT NULL DEFAULT 'adjustment' CHECK (kind IN ('adjustment','chargeback')),
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  panel_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  clover_order_id TEXT NOT NULL DEFAULT '',
  channel_order_id TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  order_date TEXT NOT NULL DEFAULT '',
  dispute_date TEXT NOT NULL DEFAULT '',
  deadline_at TEXT NOT NULL DEFAULT '',
  deadline_source TEXT NOT NULL DEFAULT 'rule' CHECK (deadline_source IN ('rule','notice')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','evidence_ready','submitted','won','lost','expired','skipped')),
  submitted_at TEXT,
  submitted_by INTEGER REFERENCES employees(id),
  outcome_amount_cents INTEGER,
  outcome_note TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES employees(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS disputes_deadline_idx ON disputes(status, deadline_at);
CREATE INDEX IF NOT EXISTS disputes_channel_order_idx ON disputes(channel, channel_order_id);
