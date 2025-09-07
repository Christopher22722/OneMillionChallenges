// /api/purchase.js
const { Pool } = require('pg');

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

async function readJson(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

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
  await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS img_url TEXT;`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_buyer_email ON pixels(buyer_email);`);
}

module.exports = async function handler(req, res){
  const client = await pool.connect();
  try{
    if (req.method !== 'POST') {
      res.status(405).json({ ok:false, error: 'Method Not Allowed' });
      return;
    }

    await ensureSchema(client);
    const b = await readJson(req);

    const overlay = b.overlayDraft || {};
    // Preferencia: dataURL > http(s); descartar blob: y vacíos
    let imgUrl =
      overlay.imgUrl || overlay.imageUrl || overlay.imageURL ||
      overlay.dataURL || overlay.dataUrl || overlay.url || '';
    imgUrl = String(imgUrl || '').trim();
    if (!(imgUrl.startsWith('data:image/') || /^https?:\/\//i.test(imgUrl))) {
      imgUrl = '';
    }

    const orderId = String(b.paypalOrderId || b.orderId || '').trim();
    const buyerEmail = String(b.buyerEmail || '').trim();
    const amount = Number(b.amount || 0);
    const currency = String(b.currency || 'USD');
    const challengeText = String(b.challengeText || '');
    const link = (typeof b.link === 'string' && b.link.trim()) ? b.link.trim() : null;
    const pixels = Array.isArray(b.pixels) ? b.pixels.filter(n=>Number.isInteger(n)) : [];

    if (!orderId || !pixels.length){
      res.status(400).json({ ok:false, error:'Missing orderId or pixels' });
      return;
    }

    await client.query('BEGIN');

    await client.query(`
      INSERT INTO orders(order_id, amount, currency, challenge_text, buyer_email)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (order_id) DO NOTHING
    `, [orderId, amount, currency, challengeText, buyerEmail || null]);

    if (imgUrl) {
      // Guardar imagen 1 sola vez a nivel de orden
      await client.query(`
        UPDATE orders
           SET img_url = COALESCE(img_url, $1)
         WHERE order_id = $2
      `, [imgUrl, orderId]);
    }

    let inserted = 0;
    for (const id of pixels){
      const r = await client.query(`
        INSERT INTO pixels (id, color, img_url, link, order_id, buyer_email)
        VALUES ($1,$2,NULL,$3,$4,$5)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [id, overlay.color || null, link || null, orderId, buyerEmail || null]);
      if (r.rowCount) inserted++;
    }

    // Conflictos (si no entraron todos)
    const conflicts = (inserted < pixels.length)
      ? (await client.query('SELECT id FROM pixels WHERE id = ANY($1::int[])', [pixels])).rows.map(r=>Number(r.id))
      : [];

    await client.query('COMMIT');
    res.status(conflicts.length ? 207 : 200).json({ ok:true, saved: inserted, conflicts });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
