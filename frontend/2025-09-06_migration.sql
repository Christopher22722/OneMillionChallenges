-- 2025-09-06 Migration: store image URL at order level and backfill from pixels
-- This script is idempotent: safe to run multiple times.
-- It will:
--   1) Ensure the 'img_url' column exists in 'orders'
--   2) Ensure an index on pixels(order_id) to accelerate the backfill
--   3) Backfill orders.img_url using any non-NULL pixels.img_url for the same order_id
--   4) (Optional) Show a summary of affected rows at the end
--
-- How to run (psql):
--   psql "<your DATABASE_URL>" -f 2025-09-06_migration.sql
--
-- For large tables, consider raising statement_timeout, e.g.:
--   SET statement_timeout = '10min';

BEGIN;

-- 1) Ensure column exists
ALTER TABLE orders ADD COLUMN IF NOT EXISTS img_url TEXT;

-- 2) Ensure helpful index for join/backfill (no-op if already exists)
CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);

-- 3) Backfill: copy any existing image URL from pixels to orders
--    Only fills orders where img_url is currently NULL.
--    Uses a lateral subquery to pick one pixel's img_url (if any).
UPDATE orders o
SET img_url = p.img_url
FROM LATERAL (
  SELECT img_url
    FROM pixels
   WHERE order_id = o.order_id
     AND img_url IS NOT NULL
   LIMIT 1
) p
WHERE o.img_url IS NULL;

COMMIT;

-- === Optional diagnostics (uncomment to run) ===
-- SELECT COUNT(*) AS orders_with_img FROM orders WHERE img_url IS NOT NULL;
-- SELECT COUNT(*) AS orders_without_img FROM orders WHERE img_url IS NULL;
-- \d+ orders
