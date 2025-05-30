require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const bcrypt = require('bcryptjs');
// const { sendOrderConfirmationEmail } = require('./services/emailService'); // Mantén comentado si no lo tienes
// const { formatMXN } = require('./utils/formatters'); // Mantén comentado si no lo tienes

const app = express();

const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const frontendUrl = process.env.FRONTEND_URL; // Sigue siendo usado para las back_urls
const backendUrl = process.env.BACKEND_URL;

const allowedOrigins = [
  'https://vitafermex.com',
  'https://www.vitafermex.com',
  'http://localhost:5173' // Para desarrollo local, si lo necesitas
];

if (!mongoUri || !mpAccessToken || !process.env.FRONTEND_URL || !backendUrl) {
  console.error("Error: Faltan variables de entorno esenciales (MONGO_URI, MERCADOPAGO_ACCESS_TOKEN, FRONTEND_URL para referencia, BACKEND_URL).");
  process.exit(1);
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.warn(`Origen no permitido por CORS: ${origin}`);
      callback(new Error('Origen no permitido por CORS'));
    }
  },
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

const getOrdersWithEmployeeData = async (statusCriteria, sortCriteria) => {
  const ordersCollection = db.collection('orders');
  const aggregationPipeline = [
    { $match: statusCriteria },
    { $lookup: { from: "employees", localField: "referralCode", foreignField: "referralCode", as: "referredByEmployeeInfo" } },
    { $unwind: { path: "$referredByEmployeeInfo", preserveNullAndEmptyArrays: true } },
    { $project: { customerDetails: 1, items: 1, totalAmount: 1, status: 1, paymentDetails: 1, shippingDetails: 1, createdAt: 1, updatedAt: 1, shippedAt: 1, referralCode: 1, referredByEmployeeName: "$referredByEmployeeInfo.name" } },
    { $sort: sortCriteria }
  ];
  return await ordersCollection.aggregate(aggregationPipeline).toArray();
};

app.get('/api/dispatcher/orders/pending', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  try {
    const pendingOrders = await getOrdersWithEmployeeData({ status: 'paid' }, { createdAt: -1 });
    res.status(200).json(pendingOrders);
  } catch (error) {
    console.error("Error obteniendo órdenes pendientes:", error);
    res.status(500).json({ message: 'Error interno del servidor al obtener órdenes pendientes' });
  }
});

app.get('/api/dispatcher/orders/shipped', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  try {
    const shippedOrders = await getOrdersWithEmployeeData({ status: 'shipped' }, { shippedAt: -1 });
    res.status(200).json(shippedOrders);
  } catch (error) {
    console.error("Error obteniendo órdenes despachadas:", error);
    res.status(500).json({ message: 'Error interno del servidor al obtener órdenes despachadas' });
  }
});

app.put('/api/dispatcher/order/:orderId/dispatch', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
  const { orderId } = req.params;
  const { trackingNumber } = req.body;
  if (!ObjectId.isValid(orderId)) return res.status(400).json({ message: 'ID de orden inválido' });
  try {
    const ordersCollection = db.collection('orders');
    const orderObjectId = new ObjectId(orderId);
    const orderToDispatch = await ordersCollection.findOne({ _id: orderObjectId });
    if (!orderToDispatch) return res.status(404).json({ message: 'Orden no encontrada' });
    if (orderToDispatch.status !== 'paid') return res.status(400).json({ message: `La orden no está en estado 'paid'.` });
    const updateData = { status: 'shipped', shippedAt: new Date(), updatedAt: new Date() };
    if (trackingNumber) { updateData['shippingDetails.trackingNumber'] = trackingNumber; }
    else { updateData['shippingDetails.trackingNumber'] = null; }
    const result = await ordersCollection.updateOne({ _id: orderObjectId, status: 'paid' }, { $set: updateData });
    if (result.modifiedCount === 0) return res.status(404).json({ message: 'Orden no encontrada o ya no está en estado "paid"' });
    const updatedOrderData = await getOrdersWithEmployeeData({ _id: orderObjectId }, {});
    res.status(200).json({ message: 'Orden marcada como despachada', order: updatedOrderData[0] || null });
  } catch (error) {
    console.error(`Error al marcar orden ${orderId} como despachada:`, error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

app.put('/api/dispatcher/order/:orderId/unship', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
    const { orderId } = req.params;
    if (!ObjectId.isValid(orderId)) return res.status(400).json({ message: 'ID de orden inválido' });
    try {
        const ordersCollection = db.collection('orders');
        const orderObjectId = new ObjectId(orderId);
        const orderToUnship = await ordersCollection.findOne({ _id: orderObjectId });
        if (!orderToUnship) return res.status(404).json({ message: 'Orden no encontrada' });
        if (orderToUnship.status !== 'shipped') return res.status(400).json({ message: `La orden no está en estado 'shipped'.` });
        const updateData = { status: 'paid', shippedAt: null, 'shippingDetails.trackingNumber': null, updatedAt: new Date() };
        const result = await ordersCollection.updateOne({ _id: orderObjectId, status: 'shipped' }, { $set: updateData });
        if (result.modifiedCount === 0) return res.status(404).json({ message: 'Orden no encontrada o ya no está en estado "shipped"' });
        const updatedOrderData = await getOrdersWithEmployeeData({ _id: orderObjectId }, {});
        res.status(200).json({ message: 'Despacho de orden revertido', order: updatedOrderData[0] || null });
    } catch (error) {
        console.error(`Error al revertir despacho de orden ${orderId}:`, error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// --- Endpoint para obtener stock de productos ---
app.post('/api/products/stock', async (req, res) => {
    if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
    const { productIds } = req.body;

    if (!Array.isArray(productIds)) {
        return res.status(400).json({ message: 'Se requiere un array de productIds en el cuerpo' });
    }
    if (productIds.length === 0) {
        return res.status(200).json({});
    }

    try {
        const inventoryCollection = db.collection('products'); // Usa tu nueva colección de inventario
        const stockData = await inventoryCollection.find({ productId: { $in: productIds } }).toArray();
        
        const stockMap = {};
        stockData.forEach(item => {
            stockMap[item.productId] = item.stock;
        });

        productIds.forEach(id => {
            if (!(id in stockMap)) {
                stockMap[id] = 0; // Asume stock 0 si no está en la colección de inventario
            }
        });
        
        res.status(200).json(stockMap);
    } catch (error) {
        console.error("Error obteniendo stock de productos:", error);
        res.status(500).json({ message: 'Error interno al obtener stock' });
    }
});

// --- Endpoint para que el Despachador actualice el stock ---
app.put('/api/dispatcher/product/:productId/stock', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).json({ message: 'Error de conexión con la base de datos' });
    const { productId } = req.params; // Este es el ID de tus constantes (ej. "vitafer-l-500ml")
    const { newStock } = req.body;

    if (typeof newStock !== 'number' || newStock < 0 || !Number.isInteger(newStock)) {
        return res.status(400).json({ message: 'La cantidad de stock debe ser un número entero no negativo.' });
    }
    if (!productId || typeof productId !== 'string') {
        return res.status(400).json({ message: 'ID de producto inválido o requerido' });
    }
    
    try {
        const inventoryCollection = db.collection('products'); // Usa tu nueva colección de inventario
        const result = await inventoryCollection.updateOne(
            { productId: productId },
            { $set: { stock: newStock }, $setOnInsert: { productId: productId } }, // Si es nuevo, guarda productId y stock
            { upsert: true } // Crea el documento si no existe
        );

        if (result.upsertedCount > 0 || result.modifiedCount > 0 || result.matchedCount > 0 ) {
             const updatedProductStock = await inventoryCollection.findOne({productId: productId});
             res.status(200).json({ message: 'Stock actualizado exitosamente', product: updatedProductStock });
        } else {
             res.status(404).json({ message: 'No se pudo actualizar el stock (producto no encontrado y upsert no funcionó como esperado).' });
        }
    } catch (error) {
        console.error(`Error al actualizar stock para producto ${productId}:`, error);
        res.status(500).json({ message: 'Error interno del servidor al actualizar stock' });
    }
});

// --- Endpoint de Crear Preferencia MODIFICADO para usar la nueva colección de stock ---
app.post('/api/create-preference', async (req, res) => {
  const orderData = req.body; // items deben tener 'id' (tu productId de constantes) y 'quantity' deseada
  const currentFrontendUrl = req.get('origin');

  if (!db) return res.status(500).json({ message: 'Error interno: Sin conexión a base de datos' });
  if (!orderData || !orderData.customerDetails || !orderData.items || orderData.items.length === 0) {
      return res.status(400).json({ message: 'Datos de la orden inválidos o incompletos' });
  }

  const ordersCollection = db.collection('orders');
  const inventoryCollection = db.collection('products'); // Tu nueva colección de inventario
  const session = clientMongo.startSession(); // Inicia una sesión para transacciones
  
  let createdOrderId;
  let itemsForRollback = []; // Para guardar qué items se les descontó stock

  try {
    await session.withTransaction(async (currentSession) => {
      // 1. Verificar stock para todos los items
      for (const item of orderData.items) {
        if (!item.id || typeof item.id !== 'string') { // El frontend envía 'id' que es tu 'productId'
          throw new Error(`Item del carrito "${item.name}" no tiene un ID de producto válido.`);
        }
        const productInInventory = await inventoryCollection.findOne({ productId: item.id }, { session: currentSession });
        if (!productInInventory || productInInventory.stock < item.quantity) {
          throw new Error(`Stock insuficiente para "${item.name}". Disponible: ${productInInventory?.stock || 0}, Solicitado: ${item.quantity}.`);
        }
      }

      // 2. Si hay stock, descontar de la colección 'products'
      for (const item of orderData.items) {
        const updateResult = await inventoryCollection.updateOne(
          { productId: item.id, stock: { $gte: item.quantity } }, // Condición para evitar race conditions
          { $inc: { stock: -item.quantity } },
          { session: currentSession }
        );
        if (updateResult.modifiedCount === 0) { // Si no se modificó, el stock cambió o no fue suficiente
            throw new Error(`No se pudo actualizar el stock para "${item.name}". Pudo agotarse o hubo un conflicto. Intenta de nuevo.`);
        }
        itemsForRollback.push({ productId: item.id, quantity: item.quantity }); // Guarda para posible rollback
        console.log(`Stock descontado para ${item.id}: ${item.quantity} unidades.`);
      }

      // 3. Crear la orden en la colección 'orders'
      const newOrder = {
          customerDetails: orderData.customerDetails,
          items: orderData.items.map(i => ({
              productId: i.id, // Guarda el productId que viene del frontend
              name: i.name,
              presentation: i.presentation,
              quantity: i.quantity,
              unitPrice: parseFloat(i.unit_price) || 0,
              totalItemPrice: i.quantity * (parseFloat(i.unit_price) || 0)
          })),
          totalAmount: parseFloat(orderData.totalAmount) || 0,
          status: 'pending_payment', // Se crea como 'pending_payment' ya que el stock se descontó
          paymentDetails: { method: 'mercadopago', mercadoPagoPreferenceId: null, mercadoPagoPaymentId: null, paymentStatus: 'pending', paidAt: null },
          shippingDetails: { method: "Por definir", cost: 0, trackingNumber: null },
          createdAt: new Date(),
          updatedAt: new Date(),
          referralCode: orderData.referralCode || null
      };
      if (isNaN(newOrder.totalAmount)) throw new Error('El monto total de la orden es inválido.');
      if (newOrder.items.some(item => isNaN(item.unitPrice))) throw new Error('Uno o más precios unitarios son inválidos.');

      const savedOrder = await ordersCollection.insertOne(newOrder, { session: currentSession });
      createdOrderId = savedOrder.insertedId;
      console.log(`Orden ${createdOrderId} creada (Referido: ${newOrder.referralCode || 'Ninguno'}) con estado 'pending_payment'.`);
    }); // Fin de session.withTransaction

    // Si la transacción de MongoDB fue exitosa, createdOrderId tendrá un valor
    // Procedemos a crear la preferencia de MercadoPago
    const effectiveFrontendUrl = allowedOrigins.includes(currentFrontendUrl) ? currentFrontendUrl : allowedOrigins[0];
    const preferenceItems = orderData.items.map(item => ({
        id: item.id, // Este es tu productId
        title: item.name.substring(0, 250),
        description: (item.presentation || '').substring(0, 250),
        quantity: item.quantity,
        unit_price: parseFloat(item.unit_price) || 0,
        currency_id: 'MXN',
    }));

    const preferenceData = {
       body: {
         items: preferenceItems,
         payer: { name: orderData.customerDetails.name, email: orderData.customerDetails.email, phone: { number: orderData.customerDetails.phone }, },
         back_urls: { success: `${effectiveFrontendUrl}/payment-success?order_id=${createdOrderId.toString()}`, failure: `${effectiveFrontendUrl}/payment-failure?order_id=${createdOrderId.toString()}`, pending: `${effectiveFrontendUrl}/payment-pending?order_id=${createdOrderId.toString()}`, },
         notification_url: `${backendUrl}/api/mercadopago-webhook?source_news=webhooks&orderId=${createdOrderId.toString()}`,
         external_reference: createdOrderId.toString(),
       }
    };
    if (process.env.AUTO_RETURN_MP === 'approved') { preferenceData.body.auto_return = 'approved'; }

    const mpPreference = await preference.create(preferenceData);
    console.log(`Preferencia MP ${mpPreference.id} creada para orden ${createdOrderId}`);
    
    await ordersCollection.updateOne( // Actualiza la orden con el preferenceId de MP
        { _id: createdOrderId },
        { $set: { 'paymentDetails.mercadoPagoPreferenceId': mpPreference.id, updatedAt: new Date() } }
    );
    res.status(201).json({ mercadoPagoUrl: mpPreference.init_point });

  } catch (error) { // Captura errores de la transacción de MongoDB o de la creación de preferencia MP
    console.error('Error en /api/create-preference:', error.message || error);
    
    // Si el error ocurrió DESPUÉS de descontar stock (itemsForRollback tiene datos)
    // Y el error NO es un error de stock (ya que eso se maneja dentro de la transacción)
    // Esto podría ser un error al crear la preferencia de MP o al actualizar la orden con el preferenceId
    if (itemsForRollback.length > 0 && !error.message.toLowerCase().includes('stock')) {
        console.warn("Error DESPUÉS de transacción de stock. Intentando revertir descuento de stock...");
        for (const { productId, quantity } of itemsForRollback) {
            try {
                await inventoryCollection.updateOne(
                    { productId: productId },
                    { $inc: { stock: quantity } } // Devuelve el stock
                );
                console.log(`Stock (rollback) revertido para ${productId}: ${quantity} unidades.`);
            } catch (revertError) {
                console.error(`FALLO CRÍTICO (ROLLBACK): No se pudo revertir el stock para ${productId}. Revisar manualmente. Error:`, revertError);
            }
        }
    }
    res.status(error.message.includes("Stock insuficiente") || error.message.includes("No se pudo actualizar el stock") ? 400 : 500)
       .json({ message: error.message || 'Error interno del servidor al crear la preferencia', errorType: error.message.includes("Stock") ? 'STOCK_ERROR' : 'SERVER_ERROR' });
  } finally {
    await session.endSession(); // Siempre cierra la sesión de MongoDB
  }
});

// --- Webhook MODIFICADO para revertir stock en pagos fallidos ---
app.post('/api/mercadopago-webhook', async (req, res) => {
  console.log("Webhook recibido:", req.query); console.log("Webhook body:", req.body);
  const { query, body } = req;
  const topic = query.topic || query.type;

  if (topic === 'payment' || body?.type === 'payment') {
    const paymentId = body?.data?.id;
    console.log(`Webhook: Notificación de pago recibida. Payment ID: ${paymentId}.`);
    if (paymentId && db) {
      const session = clientMongo.startSession(); // Usa sesión para las actualizaciones
      try {
        await session.withTransaction(async (currentSession) => {
            const paymentInfoResult = await payment.get({ id: paymentId.toString() });
            console.log("Respuesta de MP al consultar pago:", JSON.stringify(paymentInfoResult, null, 2));
            
            const paymentData = paymentInfoResult;
            const paymentStatusFromMP = paymentData?.status;
            const externalReference = paymentData?.external_reference; 

            if (!externalReference) {
                console.error(`Error webhook: external_reference no encontrado en pago ${paymentId}.`);
                throw new Error(`external_reference faltante para pago ${paymentId}`); // Aborta la transacción
            }
            const orderObjectId = new ObjectId(externalReference);
            
            const ordersCollection = db.collection('orders');
            const inventoryCollection = db.collection('products');
            const order = await ordersCollection.findOne({_id: orderObjectId}, { session: currentSession });

            if (!order) {
                console.error(`Webhook: Orden ${orderObjectId} no encontrada en DB para pago ${paymentId}.`);
                throw new Error(`Orden ${orderObjectId} no encontrada para pago ${paymentId}`); // Aborta la transacción
            }
            console.log(`Procesando webhook para pago ${paymentId}, Orden ${orderObjectId}. Estado actual DB: ${order.status}`);

            let newOrderStatusInDB;
            let paymentDetailsUpdate = { 
                'paymentDetails.mercadoPagoPaymentId': paymentId.toString(), 
                'paymentDetails.paymentStatus': paymentStatusFromMP,
                updatedAt: new Date() 
            };

            if (paymentStatusFromMP === 'approved') { 
                newOrderStatusInDB = 'paid'; 
                paymentDetailsUpdate['paymentDetails.paidAt'] = new Date(); 
                // El stock ya se descontó al crear la preferencia. Aquí solo confirmamos.
            } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(paymentStatusFromMP)) { 
                newOrderStatusInDB = 'failed';
                // Revertir stock SOLO si la orden estaba en 'pending_payment'
                // (lo que significa que el stock se descontó pero el pago final falló)
                if (order.status === 'pending_payment') {
                    console.warn(`Pago ${paymentId} para orden ${orderObjectId} es ${paymentStatusFromMP}. Revertiendo stock...`);
                    for (const item of order.items) {
                        // item.productId debe existir en los items de la orden
                        if (!item.productId) {
                             console.error(`Falta productId en item de orden ${orderObjectId} para revertir stock.`);
                             continue; // Salta este item pero continúa con otros si es posible
                        }
                        await inventoryCollection.updateOne(
                            { productId: item.productId },
                            { $inc: { stock: item.quantity } },
                            { session: currentSession }
                        );
                        console.log(`Stock (webhook) revertido para ${item.productId}: ${item.quantity} unidades.`);
                    }
                } else {
                    console.log(`Orden ${orderObjectId} con estado ${order.status}. No se revierte stock para pago ${paymentStatusFromMP}.`);
                }
            } else if (paymentStatusFromMP === 'in_process' || paymentStatusFromMP === 'pending') { 
                newOrderStatusInDB = 'pending_payment'; 
            } else { 
                console.log(`Estado de pago MP '${paymentStatusFromMP}' no manejado para cambio de estado principal de orden ${orderObjectId}. Solo actualizando detalles de pago.`); 
                await ordersCollection.updateOne({ _id: orderObjectId }, { $set: paymentDetailsUpdate }, {session: currentSession}); 
                return;
            }
            
            if (newOrderStatusInDB && (order.status !== newOrderStatusInDB || order.paymentDetails.paymentStatus !== paymentStatusFromMP)) {
               paymentDetailsUpdate.status = newOrderStatusInDB;
               const updateResult = await ordersCollection.updateOne({ _id: orderObjectId }, { $set: paymentDetailsUpdate }, {session: currentSession});
               if (updateResult.modifiedCount > 0) { 
                   console.log(`Orden ${orderObjectId} actualizada a ${newOrderStatusInDB}.`); 
                   if (newOrderStatusInDB === 'paid' && order.customerDetails?.email) {
                        const emailOrderDetails = {
                            id: order._id.toString(), customerName: order.customerDetails.name,
                            items: order.items, totalAmount: order.totalAmount,
                            customerDetails: order.customerDetails,
                            formatPrice: (value) => typeof value === 'number' ? value.toLocaleString('es-MX', {style:'currency', currency:'MXN', minimumFractionDigits:0}) : '$0'
                        };

                        console.log(`SIMULACIÓN: Enviando email de confirmación para orden ${orderObjectId}`);
                   }
               } else { 
                   console.log(`Orden ${orderObjectId} no actualizada por webhook (quizás ya tenía el estado correcto).`); 
               }
            } else {
                console.log(`Orden ${orderObjectId} ya tiene el estado ${newOrderStatusInDB} y paymentStatus ${paymentStatusFromMP}.`);
            }
        });
      } catch (err) { 
          console.error(`Error CRÍTICO procesando webhook para pago ${paymentId} con transacción:`, err.cause || err.message || err);
      } finally {
          await session.endSession();
      }
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