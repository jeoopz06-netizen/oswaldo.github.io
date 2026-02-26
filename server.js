// 🟢 Endpoint principal
app.post("/api/create_preference", async (req, res) => {
  try {
    console.log("📩 Petición recibida");

    const { items = [], payer_email } = req.body;

    if (!items.length) {
      return res.status(400).json({ error: "NO_ITEMS" });
    }

    const { subtotal, iva, total } = calcularTotales(items);

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

    const info = await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: payer_email || process.env.EMAIL_USER,
      subject: "Tu ticket de compra",
      html: ticketHtml,
    });

    console.log("✅ Correo enviado:", info.response);

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


