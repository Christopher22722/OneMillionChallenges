// /frontend/api/purchase.js
// Confirma la compra y PROMUEVE la imagen del borrador a la orden.
// Guarda UNA SOLA imagen por order_id en orders.img_url y registra los píxeles.
const { Pool } = require('pg');

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

// Utilidad: leer JSON seguro
async function readJson(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

// Valida que sea dataURL o http(s)
function pickImg(payload) {
  const cands = [
    payload?.overlayDraft?.dataURL,
    payload?.overlayDraft?.imageUrl,
    payload?.overlayDraft?.imgUrl,
    payload?.overlayDraft?.url,
    payload?.imgUrl
  ].filter(Boolean);

  const s = cands.find(x => typeof x === 'string' && (x.startsWith('data:image') || x.startsWith('http')));
  return s || null;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id     TEXT PRIMARY KEY,
      buyer_email  TEXT,
      amount       NUMERIC,
      currency     TEXT,
      img_url      TEXT,
      challenge    TEXT,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS pixels (
      id           INTEGER PRIMARY KEY,
      color        TEXT,
      link         TEXT,
      order_id     TEXT NOT NULL,
      buyer_email  TEXT,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT id_range CHECK (id >= 0 AND id < 1000000)
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      draft_id     TEXT PRIMARY KEY,
      img_url      TEXT,
      pixels       INTEGER[],
      color        TEXT,
      link         TEXT,
      buyer_email  TEXT,
      status       TEXT DEFAULT 'pending',
      ts           TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  const body = await readJson(req);
  const {
    paypalOrderId,
    pixels = [],
    buyerEmail = null,
    amount = null,
    currency = null,
    challengeText = null,
    draftId = null
  } = body;

  // Imagen directa (por si no hay draftId)
  const inlineImg = pickImg(body);

  if (!Array.isArray(pixels) || pixels.length === 0) {
    return res.status(400).json({ ok:false, error:'pixels[] requerido' });
  }
  if (!paypalOrderId || typeof paypalOrderId !== 'string') {
    return res.status(400).json({ ok:false, error:'paypalOrderId requerido' });
  }

  const client = await pool.connect();
  try {
    await ensureSchema(client);
    await client.query('BEGIN');

    // 1) Crear/actualizar orden
    await client.query(`
      INSERT INTO orders(order_id, buyer_email, amount, currency, challenge)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (order_id) DO UPDATE SET
        buyer_email = EXCLUDED.buyer_email,
        amount      = COALESCE(EXCLUDED.amount, orders.amount),
        currency    = COALESCE(EXCLUDED.currency, orders.currency),
        challenge   = COALESCE(EXCLUDED.challenge, orders.challenge)
    `, [paypalOrderId, buyerEmail, amount, currency, challengeText]);

    // 2) Determinar imagen: prioridad draftId > inline
    let usedDraft = false;
    let img = null;

    if (draftId) {
      const dr = await client.query('SELECT img_url FROM drafts WHERE draft_id = $1', [draftId]);
      if (dr.rowCount && dr.rows[0].img_url) {
        img = dr.rows[0].img_url;
        usedDraft = true;
      }
    }
    if (!img && inlineImg) img = inlineImg;

    // 3) Guardar imagen UNA VEZ en orders.img_url (solo si aún está vacía)
    let savedOrderImg = false;
    if (img && (img.startsWith('data:image') || img.startsWith('http'))) {
      const upd = await client.query(`
        UPDATE orders
           SET img_url = COALESCE(img_url, $2)
         WHERE order_id = $1
      `, [paypalOrderId, img]);
      savedOrderImg = upd.rowCount > 0;
    }

    // 4) Insertar píxeles
    const values = [];
    const params = [];
    let pidx = 1;
    for (const id of pixels) {
      params.push(Number(id), null, null, paypalOrderId, buyerEmail);
      values.push(`($${pidx++}, $${pidx++}, $${pidx++}, $${pidx++}, $${pidx++})`);
    }
    const ins = await client.query(`
      INSERT INTO pixels(id,color,link,order_id,buyer_email)
      VALUES ${values.join(',')}
      ON CONFLICT (id) DO NOTHING
    `, params);
    const inserted = ins.rowCount || 0;

    // 5) Consumir borrador (si aplica)
    if (usedDraft) {
      await client.query('UPDATE drafts SET status = $2 WHERE draft_id = $1', [draftId, 'consumed']);
    }

    await client.query('COMMIT');

    return res.status(200).json({
      ok:true,
      orderId: paypalOrderId,
      saved: inserted,
      usedDraft,
      savedOrderImg,
      echoImgLen: img ? img.length : 0
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
