// /frontend/api/save-draft.js
// Recibe un dataURL/http de imagen + lista de píxeles y crea un borrador temporal.
const { Pool } = require('pg');

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING;

const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

async function ensureSchema(client) {
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

async function readJson(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method not allowed' });

  const body = await readJson(req);
  const { imgUrl, pixels = [], color = null, link = null, buyer = null } = body;

  if (!imgUrl || !(imgUrl.startsWith('data:image') || imgUrl.startsWith('http'))) {
    return res.status(400).json({ ok:false, error:'imgUrl inválido' });
  }
  if (!Array.isArray(pixels) || pixels.length === 0) {
    return res.status(400).json({ ok:false, error:'pixels[] requerido' });
  }

  const client = await pool.connect();
  try {
    await ensureSchema(client);

    const draftId = (globalThis.crypto?.randomUUID?.() || require('crypto').randomUUID());
    await client.query(`
      INSERT INTO drafts (draft_id, img_url, pixels, color, link, buyer_email)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [draftId, imgUrl, pixels, color, link, buyer]);

    res.status(200).json({ ok:true, draftId, echoLen: imgUrl.length, count: pixels.length });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally {
    client.release();
  }
};
