export const runtime = 'edge';
import { neon } from '@neondatabase/serverless';

export default async function handler(req) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ ok:false, error:'method_not_allowed' }), { status:405 });
  }

  const sql = neon(process.env.DATABASE_URL);
  const rows = await sql/*sql*/`SELECT id, color, img_url, link FROM pixels`;

  const occupiedIds = rows.map(r => Number(r.id));
  const overlays = rows.map(r => ({
    id: Number(r.id),
    color: r.color || '',
    imgUrl: r.img_url || '',
    link: r.link || ''
  }));

  return new Response(
    JSON.stringify({ ok:true, occupiedIds, overlays, now: Date.now() }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }
  );
}
