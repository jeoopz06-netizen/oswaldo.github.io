import express from "express";
import cors from "cors";
import mercadopago from "mercadopago";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Configurar Mercado Pago
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

// 📧 Configurar correo
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// 🧮 Función para calcular subtotal, IVA y total
function calcularTotales(items) {
  const subtotal = items.reduce((acc, item) => {
    return acc + Number(item.unit_price) * Number(item.quantity);
  }, 0);

  const iva = subtotal * 0.16;
  const total = subtotal + iva;

  return { subtotal, iva, total };
}

// 🟢 Endpoint principal
// 🟢 Endpoint principal
app.post("/api/create_preference", async (req, res) => {
  try {
    console.log("📩 Petición recibida");

    const { items = [], payer_email } = req.body;

    if (!items.length) {
      return res.status(400).json({ error: "NO_ITEMS" });
    }

    // 🔹 Calcular totales
    const { subtotal, iva, total } = calcularTotales(items);

    // 🔹 Generar HTML del ticket
    const productosHtml = items
      .map(
        (i) => `
        <tr>
          <td>${i.title}</td>
          <td>${i.quantity}</td>
          <td>$${i.unit_price}</td>
        </tr>
      `
      )
      .join("");

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

    console.log("📧 Enviando correo a:", payer_email);

    // 🔹 Enviar correo
    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: payer_email || process.env.EMAIL_USER,
      subject: "Tu ticket de compra",
      html: ticketHtml,
    });

    console.log("✅ Correo enviado:", info.response);

    // 🔹 Crear preferencia Mercado Pago
    const preference = await mercadopago.preferences.create({
      items: items,
      back_urls: {
        success: "https://tu-dominio.com/success",
        failure: "https://tu-dominio.com/failure",
        pending: "https://tu-dominio.com/pending",
      },
      auto_return: "approved",
    });

    res.json({
      id: preference.body.id,
    });

  } catch (error) {
    console.error("❌ Error en el servidor:", error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: error.message,
    });
  }
});

    // 🔹 Enviar correo (aunque falle el pago)
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: payer_email || process.env.EMAIL_USER,
      subject: "Tu ticket de compra",
      html: ticketHtml,
    });

    // 🔹 Crear preferencia Mercado Pago
    const preference = await mercadopago.preferences.create({
      items: items,
      back_urls: {
        success: "https://tu-dominio.com/success",
        failure: "https://tu-dominio.com/failure",
        pending: "https://tu-dominio.com/pending",
      },
      auto_return: "approved",
    });

    res.json({
      id: preference.body.id,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "SERVER_ERROR",
      message: error.message,
    });
  }
});

// 🟢 Puerto Render
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});

