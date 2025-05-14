require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago'); // Importa Payment

const app = express();

const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const frontendUrl = process.env.FRONTEND_URL;
const backendUrl = process.env.BACKEND_URL;

if (!mongoUri || !mpAccessToken || !frontendUrl || !backendUrl) {
  console.error("Error: Faltan variables de entorno esenciales (MONGO_URI, MERCADOPAGO_ACCESS_TOKEN, FRONTEND_URL, BACKEND_URL). Verifica la configuración en Render.");
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
    const dbName = 'vitafer';
    db = clientMongo.db(dbName);
    console.log(`Conectado a MongoDB Atlas - Usando DB: ${db.databaseName}`);
    await db.command({ ping: 1 });
    console.log(`Ping a la base de datos "${dbName}" exitoso.`);
  } catch (error) {
    console.error(`Error conectando a MongoDB o a la base de datos "${dbName}":`, error);
    process.exit(1);
  }
}
connectDB();

const mpClient = new MercadoPagoConfig({ accessToken: mpAccessToken });
const preference = new Preference(mpClient);
const payment = new Payment(mpClient); // Crea una instancia del cliente de Payment

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
            unitPrice: parseFloat(item.unit_price) || 0,
            totalItemPrice: item.quantity * (parseFloat(item.unit_price) || 0)
        })),
        totalAmount: parseFloat(orderData.totalAmount) || 0,
        status: 'pending_preference',
        paymentDetails: {
            method: 'mercadopago',
            mercadoPagoPreferenceId: null,
            mercadoPagoPaymentId: null,
            paymentStatus: 'pending',
            paidAt: null
        },
        shippingDetails: { method: "Por definir", cost: 0, trackingNumber: null },
        createdAt: new Date(),
        updatedAt: new Date()
    };

    if (isNaN(newOrder.totalAmount)) {
        console.error("Error: totalAmount no es un número válido", orderData.totalAmount);
        return res.status(400).json({ message: 'El monto total de la orden es inválido.' });
    }
    if (newOrder.items.some(item => isNaN(item.unitPrice))) {
        console.error("Error: Al menos un unitPrice no es un número válido", newOrder.items);
        return res.status(400).json({ message: 'Uno o más precios unitarios son inválidos.' });
    }

    const savedOrder = await ordersCollection.insertOne(newOrder);
    const orderId = savedOrder.insertedId;
    console.log(`Orden ${orderId} creada en colección "orders" de DB "vitafer".`);

    const preferenceData = {
       body: {
         items: newOrder.items.map(item => ({
           id: item.name.substring(0, 250), // Límite de ID de MP
           title: item.name.substring(0, 250), // Límite de título de MP
           description: (item.presentation || '').substring(0, 250),
           quantity: item.quantity,
           unit_price: item.unitPrice,
           currency_id: 'MXN',
         })),
         payer: {
             name: orderData.customerDetails.name,
             email: orderData.customerDetails.email,
             phone: { number: orderData.customerDetails.phone },
         },
         back_urls: {
             success: `${frontendUrl}/payment-success?order_id=${orderId.toString()}`,
             failure: `${frontendUrl}/payment-failure?order_id=${orderId.toString()}`,
             pending: `${frontendUrl}/payment-pending?order_id=${orderId.toString()}`,
         },
         notification_url: `${backendUrl}/api/mercadopago-webhook?source_news=webhooks&orderId=${orderId.toString()}`,
         external_reference: orderId.toString(),
       }
    };
    if (process.env.AUTO_RETURN_MP === 'approved') { // Opcional: si quieres controlar auto_return por .env
        preferenceData.body.auto_return = 'approved';
    }

    console.log("Enviando datos a MercadoPago:", JSON.stringify(preferenceData, null, 2));
    const mpPreference = await preference.create(preferenceData);
    console.log(`Preferencia ${mpPreference.id} creada para orden ${orderId}`);
    console.log(`Init Point (URL de pago): ${mpPreference.init_point}`);

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
    res.status(201).json({ mercadoPagoUrl: mpPreference.init_point });
  } catch (error) {
    console.error('Error detallado al crear preferencia:', error.cause || error.message || error);
    let errorMessage = 'Error interno del servidor al crear la preferencia';
    // MercadoPago a veces devuelve el error en error.cause.error
    const mpError = error.cause?.error || error.cause || error.message;
    if (typeof mpError === 'string') {
        errorMessage = mpError;
    } else if (mpError?.message) {
        errorMessage = mpError.message;
    }

    res.status(error.status || 500).json({ message: errorMessage });
  }
});

app.post('/api/mercadopago-webhook', async (req, res) => {
  console.log("Webhook recibido:", req.query);
  console.log("Webhook body:", req.body);

  const { query, body } = req;
  const topic = query.topic || query.type; // MP usa 'type' para notificaciones IPN y 'topic' para Webhooks
  const orderIdFromQuery = query.orderId;

  if (topic === 'payment' || body?.type === 'payment') {
    const paymentId = body?.data?.id;

    console.log(`Webhook: Notificación de pago recibida. Payment ID: ${paymentId}, Order ID de query: ${orderIdFromQuery}`);

    if (paymentId && db) {
      try {
        console.log(`Consultando estado del pago ${paymentId} a MercadoPago...`);
        const paymentInfoResult = await payment.get({ id: paymentId.toString() });
        
        console.log("Respuesta de MP al consultar pago:", JSON.stringify(paymentInfoResult, null, 2));

        const paymentData = paymentInfoResult; // El SDK v2 devuelve el objeto directamente
        const paymentStatus = paymentData?.status;
        const externalReference = paymentData?.external_reference; // Este es tu orderId

        let orderObjectId;

        if (externalReference) { // Prioriza external_reference
            orderObjectId = new ObjectId(externalReference);
        } else if (orderIdFromQuery) {
            console.warn(`Usando orderId de query param para webhook, external_reference no encontrado o diferente en pago ${paymentId}.`);
            orderObjectId = new ObjectId(orderIdFromQuery);
        } else {
            console.error(`Error: No se pudo determinar el ID de la orden desde el webhook para pago ${paymentId}.`);
            return res.sendStatus(200); // Responde OK a MP, pero no podemos procesar.
        }
        
        const ordersCollection = db.collection('orders');
        console.log(`Procesando webhook para pago ${paymentId}, Orden ObjectId: ${orderObjectId}`);

        let newOrderStatus;
        let paymentDetailsUpdate = {
            'paymentDetails.mercadoPagoPaymentId': paymentId.toString(),
            'paymentDetails.paymentStatus': paymentStatus, // Estado real de MP
            updatedAt: new Date()
        };

        if (paymentStatus === 'approved') {
          newOrderStatus = 'paid';
          paymentDetailsUpdate['paymentDetails.paidAt'] = new Date();
        } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(paymentStatus)) {
          newOrderStatus = 'failed';
        } else if (paymentStatus === 'in_process' || paymentStatus === 'pending') {
          newOrderStatus = 'pending_payment'; // O un estado más específico como 'processing'
        } else {
          console.log(`Estado de pago '${paymentStatus}' no reconocido o no requiere cambio de estado principal para orden ${orderObjectId}.`);
          // Solo actualizamos paymentDetails.paymentStatus si no es un estado final
          await ordersCollection.updateOne({ _id: orderObjectId }, { $set: paymentDetailsUpdate });
          return res.sendStatus(200);
        }

        if (newOrderStatus) {
           paymentDetailsUpdate.status = newOrderStatus;
           const updateResult = await ordersCollection.updateOne(
                { _id: orderObjectId }, // No condicionar por status si MP puede enviar varios webhooks
                { $set: paymentDetailsUpdate }
            );

            if (updateResult.modifiedCount > 0) {
                console.log(`Orden ${orderObjectId} actualizada a ${newOrderStatus} basado en el pago ${paymentId}.`);
            } else {
                const existingOrder = await ordersCollection.findOne({ _id: orderObjectId });
                console.log(`Orden ${orderObjectId} no actualizada por el webhook (modCount: ${updateResult.modifiedCount}). Estado actual: ${existingOrder?.status}. Estado MP: ${paymentStatus}.`);
            }
        }

      } catch (err) {
        console.error(`Error procesando webhook para pago ${paymentId}:`, err.cause || err.message || err);
      }
    } else {
       console.log("Webhook ignorado: Faltan paymentId o conexión a DB.");
    }
  } else {
    console.log(`Webhook ignorado: Tópico no manejado '${topic}' o tipo no es 'payment'`);
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