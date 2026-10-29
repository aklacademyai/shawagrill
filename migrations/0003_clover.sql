-- Clover integration (per-location):
--  * each location carries its own Clover merchant credentials; the token is
--    stored server-side only and is never returned by the API. The legacy
--    global settings (cloverMerchantId/cloverToken) remain as a fallback for
--    locations without their own credentials — no data is lost.
--  * menu items gain the Clover item mapping (clover_item_id);
--  * orders gain a source flag + the Clover order id (unique, so repeat
--    syncs upsert instead of duplicating) and a stock_deducted flag that
--    makes recipe write-offs idempotent for both app and imported orders.

ALTER TABLE locations ADD COLUMN clover_merchant_id TEXT NOT NULL DEFAULT '';
ALTER TABLE locations ADD COLUMN clover_token TEXT NOT NULL DEFAULT '';
ALTER TABLE locations ADD COLUMN clover_merchant_name TEXT NOT NULL DEFAULT '';
ALTER TABLE locations ADD COLUMN clover_last_sync_at TEXT;
ALTER TABLE locations ADD COLUMN clover_sync_watermark TEXT NOT NULL DEFAULT '';
ALTER TABLE locations ADD COLUMN clover_last_error TEXT NOT NULL DEFAULT '';

ALTER TABLE menu_items ADD COLUMN clover_item_id TEXT;

ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','clover'));
ALTER TABLE orders ADD COLUMN clover_order_id TEXT;
ALTER TABLE orders ADD COLUMN stock_deducted INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS orders_clover_unique ON orders(clover_order_id) WHERE clover_order_id IS NOT NULL AND clover_order_id <> '';

ALTER TABLE order_items ADD COLUMN clover_line_id TEXT;
