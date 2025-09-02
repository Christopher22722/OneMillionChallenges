// backend/server.js
const path   = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const { z }   = require('zod');
const paypal  = require('@paypal/checkout-server-sdk');

const app = express();

/* ======================
   MIDDLEWARE BÁSICO
====================== */
app.use(cors({ origin: true, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
// OJO: no usamos app.use(express.json()) global para poder controlar el límite por ruta

/* ======================
   LOGS / CONFIG
====================== */
console.log('Iniciando backend...');
console.log('DB:', process.env.DB_HOST, process.env.DB_NAME, 'user:', process.env.DB_USER);
console.log('PayPal env:', process.env.PAYPAL_ENV);

const PRICE       = parseFloat(process.env.PRICE_PER_PIXEL || '1');
const RESERVE_MIN = parseInt(process.env.RESERVE_MINUTES || '10', 10);
const CURRENCY    = process.env.CURRENCY || 'USD';
const MAX_PIXELS_PER_ORDER = parseInt(process.env.MAX_PIXELS_PER_ORDER || '25000', 10); // cota de seguridad

/* ======================
   VALIDACIÓN
====================== */
const PixelsSchema = z.array(
  z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative()
  })
).min(1).max(MAX_PIXELS_PER_ORDER);

/* ======================
   MYSQL POOL
====================== */
const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

(async () => {
  try {
    const conn = await pool.getConnection();
    conn.release();
    console.log('✔ Conectado a MySQL');
  } catch (e) {
    console.error('✖ Error conectando a MySQL:', e.message);
  }
})();

/* ======================
   PAYPAL CLIENT
====================== */
function paypalClient() {
  const envName  = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret   = process.env.PAYPAL_CLIENT_SECRET;

  const EnvCtor  = envName === 'live'
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;

  const environment = new EnvCtor(clientId, secret);
  return new paypal.core.PayPalHttpClient(environment);
}

/* ======================
   API CONFIG
====================== */
app.get('/api/config', (_req, res) => {
  try {
    const clientId = process.env.PAYPAL_CLIENT_ID || '';
    if (!clientId) {
      return res.status(500).json({ error: 'PAYPAL_CLIENT_ID no configurado en .env' });
    }
    res.json({ paypalClientId: clientId, currency: CURRENCY });
  } catch {
    res.status(500).json({ error: 'No se pudo obtener la configuración' });
  }
});

/* ======================
   PIXELS: OCUPADOS
====================== */
app.get('/api/pixels', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT x,y,status FROM pixels WHERE status="sold" OR (status="reserved" AND reserved_until > NOW())'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo obtener la configuración' });
  }
});

/* ======================
   RESERVAR + CREAR ORDEN
====================== */
// Parser específico (límite alto) + log de tamaño
const reserveParser = express.json({ limit: '10mb' });
app.post('/api/reserve', reserveParser, async (req, res) => {
  try {
    const lenHdr = Number(req.headers['content-length'] || 0);
    console.log(`[reserve] content-length: ${lenHdr} bytes`);

    let pixels;
    try {
      pixels = PixelsSchema.parse(req.body.pixels);
    } catch {
      return res.status(400).json({ error: 'Formato de píxeles inválido' });
    }

    // cota extra (defensa en profundidad)
    if (pixels.length > MAX_PIXELS_PER_ORDER) {
      return res.status(413).json({ error: 'Solicitud demasiado grande' });
    }

    const amount = (pixels.length * PRICE).toFixed(2);
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // Reservar uno por uno
      for (const { x, y } of pixels) {
        const [rows] = await conn.query(
          'SELECT status, reserved_until FROM pixels WHERE x=? AND y=? FOR UPDATE',
          [x, y]
        );

        const now = new Date();
        if (rows.length === 0) {
          await conn.query(
            'INSERT INTO pixels (x,y,status,reserved_until) VALUES (?,?, "reserved", DATE_ADD(NOW(), INTERVAL ? MINUTE))',
            [x, y, RESERVE_MIN]
          );
        } else {
          const row = rows[0];
          if (row.status === 'sold') {
            throw new Error(`Pixel (${x},${y}) ya vendido`);
          }
          if (row.status === 'reserved' && row.reserved_until && new Date(row.reserved_until) > now) {
            throw new Error(`Pixel (${x},${y}) reservado por otro usuario`);
          }
          await conn.query(
            'UPDATE pixels SET status="reserved", reserved_until=DATE_ADD(NOW(), INTERVAL ? MINUTE), paypal_order_id=NULL WHERE x=? AND y=?',
            [RESERVE_MIN, x, y]
          );
        }
      }

      // Crear orden en PayPal
      const request = new paypal.orders.OrdersCreateRequest();
      request.prefer('return=representation');
      request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{ amount: { currency_code: CURRENCY, value: amount } }]
      });

      const ppOrder = await paypalClient().execute(request);
      const paypalOrderId = ppOrder.result.id;

      await conn.query(
        'INSERT INTO orders (paypal_order_id, amount, status) VALUES (?, ?, "created")',
        [paypalOrderId, amount]
      );

      for (const { x, y } of pixels) {
        await conn.query(
          'UPDATE pixels SET paypal_order_id=? WHERE x=? AND y=? AND status="reserved"',
          [paypalOrderId, x, y]
        );
      }

      await conn.commit();
      res.json({ paypalOrderId, amount });
    } catch (e) {
      try { await conn.rollback(); } catch {}
      res.status(409).json({ error: e.message || 'No se pudo reservar' });
    } finally {
      conn.release();
    }
  } catch (err) {
    // Si el error viene del parser (entity too large), respondo 413
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Solicitud demasiado grande' });
    }
    console.error('[reserve] error inesperado:', err?.message);
    res.status(500).json({ error: 'No se pudo reservar' });
  }
});

/* ======================
   CAPTURAR ORDEN
====================== */
app.post('/api/paypal/capture', express.json({ limit: '100kb' }), async (req, res) => {
  const { paypalOrderId } = req.body || {};
  if (!paypalOrderId) return res.status(400).json({ error: 'paypalOrderId requerido' });

  try {
    const request = new paypal.orders.OrdersCaptureRequest(paypalOrderId);
    request.requestBody({});
    const result = await paypalClient().execute(request);

    if (result.result.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Orden no completada', status: result.result.status });
    }

    const [rows] = await pool.query(
      'SELECT COUNT(*) AS n FROM pixels WHERE paypal_order_id=? AND status="reserved"',
      [paypalOrderId]
    );
    const n = rows[0]?.n || 0;
    if (n === 0) return res.status(400).json({ error: 'No hay reservas asociadas a la orden' });

    await pool.query('UPDATE pixels SET status="sold", reserved_until=NULL WHERE paypal_order_id=?', [paypalOrderId]);
    await pool.query('UPDATE orders SET status="captured" WHERE paypal_order_id=?', [paypalOrderId]);

    res.json({
      ok: true,
      status: result.result.status,
      captureId: result.result?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null
    });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo capturar la orden', detail: e.message });
  }
});

/* ======================
   LIMPIAR RESERVAS
====================== */
app.post('/api/cleanup', express.json({ limit: '10kb' }), async (_req, res) => {
  try {
    const [r] = await pool.query(
      'UPDATE pixels SET status="free", reserved_until=NULL, paypal_order_id=NULL WHERE status="reserved" AND reserved_until < NOW()'
    );
    res.json({ ok: true, released: r.affectedRows || 0 });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo limpiar reservas' });
  }
});

/* ======================
   SERVIR FRONTEND
====================== */
app.use(express.static(path.join(__dirname, '../frontend')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

/* ======================
   MANEJADOR DE ERRORES 413 (catch-all)
====================== */
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Solicitud demasiado grande' });
  }
  next(err);
});

/* ======================
   ARRANQUE
====================== */
const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => {
  console.log(`API escuchando en http://localhost:${port}`);
});
