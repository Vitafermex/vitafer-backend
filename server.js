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
    // --- Especifica el nombre de tu base de datos aquí ---
    const dbName = 'vitafer';
    db = clientMongo.db(dbName);
    console.log(`Conectado a MongoDB Atlas - Usando DB: ${db.databaseName}`);

    // Intenta hacer ping para confirmar la conexión a la base de datos específica
    await db.command({ ping: 1 });
    console.log(`Ping a la base de datos "${dbName}" exitoso.`);

  } catch (error) {
    // Si falla aquí, puede ser problema con la URI, permisos del usuario, o red.
    console.error(`Error conectando a MongoDB o a la base de datos "${'vitafer'}":`, error);
    process.exit(1);
  }
}
connectDB(); // Llama a la función para conectar al iniciar

const mpClient = new MercadoPagoConfig({ accessToken: mpAccessToken });
const preference = new Preference(mpClient);

// --- Endpoint para Crear Orden y Preferencia de Pago ---
app.post('/api/create-preference', async (req, res) => {
  const orderData = req.body;

  if (!db) {
    return res.status(500).json({ message: 'Error interno: Sin conexión a base de datos' });
  }
  if (!orderData || !orderData.customerDetails || !orderData.items || orderData.items.length === 0) {
      return res.status(400).json({ message: 'Datos de la orden inválidos o incompletos' });
  }

  // --- Asegúrate de usar el nombre correcto de la colección aquí ---
  const ordersCollection = db.collection('orders');

  try {
    const newOrder = {
        customerDetails: orderData.customerDetails,
        items: orderData.items.map(item => ({
            name: item.name,
            presentation: item.presentation,
            quantity: item.quantity,
            unitPrice: parseFloat(item.unit_price) || 0, // Asegura que sea número
            totalItemPrice: item.quantity * (parseFloat(item.unit_price) || 0)
        })),
        totalAmount: orderData.totalAmount, // Asegúrate que esto también sea número
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

    // Valida que totalAmount sea número antes de insertar
     if (isNaN(newOrder.totalAmount)) {
        console.error("Error: totalAmount no es un número válido", orderData.totalAmount);
        return res.status(400).json({ message: 'El monto total de la orden es inválido.' });
     }
     // Valida que todos los unitPrice sean números
     if (newOrder.items.some(item => isNaN(item.unitPrice))) {
        console.error("Error: Al menos un unitPrice no es un número válido", newOrder.items);
        return res.status(400).json({ message: 'Uno o más precios unitarios son inválidos.' });
     }


    const savedOrder = await ordersCollection.insertOne(newOrder);
    const orderId = savedOrder.insertedId;

    console.log(`Orden ${orderId} creada en colección "orders" de DB "vitafer".`);

    // --- Creación de Preferencia MP (asegurando unit_price como número) ---
    const preferenceData = {
       body: {
         items: newOrder.items.map(item => ({ // Usa los items ya validados/parseados
           id: item.name.substring(0, 100),
           title: item.name,
           description: item.presentation || '',
           quantity: item.quantity,
           unit_price: item.unitPrice, // Ya es número
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
         notification_url: `${backendUrl}/api/mercadopago-webhook?source_news=webhooks&orderId=${orderId}`,
         external_reference: orderId.toString(),
       }
    };

    console.log("Enviando datos a MercadoPago:", JSON.stringify(preferenceData, null, 2)); // Log para ver qué se envía a MP
    const mpPreference = await preference.create(preferenceData);
    console.log(`Preferencia ${mpPreference.id} creada para orden ${orderId}`);

    // --- Actualizar Orden con Preference ID ---
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
    // Intenta extraer el mensaje específico de MercadoPago si existe
    if (error?.cause?.[0]?.description) {
        errorMessage = error.cause[0].description;
    } else if (error.message) {
        errorMessage = error.message;
    } else if (typeof error === 'string') {
        errorMessage = error;
    }
    // Devuelve el error más específico si lo hay
    res.status(error.status || 500).json({ message: errorMessage });
  }
});


// --- Endpoint Webhook (actualizado para usar colección correcta) ---
app.post('/api/mercadopago-webhook', async (req, res) => {
  console.log("Webhook recibido:", req.query);
  const { query, body } = req;
  const topic = query.topic || query.type;
  const orderIdFromQuery = query.orderId;

  if (topic === 'payment') {
      const paymentId = query.id || body?.data?.id;
      console.log(`Payment ID recibido: ${paymentId}`);

      if(orderIdFromQuery && paymentId && db) {
          try {
              const orderObjectId = new ObjectId(orderIdFromQuery);
              const ordersCollection = db.collection('orders'); // Usa la colección correcta

              console.log(`Procesando webhook para pago ${paymentId}, Orden ${orderIdFromQuery}`);

              // --- IMPORTANTE: Implementar consulta REAL a MP aquí ---
              const paymentStatus = 'approved'; // !!! SIMULACIÓN !!!
              console.warn(`!!! SIMULANDO estado de pago '${paymentStatus}' para ${paymentId}. Implementa consulta real a MP !!!`);

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
                  if (updateResult.modifiedCount > 0) console.log(`Orden ${orderIdFromQuery} actualizada a PAGADA.`);
                  else console.log(`Orden ${orderIdFromQuery} no actualizada (quizás ya estaba pagada o no se encontró).`);

              } else if (paymentStatus === 'rejected' || paymentStatus === 'cancelled' || paymentStatus === 'refunded') {
                   const updateResult = await ordersCollection.updateOne(
                      { _id: orderObjectId }, { $set: { status: 'failed', 'paymentDetails.mercadoPagoPaymentId': paymentId.toString(), 'paymentDetails.paymentStatus': paymentStatus, updatedAt: new Date() } }
                  );
                   if (updateResult.modifiedCount > 0) console.log(`Orden ${orderIdFromQuery} actualizada a FALLIDA/RECHAZADA.`);
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

// --- Middleware y Listener (sin cambios) ---
app.use((err, req, res, next) => {
    console.error("Error no manejado:", err.stack);
    res.status(500).json({ message: 'Error interno del servidor' });
});

app.listen(port, () => {
  console.log(`Backend escuchando en ${backendUrl} (Puerto: ${port})`);
});