// /api/purchase.js
// Maneja la confirmación de compra:
// 1) Inserta/asegura la orden
// 2) Guarda 1 sola vez la imagen en orders.img_url (si viene dataURL/http(s) o si hay draftId)
// 3) Inserta los píxeles (sin img_url por píxel)
// 4) Si se usó un borrador (draftId), lo marca como consumido

const { Pool } = require('pg');

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const pool = new Pool({
  connectionString: CONN,
  ssl: { rejectUnauthorized: false }
});

// Lee el body JSON en serverless (sin body-parser)
async function readJson(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

// Crea/asegura tablas e índices necesarios
async function ensureSchema(client) {
  // Tabla de órdenes (imagen vive aquí)
  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id       TEXT PRIMARY KEY,
      amount         NUMERIC(18,2),
      currency       TEXT,
      challenge_text TEXT,
      buyer_email    TEXT,
      img_url        TEXT,
      ts             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Tabla de píxeles
  await client.query(`
    CREATE TABLE IF NOT EXISTS pixels (
      id           INTEGER PRIMARY KEY,
      color        TEXT,
      img_url      TEXT,
      link         TEXT,
      order_id     TEXT NOT NULL,
      buyer_email  TEXT,
      ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT id_range CHECK (id >= 0 AND id < 1000000)
    );
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_order_id ON pixels(order_id);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_pixels_buyer_email ON pixels(buyer_email);`);

  // Tabla de borradores (expiran a 24h). Se usa para "promover" imagen al confirmar pago.
  await client.query(`
    CREATE TABLE IF NOT EXISTS drafts (
      draft_id    TEXT PRIMARY KEY,
      img_url     TEXT NOT NULL,
      pixels      INT[] NOT NULL,
      color       TEXT,
      link        TEXT,
      buyer_email TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ GENERATED ALWAYS AS (created_at + interval '24 hours') STORED,
      consumed    BOOLEAN NOT NULL DEFAULT false
    );
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_drafts_expires  ON drafts(expires_at);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_drafts_consumed ON drafts(consumed);`);
}

// Normaliza una URL de imagen aceptando solo dataURL o http(s)
function normalizeImgUrl(any) {
  let s = String(any || '').trim();
  if (s.startsWith('data:image/')) return s;
  if (/^https?:\/\//i.test(s))     return s;
  return '';
}

// El handler principal (CommonJS para Vercel)
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureSchema(client);

    const b = await readJson(req);

    // Campos base
    const orderId    = String(b.paypalOrderId || b.orderId || '').trim();
    const amount     = Number(b.amount || 0);
    const currency   = String(b.currency || 'USD').trim();
    const challenge  = String(b.challengeText || '').trim();
    const buyerEmail = (b.buyerEmail && String(b.buyerEmail).trim()) || null;
    const link       = (b.link && String(b.link).trim()) || null;

    // Píxeles comprados
    let pixels = Array.isArray(b.pixels) ? b.pixels.filter(Number.isInteger) : [];
    // Quita duplicados por si acaso
    pixels = Array.from(new Set(pixels));

    // Imagen: intentamos con overlayDraft primero
    const overlay = b.overlayDraft || {};
    let imgUrl = normalizeImgUrl(
      overlay.dataURL || overlay.dataUrl ||
      overlay.imgUrl  || overlay.imageUrl || overlay.imageURL ||
      overlay.url
    );

    // Si no vino imagen en el payload, probamos con el draftId
    const draftId = (b.draftId && String(b.draftId).trim()) || null;
    let usedDraft = false;
    let draftPixels = [];

    if (!imgUrl && draftId) {
      const dr = await client.query(`
        SELECT img_url, pixels
          FROM drafts
         WHERE draft_id = $1
           AND consumed = false
           AND expires_at > now()
      `, [draftId]);
      if (dr.rowCount) {
        imgUrl = normalizeImgUrl(dr.rows[0].img_url);
        draftPixels = Array.isArray(dr.rows[0].pixels) ? dr.rows[0].pixels.filter(Number.isInteger) : [];
        usedDraft = !!imgUrl;
        // Si no mandaron "pixels" en compra, usamos los del draft
        if (pixels.length === 0 && draftPixels.length > 0) {
          pixels = Array.from(new Set(draftPixels));
        }
      }
    }

    // Validaciones mínimas
    if (!orderId) {
      res.status(400).json({ ok: false, error: 'Missing orderId' });
      return;
    }
    if (pixels.length === 0) {
      res.status(400).json({ ok: false, error: 'No pixels to claim' });
      return;
    }

    await client.query('BEGIN');

    // Asegura/Registra la orden (si ya existe, no falla)
    await client.query(`
      INSERT INTO orders (order_id, amount, currency, challenge_text, buyer_email)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (order_id) DO NOTHING
    `, [orderId, amount, currency, challenge, buyerEmail]);

    // Guarda la imagen UNA VEZ en la orden (solo si vino algo válido)
    let savedOrderImg = false;
    if (imgUrl) {
      const r = await client.query(`
        UPDATE orders
           SET img_url = COALESCE(img_url, $1)
         WHERE order_id = $2
      `, [imgUrl, orderId]);
      savedOrderImg = r.rowCount > 0;
    }

    // Inserta píxeles SIN img_url por píxel (se pintará desde orders.img_url por JOIN)
    let inserted = 0;
    for (const id of pixels) {
      const r = await client.query(`
        INSERT INTO pixels (id, color, img_url, link, order_id, buyer_email)
        VALUES ($1,$2,NULL,$3,$4,$5)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `, [id, overlay.color || null, link, orderId, buyerEmail]);
      if (r.rowCount) inserted++;
    }

    // Calcula conflictos (ids ya ocupados) si no entraron todos
    let conflicts = [];
    if (inserted < pixels.length) {
      const r2 = await client.query(
        'SELECT id FROM pixels WHERE id = ANY($1::int[])',
        [pixels]
      );
      conflicts = r2.rows.map(r => Number(r.id));
    }

    // Si se usó draft, márcalo como consumido
    if (usedDraft && draftId) {
      await client.query(`UPDATE drafts SET consumed = true WHERE draft_id = $1`, [draftId]);
    }

    await client.query('COMMIT');

    return res.status(conflicts.length ? 207 : 200).json({
      ok: true,
      saved: inserted,
      conflicts,
      echoImgLen: (imgUrl || '').length,
      usedDraft,
      savedOrderImg
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
