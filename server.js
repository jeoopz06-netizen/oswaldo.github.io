// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import Stripe from 'stripe';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';
// import mercadopago from 'mercadopago'; // (opcional si prefieres SDK en vez de REST)
import { Resend } from 'resend';

// ===================== Inicialización =====================
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

// Frontends permitidos (coma-separado)
// Ejemplo: FRONTEND_URLS="http://localhost:5500,https://jeoopz06-netizen.github.io,https://jeoopz06-netizen.github.io/front-1,https://jeoopz06-netizen.github.io/front-2"
const FRONTEND_URLS = (process.env.FRONTEND_URLS || '').split(',').map(s => s.trim()).filter(Boolean);

// Para Stripe success/cancel
const PUBLIC_ORIGIN_DEFAULT = FRONTEND_URLS[0] || `http://localhost:${PORT}`;
const PUBLIC_ORIGIN = process.env.FRONTEND_URL || PUBLIC_ORIGIN_DEFAULT;

// ===================== CORS =====================
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // Postman/curl
    if (!FRONTEND_URLS.length) return cb(null, true); // Dev permisivo si no se configuró
    if (FRONTEND_URLS.some(o => origin.startsWith(o))) return cb(null, true);
    return cb(new Error('CORS: origin no permitido'), false);
  }
}));

// ===================== DEMO user =====================
// En tu app real, saca esto de tu sesión/JWT
app.use((req, _res, next) => {
  req.userId = 'jorge';
  next();
});

// ===================== Stripe: Webhook (ANTES del JSON parser) =====================
const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecret ? new Stripe(stripeSecret /*, { apiVersion: '2024-11-20.acacia' } */) : null;

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) {
    console.warn('[webhook] Stripe no configurado');
    return res.status(200).json({ ok: true, note: 'Stripe no configurado' });
  }

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.warn('[webhook] Falta STRIPE_WEBHOOK_SECRET en .env (dev: 200 OK sin verificar)');
    return res.status(200).json({ warning: 'Webhook no verificado (falta STRIPE_WEBHOOK_SECRET)' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[webhook] Firma inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      console.log('✅ Checkout pagado:', event.data.object.id);
      // TODO: marca orden como pagada en tu BD
      break;
    case 'payment_intent.succeeded':
      console.log('✅ PaymentIntent OK:', event.data.object.id);
      break;
    case 'payment_intent.payment_failed':
      console.log('❌ PaymentIntent falló:', event.data.object.id);
      break;
    default:
      console.log('Evento no manejado:', event.type);
  }

  res.json({ received: true });
});

// ===================== JSON + estáticos =====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // success.html / cancel.html / index.html

// ===================== 2FA (TOTP con Google Authenticator) =====================
const users2FA = new Map(); // userId -> { secretBase32, enabled }

app.get('/2fa/setup', async (req, res) => {
  try {
    const userId = req.userId;
    let user = users2FA.get(userId);

    if (!user?.secretBase32) {
      const secret = speakeasy.generateSecret({
        name: `MiApp (Cuenta de ${userId})`,
        length: 20
      });
      user = { secretBase32: secret.base32, enabled: false };
      users2FA.set(userId, user);
    }

    const issuer = 'MiApp';
    const otpauthUrl =
      `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(userId)}`
      + `?secret=${user.secretBase32}&issuer=${encodeURIComponent(issuer)}&period=30&digits=6&algorithm=SHA1`;

    const qrDataUrl = await qrcode.toDataURL(otpauthUrl);

    return res.json({
      qrDataUrl,
      // ⚠️ En producción no devuelvas el secreto:
      // secretBase32: user.secretBase32,
      // otpauthUrl,
    });
  } catch (err) {
    console.error('[2FA setup] error:', err);
    return res.status(500).json({ error: 'No se pudo iniciar 2FA' });
  }
});

app.post('/2fa/verify', (req, res) => {
  const userId = req.userId;
  const { token } = req.body || {};
  const user = users2FA.get(userId);

  if (!user?.secretBase32) {
    return res.status(400).json({ error: 'No hay secreto 2FA para este usuario' });
  }

  const valid = speakeasy.totp.verify({
    secret: user.secretBase32,
    encoding: 'base32',
    token,
    window: 1
  });

  if (!valid) return res.status(401).json({ error: 'Código inválido' });

  user.enabled = true;
  users2FA.set(userId, user);
  return res.json({ ok: true, enabled: true });
});

app.post('/2fa/validate', (req, res) => {
  const userId = req.userId;
  const { token } = req.body || {};
  const user = users2FA.get(userId);

  if (!user?.secretBase32 || !user.enabled) {
    return res.status(400).json({ error: '2FA no está habilitado para este usuario' });
  }

  const valid = speakeasy.totp.verify({
    secret: user.secretBase32,
    encoding: 'base32',
    token,
    window: 1
  });

  if (!valid) return res.status(401).json({ error: 'Código 2FA inválido' });

  return res.json({ ok: true });
});

app.post('/2fa/disable', (req, res) => {
  const userId = req.userId;
  const { confirm, token } = req.body || {};
  const user = users2FA.get(userId);

  if (!user?.secretBase32 || !user.enabled) {
    return res.status(400).json({ error: '2FA no está habilitado' });
  }

  const valid = speakeasy.totp.verify({
    secret: user.secretBase32,
    encoding: 'base32',
    token,
    window: 1
  });

  if (!confirm || !valid) {
    return res.status(401).json({ error: 'Confirmación o token inválidos' });
  }

  users2FA.set(userId, { secretBase32: user.secretBase32, enabled: false });
  return res.json({ ok: true, enabled: false });
});

// ===================== IA: Chat (Hugging Face v1/chat/completions) =====================
const HF_TOKEN = process.env.HF_TOKEN || process.env.HF_API_TOKEN; // por si cambiaste nombre
const HF_CHAT_URL = 'https://router.huggingface.co/v1/chat/completions';
const HF_MODEL = process.env.HF_MODEL || 'meta-llama/Llama-3.1-8B-Instruct';

app.post('/chat', async (req, res) => {
  const userInput = req.body?.inputs ?? '';
  const messages = [
    { role: 'system', content: 'Eres un chef experto. Responde de forma breve, clara y útil.' },
    { role: 'user', content: userInput }
  ];

  try {
    if (!HF_TOKEN) return res.status(500).json({ error: 'Falta HF_TOKEN' });

    const response = await fetch(HF_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HF_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        model: HF_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 256,
        stream: false
      })
    });

    const contentType = response.headers.get('content-type') || '';
    const status = response.status;
    const rawText = await response.text();

    if (!contentType.includes('application/json')) {
      return res.status(502).json({
        error: 'Respuesta no JSON de Hugging Face (v1/chat)',
        status,
        contentType,
        rawPreview: rawText.slice(0, 500)
      });
    }

    let data;
    try { data = JSON.parse(rawText); }
    catch { return res.status(502).json({ error: 'HF devolvió JSON inválido (v1/chat)', raw: rawText }); }

    if (status === 400) return res.status(400).json({ error: data?.error?.message || 'Solicitud inválida (400)', detail: data });
    if (status === 401) return res.status(401).json({ error: 'Auth fallida: revisa HF_TOKEN' });
    if (status === 403) return res.status(403).json({ error: 'Permisos insuficientes. Habilita billing/Serverless o cambia de modelo.' });
    if (status === 429) return res.status(429).json({ error: 'Rate limit. Intenta más tarde.' });
    if (status >= 500) return res.status(status).json({ error: 'Error en Hugging Face', detail: data });

    const text = data?.choices?.[0]?.message?.content ?? '';
    if (!text) return res.status(502).json({ error: 'Respuesta sin contenido', data });

    // Devolver en el formato que ya espera tu front
    return res.status(200).json([{ generated_text: text }]);

  } catch (err) {
    console.error('[HF Chat] error:', err);
    return res.status(500).json({ error: 'Error interno en el servidor', detail: String(err?.message || err) });
  }
});

// ===================== Stripe: Crear sesión de Checkout =====================
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Falta STRIPE_SECRET_KEY' });

    const {
      name = 'Carrito',
      amount = 19900, // centavos
      currency = 'mxn',
      quantity = 1
    } = req.body || {};

    const success_url = process.env.STRIPE_SUCCESS_URL || `${PUBLIC_ORIGIN}/success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancel_url  = process.env.STRIPE_CANCEL_URL  || `${PUBLIC_ORIGIN}/cancel.html`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency,
          product_data: { name },
          unit_amount: parseInt(amount, 10)
        },
        quantity: parseInt(quantity, 10) || 1
      }],
      success_url,
      cancel_url
    });

    return res.status(200).json({ id: session.id, url: session.url });
  } catch (err) {
    console.error('[create-checkout-session] error:', err);
    const msg = err?.raw?.message || err?.message || 'No se pudo crear la sesión de pago';
    return res.status(500).json({ error: msg });
  }
});

// ===================== Mercado Pago: Crear preferencia + email =====================
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_BASE_URL = process.env.MP_BASE_URL || process.env.BASE_URL || ''; // para back_urls (debe ser https)
const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

app.post('/api/create_preference', async (req, res) => {
  try {
    if (!MP_ACCESS_TOKEN) {
      return res.status(500).json({ error: 'MP_ACCESS_TOKEN no configurado' });
    }

    const { items = [], external_reference, payer_email } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'EMPTY_ITEMS', details: 'No hay items en la orden' });
    }

    // --- Calcula totales (para ticket) ---
    const subtotal = items.reduce((acc, it) => acc + Number(it.unit_price) * Number(it.quantity || 1), 0);
    const iva = subtotal * 0.16;
    const total = subtotal + iva;

    const productosHtml = items.map(i => `
      <tr>
        <td>${i.title}</td>
        <td>${i.quantity}</td>
        <td>$${Number(i.unit_price).toFixed(2)}</td>
      </tr>
    `).join('');

    const ticketHtml = `
      <h2>Ticket de compra</h2>
      <table border="1" cellpadding="5" cellspacing="0">
        <tr><th>Producto</th><th>Cantidad</th><th>Precio</th></tr>
        ${productosHtml}
      </table>
      <p><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</p>
      <p><strong>IVA (16%):</strong> $${iva.toFixed(2)}</p>
      <h3>Total: $${total.toFixed(2)}</h3>
      <p>Estado del pago: PROCESANDO</p>
    `;

    // --- Crear preferencia (REST) ---
    const isHttpsBase = /^https:\/\//i.test(MP_BASE_URL);

    const preference = {
      items: items.map(i => ({
        title: i.title,
        quantity: Number(i.quantity || 1),
        currency_id: 'MXN',
        unit_price: Number(i.unit_price)
      })),
      ...(payer_email ? { payer: { email: payer_email } } : {}),
      ...(isHttpsBase ? {
        back_urls: {
          success: `${MP_BASE_URL}/success.html`,
          pending: `${MP_BASE_URL}/pending.html`,
          failure: `${MP_BASE_URL}/failure.html`
        },
        auto_return: 'approved'
      } : {}),
      external_reference: external_reference || `ORDER-${Date.now()}`
    };

    const mpResp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preference)
    });

    const text = await mpResp.text();
    if (!mpResp.ok) {
      console.error('MP_ERROR', mpResp.status, text);
      return res.status(mpResp.status).json({ error: 'MP_ERROR', details: text });
    }

    const pref = JSON.parse(text);

    // --- Enviar correo (no bloqueante) ---
    if (payer_email && resend) {
      (async () => {
        try {
          await resend.emails.send({
            from: 'onboarding@resend.dev', // sandbox
            to: payer_email,
            subject: 'Tu ticket de compra',
            html: ticketHtml
          });
          console.log('📧 Ticket enviado a', payer_email);
        } catch (err) {
          console.error('❌ Error enviando correo:', err?.message || err);
        }
      })();
    }

    return res.json({
      id: pref.id,
      init_point: pref.init_point,
      sandbox_init_point: pref.sandbox_init_point
    });

  } catch (err) {
    console.error('[create_preference] SERVER_ERROR:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ===================== Health / Root =====================
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.send('Backend OK'));

// ===================== Listen =====================
app.listen(PORT, () => {
  console.log('== ENV CHECK ==');
  console.log('PORT:', PORT);
  console.log('FRONTEND_URLS:', FRONTEND_URLS);
  console.log('PUBLIC_ORIGIN:', PUBLIC_ORIGIN);
  console.log('HF_TOKEN presente:', !!HF_TOKEN);
  console.log('STRIPE_SECRET_KEY presente:', !!stripeSecret);
  console.log('MP_ACCESS_TOKEN presente:', !!MP_ACCESS_TOKEN);
  console.log(`Servidor listo en http://localhost:${PORT}`);
});
