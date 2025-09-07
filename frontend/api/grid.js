// /api/grid.js
const { Pool } = require('pg');

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      amount NUMERIC(18,2),
      currency TEXT,
      challenge_text TEXT,
      buyer_email TEXT,
      img_url TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pixels (
      id INTEGER PRIMARY KEY,
      color TEXT,
      img_url TEXT,
      link TEXT,
      order_id TEXT NOT NULL,
      buyer_email TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT id_range CHECK (id >= 0 AND id < 1000000)
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);`);
}

module.exports = async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureSchema(client);

    const { rows } = await client.query(`
      SELECT p.id,
             p.color,
             COALESCE(p.img_url, o.img_url, '') AS img_url,
             p.link
        FROM pixels p
   LEFT JOIN orders o ON o.order_id = p.order_id
    ORDER BY p.id
    `);

    const occupiedIds = rows.map(r => Number(r.id));
    const overlays = rows.map(r => ({
      id: Number(r.id),
      color: r.color,
      imgUrl: r.img_url || '',
      link: r.link || ''
    }));

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ ok:true, occupiedIds, overlays, now: Date.now() });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
