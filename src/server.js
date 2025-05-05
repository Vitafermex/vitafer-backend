require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();

const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const frontendUrl = process.env.FRONTEND_URL;
const backendUrl = process.env.BACKEND_URL;

if (!mongoUri || !mpAccessToken || !frontendUrl || !backendUrl) {
  console.error("Error: Faltan variables de entorno esenciales (MONGO_URI, MERCADOPAGO_ACCESS_TOKEN, FRONTEND_URL, BACKEND_URL).");
  process.exit(1);
}

app.use(cors({
  origin: frontendUrl
}));
app.use(express.json());

let db;
const clientMongo = new MongoClient(mongoUri);

async function connectDB() {
  try {
    await clientMongo.connect();
    db = clientMongo.db();
    console.log("Conectado a MongoDB Atlas");
  } catch (error) {
    console.error("Error conectando a MongoDB:", error);
    process.exit(1);
  }
}
connectDB();

const mpClient = new MercadoPagoConfig({ accessToken: mpAccessToken });
const preference = new Preference(mpClient);

app.post('/api/create-preference', async (req, res) => {
  const orderData = req.body;

  if (!db) {
    return res.status(500).json({ message: 'Error interno: Sin conexión a base de datos' });
  }
  if (!orderData || !orderData.customerDetails || !orderData.items || orderData.items.length === 0) {
      return res.status(400).json({ message: 'Datos de la orden inválidos o incompletos' });
  }


  try {
    const ordersCollection = db.collection('orders');
    const newOrder = {
        customerDetails: orderData.customerDetails,
        items: orderData.items,
        totalAmount: orderData.totalAmount,
        status: 'pending_preference',
        createdAt: new Date(),
    };
    const savedOrder = await ordersCollection.insertOne(newOrder);
    const orderId = savedOrder.insertedId;

    console.log(`Orden ${orderId} pre-guardada en MongoDB.`);

    const preferenceData = {
       body: {
         items: orderData.items.map(item => ({
           id: item.name.substring(0, 100),
           title: item.name,
           description: item.presentation || '',
           quantity: item.quantity,
           unit_price: item.unit_price,
           currency_id: 'MXN',
         })),
         payer: {
             name: orderData.customerDetails.name,
             email: orderData.customerDetails.email,
             phone: {
                number: orderData.customerDetails.phone,
             },
         },
         back_urls: {
             success: `${frontendUrl}/payment-success`,
             failure: `${frontendUrl}/payment-failure`,
             pending: `${frontendUrl}/payment-pending`,
         },
         auto_return: 'approved',
         notification_url: `${backendUrl}/api/mercadopago-webhook?source_news=webhooks&orderId=${orderId}`,
         external_reference: orderId.toString(),
       }
    };

    const mpPreference = await preference.create(preferenceData);
    console.log(`Preferencia ${mpPreference.id} creada para orden ${orderId}`);

    await ordersCollection.updateOne(
        { _id: orderId },
        { $set: { preferenceId: mpPreference.id, status: 'pending_payment' } }
    );
    res.status(201).json({ preferenceId: mpPreference.id });

  } catch (error) {
    console.error('Error detallado al crear preferencia:', error?.cause || error);
    res.status(500).json({ message: error.message || 'Error interno del servidor al crear la preferencia' });
  }
});


app.post('/api/mercadopago-webhook', async (req, res) => {
  console.log("Webhook recibido:", req.query, req.body);
  const { query, body } = req;
  const topic = query.topic || query.type;
  const orderIdFromQuery = query.orderId;

  console.log(`Webhook: topic=${topic}, orderId=${orderIdFromQuery}`);

  if (topic === 'payment') {
      const paymentId = query.id || body?.data?.id;
      console.log(`Payment ID recibido: ${paymentId}`);
      if(orderIdFromQuery && db) {
          try {
              const orderObjectId = new ObjectId(orderIdFromQuery);
              const ordersCollection = db.collection('orders');
              console.log(`Webhook procesado (simulado) para orden ${orderIdFromQuery}`);
          } catch (err) {
              console.error(`Error procesando webhook para orden ${orderIdFromQuery}:`, err);
          }
      }
  }

  res.sendStatus(200);
});

app.use((err, req, res, next) => {
    console.error("Error no manejado:", err.stack);
    res.status(500).json({ message: 'Error interno del servidor' });
});


app.listen(port, () => {
  console.log(`Backend escuchando en ${backendUrl}`);
});