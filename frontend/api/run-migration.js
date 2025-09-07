// /api/run-migration.js  (Node serverless en Vercel)
import { Client } from 'pg';

const SQL = `
-- 2025-09-06 Migration (idempotente)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS img_url TEXT;
CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);
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
`;

export default async function handler(req, res) {
  try {
    // Protección básica: header con secreto
    const secret = req.headers['x-migration-secret'];
    if (!secret || secret !== process.env.MIGRATION_SECRET) {
      return res.status(401).json({ ok:false, error:'Unauthorized' });
    }

    const conn = process.env.DATABASE_URL;
    if (!conn) return res.status(500).json({ ok:false, error:'Missing DATABASE_URL' });

    const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized:false } });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(SQL);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      await client.end();
    }
    return res.status(200).json({ ok:true, ran:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error: String(e.message||e) });
  }
}
