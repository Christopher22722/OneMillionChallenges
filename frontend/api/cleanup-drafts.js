// /api/cleanup-drafts.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || process.env.POSTGRES_URL_NON_POOLING,
  ssl: { rejectUnauthorized: false }
});
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });
  const client = await pool.connect();
  try {
    const r = await client.query(`DELETE FROM drafts WHERE consumed = true OR expires_at <= now()`);
    res.status(200).json({ ok:true, deleted: r.rowCount });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  } finally { client.release(); }
};
