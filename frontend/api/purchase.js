export const runtime = 'edge'// /api/purchase.js
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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok:false, error:'method_not_allowed' });
  }

  const b = req.body || {};
  const pixels = Array.isArray(b.pixels) ? b.pixels.map(Number).filter(Number.isFinite) : [];
  const overlay = b.overlayDraft || {};
  const orderId = String(b.paypalOrderId || '').trim();
  const buyerEmail = String(b.buyerEmail || '').trim();
  const link = String(b.link || '').trim();
  const amount = Number(b.amount || 0);
  const currency = String(b.currency || 'USD');
  const challengeText = String(b.challengeText || '');

  if (!pixels.length || !orderId) {
    return res.status(400).json({ ok:false, error:'missing_pixels_or_order' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSchema(client); // <- por si alguien llama purchase primero

    await client.query(
      `INSERT INTO orders (order_id, amount, currency, challenge_text, buyer_email)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, amount, currency, challengeText, buyerEmail]
    );

    let inserted = 0;
    for (const id of pixels) {
      const r = await client.query(
        `INSERT INTO pixels (id, color, img_url, link, order_id, buyer_email)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [id, overlay.color || null, overlay.imgUrl || null, link || null, orderId, buyerEmail || null]
      );
      if (r.rowCount) inserted++;
    }

    if (inserted !== pixels.length) {
      await client.query('ROLLBACK');
      const r2 = await client.query('SELECT id FROM pixels WHERE id = ANY($1::int[])', [pixels]);
      return res.status(409).json({ ok:false, conflict:true, conflicts: r2.rows.map(r => Number(r.id)) });
    }

    await client.query('COMMIT');
    return res.status(200).json({ ok:true, saved: pixels.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
