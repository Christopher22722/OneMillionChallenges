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
  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      amount NUMERIC(18,2),
      currency TEXT,
      challenge_text TEXT,
      buyer_email TEXT,
      ts TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_buyer_email ON pixels(buyer_email);`);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  const client = await pool.connect();
  try {
    await ensureSchema(client); // <- crea tablas si no existen
    const { rows } = await client.query(
      `SELECT id, COALESCE(color,'') AS color, COALESCE(img_url,'') AS img_url, COALESCE(link,'') AS link FROM pixels`
    );
    const occupiedIds = rows.map(r => Number(r.id));
    const overlays = rows.map(r => ({
      id: Number(r.id),
      color: r.color,
      imgUrl: r.img_url,
      link: r.link
    }));
    res.status(200).json({ ok:true, occupiedIds, overlays, now: Date.now() });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
