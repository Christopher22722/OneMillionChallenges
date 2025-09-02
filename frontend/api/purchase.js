export const runtime = 'edge';
import { neon } from '@neondatabase/serverless';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ ok:false, error:'method_not_allowed' }), { status:405 });
  }

  const b = await req.json().catch(() => ({}));
  const pixels = Array.isArray(b.pixels) ? b.pixels.map(Number).filter(Number.isFinite) : [];
  const overlay = b.overlayDraft || {};
  const orderId = String(b.paypalOrderId || '').trim();
  const buyerEmail = String(b.buyerEmail || '').trim();
  const link = String(b.link || '').trim();
  const amount = Number(b.amount || 0);
  const currency = String(b.currency || 'USD');
  const challengeText = String(b.challengeText || '');

  if (!pixels.length || !orderId) {
    return new Response(JSON.stringify({ ok:false, error:'missing_pixels_or_order' }), { status:400 });
  }

  const sql = neon(process.env.DATABASE_URL);

  try {
    const inserted = [];

    await sql.begin(async (tx) => {
      await tx/*sql*/`
        INSERT INTO orders (order_id, amount, currency, challenge_text, buyer_email)
        VALUES (${orderId}, ${amount}, ${currency}, ${challengeText}, ${buyerEmail})
        ON CONFLICT (order_id) DO NOTHING
      `;

      for (const id of pixels) {
        const res = await tx/*sql*/`
          INSERT INTO pixels (id, color, img_url, link, order_id, buyer_email)
          VALUES (${id}, ${overlay.color || null}, ${overlay.imgUrl || null}, ${link || null}, ${orderId}, ${buyerEmail || null})
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        if (res.length) inserted.push(Number(res[0].id));
      }

      if (inserted.length !== pixels.length) {
        throw new Error('conflict'); // rollback automático
      }
    });

    return new Response(JSON.stringify({ ok:true, saved: pixels.length }), {
      headers: { 'content-type': 'application/json' }
    });

  } catch (e) {
    if (String(e?.message).includes('conflict')) {
      const taken = await sql/*sql*/`SELECT id FROM pixels WHERE id = ANY(${pixels})`;
      const conflicts = taken.map(r => Number(r.id));
      return new Response(JSON.stringify({ ok:false, conflict:true, conflicts }), {
        status: 409,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ ok:false, error: String(e?.message || e) }), {
      status: 500,
      headers: { 'content-type': 'application/json' }
    });
  }
}
