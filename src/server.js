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
    const dbName = new URL(mongoUri).pathname.substring(1);
    db = clientMongo.db(dbName || undefined); 
    if (!db.databaseName) {
        console.warn("Advertencia: No se pudo determinar el nombre de la base de datos desde MONGO_URI. Asegúrate de incluirlo en la URI o especificarlo en clientMongo.db('tu_db').");
    }
    console.log(`Conectado a MongoDB Atlas - DB: ${db.databaseName}`);
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

  const ordersCollection = db.collection('orders');

  try {
    const newOrder = {
        customerDetails: orderData.customerDetails,
        items: orderData.items.map(item => ({
            name: item.name,
            presentation: item.presentation,
            quantity: item.quantity,
            unitPrice: item.unit_price,
            totalItemPrice: item.quantity * item.unit_price
        })),
        totalAmount: orderData.totalAmount,
        status: 'pending_preference',
        paymentDetails: {
            method: 'mercadopago',
            mercadoPagoPreferenceId: null,
            mercadoPagoPaymentId: null,
            paymentStatus: 'pending',
            paidAt: null
        },
        shippingDetails: {
            method: "Por definir",
            cost: 0,
            trackingNumber: null
        },
        createdAt: new Date(),
        updatedAt: new Date()
    };
    const savedOrder = await ordersCollection.insertOne(newOrder);
    const orderId = savedOrder.insertedId;

    console.log(`Orden ${orderId} creada en MongoDB.`);

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
             phone: { number: orderData.customerDetails.phone },
         },
         back_urls: {
             success: `${frontendUrl}/payment-success?order_id=${orderId}`,
             failure: `${frontendUrl}/payment-failure?order_id=${orderId}`,
             pending: `${frontendUrl}/payment-pending?order_id=${orderId}`,
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
        {
            $set: {
                'paymentDetails.mercadoPagoPreferenceId': mpPreference.id,
                status: 'pending_payment',
                updatedAt: new Date()
            }
        }
    );
    res.status(201).json({ preferenceId: mpPreference.id });

  } catch (error) {
    console.error('Error detallado al crear preferencia:', error?.cause || error);
    let errorMessage = 'Error interno del servidor al crear la preferencia';
    if (error.message) {
        errorMessage = error.message;
    } else if (typeof error === 'string') {
        errorMessage = error;
    }
    res.status(500).json({ message: errorMessage });
  }
});


app.post('/api/mercadopago-webhook', async (req, res) => {
  console.log("Webhook recibido:", req.query);

  const { query, body } = req;
  const topic = query.topic || query.type;
  const orderIdFromQuery = query.orderId;

  console.log(`Webhook: topic=${topic}, orderId=${orderIdFromQuery}`);


  if (topic === 'payment') {
      const paymentId = query.id || body?.data?.id;
      console.log(`Payment ID recibido: ${paymentId}`);

      if(orderIdFromQuery && paymentId && db) {
          try {
              const orderObjectId = new ObjectId(orderIdFromQuery);
              const ordersCollection = db.collection('orders');

              console.log(`Procesando webhook para pago ${paymentId}, Orden ${orderIdFromQuery}`);

              // --- IMPORTANTE: Aquí deberías consultar el pago a MercadoPago ---
              // const paymentInfo = await payment.get({ id: paymentId }); // Usando el SDK de MP
              // const paymentStatus = paymentInfo?.status; // ej. 'approved', 'rejected'
              // const externalReference = paymentInfo?.external_reference;

              // --- SIMULACIÓN (Reemplaza con la consulta real a MP) ---
              const paymentStatus = 'approved';
              console.warn(`!!! SIMULANDO estado de pago '${paymentStatus}' para ${paymentId}. Implementa consulta real a MP !!!`);
              // --- FIN SIMULACIÓN ---


              if (paymentStatus === 'approved') {
                 const updateResult = await ordersCollection.updateOne(
                      { _id: orderObjectId, status: { $ne: 'paid' } },
                      {
                          $set: {
                              status: 'paid',
                              'paymentDetails.mercadoPagoPaymentId': paymentId.toString(),
                              'paymentDetails.paymentStatus': paymentStatus,
                              'paymentDetails.paidAt': new Date(),
                              updatedAt: new Date()
                          }
                      }
                  );
                  if (updateResult.modifiedCount > 0) {
                      console.log(`Orden ${orderIdFromQuery} actualizada a PAGADA.`);
                  } else {
                      console.log(`Orden ${orderIdFromQuery} no actualizada (quizás ya estaba pagada o no se encontró).`);
                  }

              } else if (paymentStatus === 'rejected' || paymentStatus === 'cancelled' || paymentStatus === 'refunded') {
                   const updateResult = await ordersCollection.updateOne(
                      { _id: orderObjectId },
                      {
                          $set: {
                              status: 'failed',
                              'paymentDetails.mercadoPagoPaymentId': paymentId.toString(),
                              'paymentDetails.paymentStatus': paymentStatus,
                              updatedAt: new Date()
                          }
                      }
                  );
                   if (updateResult.modifiedCount > 0) {
                      console.log(`Orden ${orderIdFromQuery} actualizada a FALLIDA/RECHAZADA.`);
                  }
              } else {
                   console.log(`Estado de pago '${paymentStatus}' recibido para orden ${orderIdFromQuery}, no requiere acción inmediata de estado.`);
              }

          } catch (err) {
              console.error(`Error procesando webhook para orden ${orderIdFromQuery}:`, err);
          }
      } else {
         console.log("Webhook ignorado: Faltan datos (orderId, paymentId) o conexión a DB.");
      }
  } else {
      console.log(`Webhook ignorado: Tópico no manejado '${topic}'`);
  }

  res.sendStatus(200);
});

app.use((err, req, res, next) => {
    console.error("Error no manejado:", err.stack);
    res.status(500).json({ message: 'Error interno del servidor' });
});


app.listen(port, () => {
  console.log(`Backend escuchando en ${backendUrl} (Puerto: ${port})`);
});