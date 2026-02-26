// server/index.js
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from "nodemailer";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BASE_URL = process.env.BASE_URL || '';
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!MP_ACCESS_TOKEN) {
  console.warn('⚠️ MP_ACCESS_TOKEN no está definido.');
}

const isHttpsBase = BASE_URL.startsWith('https://');

/* =========================
   CONFIGURACIÓN EMAIL
========================= */

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/* =========================
   CREAR PREFERENCIA
========================= */

app.post('/api/create_preference', async (req, res) => {
  try {
    const { items = [], external_reference, payer_email } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'EMPTY_ITEMS',
        details: 'No hay items en la orden'
      });
    }

    /* =========================
       CALCULAR TICKET
    ========================= */

    const subtotal = items.reduce(
      (acc, item) => acc + Number(item.unit_price) * Number(item.quantity),
      0
    );

    const iva = subtotal * 0.16;
    const total = subtotal + iva;

    const productosHtml = items.map(i => `
      <tr>
        <td>${i.title}</td>
        <td>${i.quantity}</td>
        <td>$${Number(i.unit_price).toFixed(2)}</td>
      </tr>
    `).join("");

    const ticketHtml = `
      <h2>Ticket de compra</h2>
      <table border="1" cellpadding="5" cellspacing="0">
        <tr>
          <th>Producto</th>
          <th>Cantidad</th>
          <th>Precio</th>
        </tr>
        ${productosHtml}
      </table>
      <p><strong>Subtotal:</strong> $${subtotal.toFixed(2)}</p>
      <p><strong>IVA (16%):</strong> $${iva.toFixed(2)}</p>
      <h3>Total: $${total.toFixed(2)}</h3>
      <p>Estado del pago: PROCESANDO</p>
    `;

    /* =========================
       CREAR PREFERENCIA MP
    ========================= */

    const preference = {
      items: items.map(i => ({
        title: i.title,
        quantity: Number(i.quantity),
        currency_id: 'MXN',
        unit_price: Number(i.unit_price),
      })),
      ...(payer_email ? { payer: { email: payer_email } } : {}),
      ...(isHttpsBase ? {
        back_urls: {
          success: `${BASE_URL}/success.html`,
          pending: `${BASE_URL}/pending.html`,
          failure: `${BASE_URL}/failure.html`,
        },
        auto_return: 'approved',
      } : {}),
      external_reference: external_reference || `ORDER-${Date.now()}`,
    };

    const mpResp = await fetch(
      'https://api.mercadopago.com/checkout/preferences',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(preference),
      }
    );

    const text = await mpResp.text();

    if (!mpResp.ok) {
      console.error('MP_ERROR', mpResp.status, text);
      return res.status(mpResp.status).json({
        error: 'MP_ERROR',
        details: text
      });
    }

    const pref = JSON.parse(text);

    /* =========================
       ENVIAR CORREO (NO BLOQUEA)
    ========================= */

    if (payer_email && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: payer_email,
        subject: "Tu ticket de compra",
        html: ticketHtml,
      }).catch(err => {
        console.error("❌ Error enviando correo:", err.message);
      });
    }

    /* =========================
       RESPUESTA AL FRONTEND
    ========================= */

    return res.json({
      id: pref.id,
      init_point: pref.init_point,
      sandbox_init_point: pref.sandbox_init_point,
    });

  } catch (err) {
    console.error("SERVER_ERROR:", err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/* =========================
   SERVER
========================= */

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`MP server running on http://localhost:${PORT}`)
);
