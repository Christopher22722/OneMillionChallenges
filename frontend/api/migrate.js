// migrate.js
// Run with: node migrate.js
const { Client } = require('pg');
const fs = require('fs');
require('dotenv').config();

(async ()=>{
  const sqlPath = './2025-09-06_migration.sql';
  if (!fs.existsSync(sqlPath)) {
    console.error('Missing file:', sqlPath);
    process.exit(1);
  }
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    console.error('Missing DATABASE_URL env var. Create a .env file or set it in CMD before running.');
    process.exit(1);
  }
  const client = new Client({
    connectionString: conn,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  try {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
    console.log('Migration OK');
  } catch (e) {
    console.error('Migration FAILED:', e.message || e);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
