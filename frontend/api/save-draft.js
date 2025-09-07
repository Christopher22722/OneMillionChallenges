// /api/save-draft.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL_NON_POOLING,
  ssl: { rejectUnauthorized: false }
});

async function ensureSchema(client){
  // Tabla de drafts temporales (expiran a las 24h)
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
  await client.query(`CREATE INDEX IF NOT EXISTS idx_drafts_expires ON drafts(expires_at);`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_drafts_consumed ON drafts(consumed);`);
}

function jsonBody(req){
  return new Promise((resolve)=> {
    let s=''; req.on('data', c=> s+=c);
    req.on('end', ()=> { try{ resolve(JSON.parse(s||'{}')); }catch{ resolve({}); }});
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok:false, error:'Method Not Allowed' }); return;
  }
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const b = await jsonBody(req);

    // Normaliza imagen: solo aceptamos dataURL o http(s)
    let imgUrl = String(
      b.dataURL || b.dataUrl || b.imgUrl || b.imageUrl || b.url || ''
    ).trim();

    // Si viene http(s), opcional: puedes dejarla tal cual; aquí aceptamos ambos.
    if (!(imgUrl.startsWith('data:image/') || /^https?:\/\//i.test(imgUrl))) {
      return res.status(400).json({ ok:false, error:'Invalid image URL' });
    }

    const pixels = Array.isArray(b.pixels) ? b.pixels.filter(Number.isInteger) : [];
    if (pixels.length === 0) return res.status(400).json({ ok:false, error:'No pixels' });

    const color = (b.color || '').trim() || null;
    const link  = (b.link  || '').trim() || null;
    const buyer = (b.buyerEmail || '').trim() || null;

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
