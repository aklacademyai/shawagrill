-- 0011: read optimization (2026-10-27). The free D1 tier caps rows read at
-- 5M/day and the panel hit the cap (error 7500): several hot queries filter
-- or join on columns with no index, so every call scanned whole tables —
-- and the tables (orders, order_items) grow by hundreds of rows a day.
-- Indexes only: no schema or data changes. Safe to apply while the old
-- worker is live, and the worker does NOT depend on this migration (its
-- queries are unchanged; the indexes only make them cheap).

-- order_items had only its rowid PK: every order view, every Clover-sync
-- DELETE of an order's lines and the finance PnL line join scanned the
-- whole table (the single biggest read consumer).
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_menu_item_idx ON order_items(menu_item_id);

-- Dashboard, PnL and DR-15 filter served orders by served_at; the only
-- orders index was (status, created_at), so each aggregate scanned every
-- served order ever synced.
CREATE INDEX IF NOT EXISTS orders_status_served_idx ON orders(status, served_at);
CREATE INDEX IF NOT EXISTS orders_location_served_idx ON orders(location_id, status, served_at);

-- /api/state (manager view) sorts punches by clock_in; the only punches
-- index leads with employee_id and cannot serve that sort.
CREATE INDEX IF NOT EXISTS punches_clock_in_idx ON punches(clock_in);

-- Checklist screens filter by day alone; the existing index leads with
-- location, so a day lookup scanned the table.
CREATE INDEX IF NOT EXISTS checklist_runs_day_idx ON checklist_runs(day);

-- Supplier balances aggregate purchase_documents by supplier.
CREATE INDEX IF NOT EXISTS purchase_documents_supplier_idx ON purchase_documents(supplier_id, doc_date);
