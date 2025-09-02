// /api/pingdb.js
const { Pool } = require('pg');

const CONN =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.POSTGRES_URL_SIN_SSL; // último recurso

const pool = new Pool({ connectionString: CONN, ssl: { rejectUnauthorized: false } });

module.exports = async (req, res) => {
  try {
    const r = await pool.query('SELECT now() AS now');
    res.status(200).json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};
