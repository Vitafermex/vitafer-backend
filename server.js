require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const bcrypt = require('bcryptjs');

const app = express();

const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const frontendUrl = process.env.FRONTEND_URL;
const backendUrl = process.env.BACKEND_URL;

if (!mongoUri || !mpAccessToken || !frontendUrl || !backendUrl) {
  console.error("Error: Variables de entorno esenciales faltantes.");
  process.exit(1);
}

app.use(cors({
  origin: frontendUrl,
  credentials: true
}));
app.use(express.json());

let db;
const clientMongo = new MongoClient(mongoUri);

async function connectDB() {
  const dbName = 'vitafer';
  try {
    await clientMongo.connect();
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
const payment = new Payment(mpClient);

app.post('/api/auth/dispatcher/login', async (req, res) => {
  const { username, password } = req.body;
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  if (!username || !password) return res.status(400).json({ message: 'Usuario y contraseña requeridos' });
  try {
    const dispatchersCollection = db.collection('dispatchers');
    const dispatcherUser = await dispatchersCollection.findOne({ username });
    if (!dispatcherUser) return res.status(401).json({ message: 'Usuario no encontrado' });
    const isMatch = await bcrypt.compare(password, dispatcherUser.password);
    if (!isMatch) return res.status(401).json({ message: 'Contraseña incorrecta' });
    res.status(200).json({ message: 'Login exitoso', user: { username: dispatcherUser.username, role: dispatcherUser.role } });
  } catch (error) {
    console.error("Error en login de despachador:", error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

const ensureDispatcherAuthenticated = (req, res, next) => {
  console.warn("ADVERTENCIA: Ruta de despachador no está protegida adecuadamente en este momento.");
  next();
};

app.get('/api/dispatcher/orders/pending', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  try {
    const ordersCollection = db.collection('orders');
    const pendingOrders = await ordersCollection.find({ status: 'paid' }).sort({ createdAt: -1 }).toArray();
    res.status(200).json(pendingOrders);
  } catch (error) {
    console.error("Error obteniendo órdenes pendientes:", error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

app.get('/api/dispatcher/orders/shipped', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  try {
    const ordersCollection = db.collection('orders');
    const shippedOrders = await ordersCollection.find({ status: 'shipped' }).sort({ shippedAt: -1 }).toArray();
    res.status(200).json(shippedOrders);
  } catch (error) {
    console.error("Error obteniendo órdenes despachadas:", error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

app.put('/api/dispatcher/order/:orderId/dispatch', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  const { orderId } = req.params;
  const { trackingNumber } = req.body;

  if (!ObjectId.isValid(orderId)) {
    return res.status(400).json({ message: 'ID de orden inválido' });
  }

  try {
    const ordersCollection = db.collection('orders');
    const orderObjectId = new ObjectId(orderId);
    const orderToDispatch = await ordersCollection.findOne({ _id: orderObjectId });

    if (!orderToDispatch) return res.status(404).json({ message: 'Orden no encontrada' });
    if (orderToDispatch.status !== 'paid') {
      return res.status(400).json({ message: `La orden no está en estado 'paid', está en '${orderToDispatch.status}'. No se puede despachar.` });
    }
    
    const updateData = {
      status: 'shipped',
      shippedAt: new Date(),
      updatedAt: new Date()
    };
    if (trackingNumber) {
      updateData['shippingDetails.trackingNumber'] = trackingNumber;
    } else {
      // Si no se envía trackingNumber y quieres limpiarlo si existía
      updateData['shippingDetails.trackingNumber'] = null;
    }

    const result = await ordersCollection.updateOne(
      { _id: orderObjectId, status: 'paid' },
      { $set: updateData }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ message: 'Orden no encontrada o ya no está en estado "paid"' });
    }
    const updatedOrder = await ordersCollection.findOne({ _id: orderObjectId });
    res.status(200).json({ message: 'Orden marcada como despachada', order: updatedOrder });
  } catch (error) {
    console.error(`Error al marcar orden ${orderId} como despachada:`, error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

// --- NUEVO ENDPOINT PARA REVERTIR DESPACHO ---
app.put('/api/dispatcher/order/:orderId/unship', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
    const { orderId } = req.params;

    if (!ObjectId.isValid(orderId)) {
        return res.status(400).json({ message: 'ID de orden inválido' });
    }

    try {
        const ordersCollection = db.collection('orders');
        const orderObjectId = new ObjectId(orderId);

        const orderToUnship = await ordersCollection.findOne({ _id: orderObjectId });

        if (!orderToUnship) {
            return res.status(404).json({ message: 'Orden no encontrada' });
        }
        if (orderToUnship.status !== 'shipped') {
            return res.status(400).json({ message: `La orden no está en estado 'shipped', está en '${orderToUnship.status}'. No se puede revertir despacho.` });
        }

        const updateData = {
            status: 'paid', // Vuelve al estado 'paid'
            shippedAt: null, // Elimina la fecha de despacho
            'shippingDetails.trackingNumber': null, // Elimina el número de seguimiento
            updatedAt: new Date()
        };

        // $unset es más limpio para quitar campos completamente, pero null también funciona
        // const result = await ordersCollection.updateOne(
        //   { _id: orderObjectId, status: 'shipped' },
        //   { $set: { status: 'paid', updatedAt: new Date() }, $unset: { shippedAt: "", "shippingDetails.trackingNumber": "" } }
        // );
        const result = await ordersCollection.updateOne(
            { _id: orderObjectId, status: 'shipped' },
            { $set: updateData }
        );


        if (result.modifiedCount === 0) {
            return res.status(404).json({ message: 'Orden no encontrada o ya no está en estado "shipped"' });
        }
        const updatedOrder = await ordersCollection.findOne({ _id: orderObjectId });
        res.status(200).json({ message: 'Despacho de orden revertido', order: updatedOrder });

    } catch (error) {
        console.error(`Error al revertir despacho de orden ${orderId}:`, error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});


app.post('/api/create-preference', async (req, res) => {
  const orderData = req.body;

  if (!db) return res.status(500).json({ message: 'Error interno: Sin conexión a base de datos' });
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
        paymentDetails: { method: 'mercadopago', mercadoPagoPreferenceId: null, mercadoPagoPaymentId: null, paymentStatus: 'pending', paidAt: null },
        shippingDetails: { method: "Por definir", cost: 0, trackingNumber: null },
        createdAt: new Date(), updatedAt: new Date(),
        referralCode: orderData.referralCode || '001'
    };
    if (isNaN(newOrder.totalAmount)) return res.status(400).json({ message: 'El monto total de la orden es inválido.' });
    if (newOrder.items.some(item => isNaN(item.unitPrice))) return res.status(400).json({ message: 'Uno o más precios unitarios son inválidos.' });

    const savedOrder = await ordersCollection.insertOne(newOrder);
    const orderId = savedOrder.insertedId;
    console.log(`Orden ${orderId} creada en colección "orders" de DB "vitafer".`);

    const preferenceData = {
       body: {
         items: newOrder.items.map(item => ({
           id: item.name.substring(0, 250), title: item.name.substring(0, 250), description: (item.presentation || '').substring(0, 250),
           quantity: item.quantity, unit_price: item.unitPrice, currency_id: 'MXN',
         })),
         payer: { name: orderData.customerDetails.name, email: orderData.customerDetails.email, phone: { number: orderData.customerDetails.phone }, },
         back_urls: {
             success: `${frontendUrl}/payment-success?order_id=${orderId.toString()}`,
             failure: `${frontendUrl}/payment-failure?order_id=${orderId.toString()}`,
             pending: `${frontendUrl}/payment-pending?order_id=${orderId.toString()}`,
         },
         notification_url: `${backendUrl}/api/mercadopago-webhook?source_news=webhooks&orderId=${orderId.toString()}`,
         external_reference: orderId.toString(),
       }
    };
    if (process.env.AUTO_RETURN_MP === 'approved') { preferenceData.body.auto_return = 'approved'; }
    const mpPreference = await preference.create(preferenceData);
    await ordersCollection.updateOne(
        { _id: orderId },
        { $set: { 'paymentDetails.mercadoPagoPreferenceId': mpPreference.id, status: 'pending_payment', updatedAt: new Date() } }
    );
    res.status(201).json({ mercadoPagoUrl: mpPreference.init_point });
  } catch (error) {
    console.error('Error detallado al crear preferencia:', error.cause || error.message || error);
    let errorMessage = 'Error interno del servidor al crear la preferencia';
    const mpError = error.cause?.error || error.cause || error.message;
    if (typeof mpError === 'string') { errorMessage = mpError; }
    else if (mpError?.message) { errorMessage = mpError.message; }
    res.status(error.status || 500).json({ message: errorMessage });
  }
});

app.post('/api/mercadopago-webhook', async (req, res) => {
  console.log("Webhook recibido:", req.query); console.log("Webhook body:", req.body);
  const { query, body } = req;
  const topic = query.topic || query.type;
  const orderIdFromQuery = query.orderId;

  if (topic === 'payment' || body?.type === 'payment') {
    const paymentId = body?.data?.id;
    console.log(`Webhook: Notificación de pago recibida. Payment ID: ${paymentId}, Order ID de query: ${orderIdFromQuery}`);
    if (paymentId && db) {
      try {
        console.log(`Consultando estado del pago ${paymentId} a MercadoPago...`);
        const paymentInfoResult = await payment.get({ id: paymentId.toString() });
        console.log("Respuesta de MP al consultar pago:", JSON.stringify(paymentInfoResult, null, 2));
        const paymentData = paymentInfoResult;
        const paymentStatus = paymentData?.status;
        const externalReference = paymentData?.external_reference;
        let orderObjectId;
        if (externalReference) { orderObjectId = new ObjectId(externalReference); }
        else if (orderIdFromQuery) { console.warn(`Usando orderId de query param para webhook...`); orderObjectId = new ObjectId(orderIdFromQuery); }
        else { console.error(`Error: No se pudo determinar el ID de la orden...`); return res.sendStatus(200); }
        const ordersCollection = db.collection('orders');
        console.log(`Procesando webhook para pago ${paymentId}, Orden ObjectId: ${orderObjectId}`);
        let newOrderStatus;
        let paymentDetailsUpdate = { 'paymentDetails.mercadoPagoPaymentId': paymentId.toString(), 'paymentDetails.paymentStatus': paymentStatus, updatedAt: new Date() };
        if (paymentStatus === 'approved') { newOrderStatus = 'paid'; paymentDetailsUpdate['paymentDetails.paidAt'] = new Date(); }
        else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(paymentStatus)) { newOrderStatus = 'failed'; }
        else if (paymentStatus === 'in_process' || paymentStatus === 'pending') { newOrderStatus = 'pending_payment'; }
        else { console.log(`Estado de pago '${paymentStatus}' no reconocido...`); await ordersCollection.updateOne({ _id: orderObjectId }, { $set: paymentDetailsUpdate }); return res.sendStatus(200); }
        if (newOrderStatus) {
           paymentDetailsUpdate.status = newOrderStatus;
           const updateResult = await ordersCollection.updateOne({ _id: orderObjectId }, { $set: paymentDetailsUpdate });
           if (updateResult.modifiedCount > 0) { console.log(`Orden ${orderObjectId} actualizada a ${newOrderStatus}...`); }
           else { const existingOrder = await ordersCollection.findOne({ _id: orderObjectId }); console.log(`Orden ${orderObjectId} no actualizada por webhook... Estado actual: ${existingOrder?.status}. Estado MP: ${paymentStatus}.`); }
        }
      } catch (err) { console.error(`Error procesando webhook para pago ${paymentId}:`, err.cause || err.message || err); }
    } else { console.log("Webhook ignorado: Faltan paymentId o conexión a DB."); }
  } else { console.log(`Webhook ignorado: Tópico no manejado '${topic}' o tipo no es 'payment'`); }
  res.sendStatus(200);
});

app.use((err, req, res, next) => {
    console.error("Error no manejado:", err.stack);
    res.status(500).json({ message: 'Error interno del servidor' });
});

app.listen(port, () => {
  console.log(`Backend escuchando en ${backendUrl} (Puerto: ${port})`);
});