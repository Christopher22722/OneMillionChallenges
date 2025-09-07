BEGIN;

-- Backfill: para cada order_id toma la img_url del pixel más reciente (por timestamp)
WITH p AS (
  SELECT DISTINCT ON (order_id) order_id, img_url
  FROM pixels
  WHERE img_url IS NOT NULL
  ORDER BY order_id, ts DESC NULLS LAST
)
UPDATE orders o
SET img_url = p.img_url
FROM p
WHERE o.order_id = p.order_id
  AND (o.img_url IS NULL OR o.img_url = '');

COMMIT;
