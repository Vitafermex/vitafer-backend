require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

const port = process.env.PORT || 3000;
const mongoUri = process.env.MONGO_URI;
const mpAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
const frontendUrl = process.env.FRONTEND_URL;
const backendUrl = process.env.BACKEND_URL;
const jwtSecret = process.env.JWT_SECRET;

const allowedOrigins = [
  'https://vitafermex.com',
  'https://www.vitafermex.com',
  'http://localhost:5173'
];

if (!mongoUri || !mpAccessToken || !frontendUrl || !backendUrl || !jwtSecret) {
  process.exit(1);
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(null, true); 
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
    await db.command({ ping: 1 });
    console.log(`Conectado a MongoDB Atlas - DB: ${dbName}`);
  } catch (error) {
    console.error("Error conectando a DB:", error);
    process.exit(1);
  }
}
connectDB();

const mpClient = new MercadoPagoConfig({ accessToken: mpAccessToken });
const preference = new Preference(mpClient);
const payment = new Payment(mpClient);

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Acceso denegado' });

  jwt.verify(token, jwtSecret, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token inválido' });
    req.user = user;
    next();
  });
};

const ensureDispatcherAuthenticated = (req, res, next) => {
  next();
};

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, phone, address, city, state, postalCode } = req.body;
  if (!db) return res.status(500).send();
  if (!email || !password || !name) return res.status(400).json({ message: 'Faltan datos obligatorios' });

  try {
    const usersCollection = db.collection('users');
    const existingUser = await usersCollection.findOne({ email });
    if (existingUser) return res.status(400).json({ message: 'El correo ya está registrado' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      name,
      email,
      phone: phone || '',
      address: address || '',
      city: city || '',
      state: state || '',
      postalCode: postalCode || '',
      password: hashedPassword,
      spins: 1, 
      progressAmount: 0, // Inicializamos saldo en 0
      prizes: [],
      createdAt: new Date()
    };
    
    const result = await usersCollection.insertOne(newUser);
    const token = jwt.sign({ id: result.insertedId, email }, jwtSecret, { expiresIn: '7d' });
    
    res.status(201).json({ token, user: { id: result.insertedId, name, email, spins: 1 } });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!db) return res.status(500).send();

  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Usuario no encontrado' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Contraseña incorrecta' });

    const token = jwt.sign({ id: user._id, email: user.email }, jwtSecret, { expiresIn: '7d' });
    res.json({ 
        token, 
        user: { 
            id: user._id, 
            name: user.name, 
            email: user.email, 
            phone: user.phone,
            spins: user.spins || 0,
            progressAmount: user.progressAmount || 0, // Enviamos el saldo al frontend
            address: user.address,
            city: user.city,
            state: user.state,
            postalCode: user.postalCode
        } 
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!db) return res.status(500).json({ message: 'Error DB' });

  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    const resetToken = crypto.randomInt(100000, 999999).toString();
    const resetTokenExpire = Date.now() + 3600000; 

    await usersCollection.updateOne(
      { email },
      { $set: { resetToken, resetTokenExpire } }
    );

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Recuperación de Contraseña - Vitafer',
      text: `Tu código de recuperación es: ${resetToken}\n\nEste código expira en 1 hora.`,
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'Correo enviado' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error al enviar el correo' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, token, newPassword } = req.body;
  if (!db) return res.status(500).json({ message: 'Error DB' });

  try {
    const usersCollection = db.collection('users');
    const user = await usersCollection.findOne({
      email,
      resetToken: token,
      resetTokenExpire: { $gt: Date.now() }
    });

    if (!user) return res.status(400).json({ message: 'Token inválido o expirado' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await usersCollection.updateOne(
      { _id: user._id },
      {
        $set: { password: hashedPassword },
        $unset: { resetToken: "", resetTokenExpire: "" }
      }
    );

    res.json({ message: 'Contraseña actualizada correctamente' });

  } catch (error) {
    res.status(500).json({ message: 'Error al restablecer contraseña' });
  }
});

app.get('/api/user/data', verifyToken, async (req, res) => {
  if (!db) return res.status(500).send();
  try {
    const userId = new ObjectId(req.user.id);
    const usersCollection = db.collection('users');
    const ordersCollection = db.collection('orders');

    const user = await usersCollection.findOne({ _id: userId }, { projection: { password: 0 } });
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    const orders = await ordersCollection.find({ userId: req.user.id }).sort({ createdAt: -1 }).toArray();

    res.json({ 
      user: { ...user, progressAmount: user.progressAmount || 0 },
      orders,
      prizes: user.prizes || []
    });
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo datos' });
  }
});

app.post('/api/user/spin', verifyToken, async (req, res) => {
  if (!db) return res.status(500).send();
  try {
    const userId = new ObjectId(req.user.id);
    const usersCollection = db.collection('users');

    const user = await usersCollection.findOne({ _id: userId });
    if (!user || (user.spins || 0) <= 0) {
      return res.status(400).json({ message: 'No tienes giros disponibles' });
    }

    const rand = Math.random() * 100;
    let prizeName = "Sigue intentando";
    let isWin = false;

    if (rand < 25) { 
        prizeName = "Casilla Vacia"; 
        isWin = false;
    } else if (rand < 62.5) { 
        prizeName = "1 Sachet Vitafer"; 
        isWin = true;
    } else if (rand < 87.5) { 
        prizeName = "2 Sachets Vitafer"; 
        isWin = true;
    } else { 
        prizeName = "3 Sachets Vitafer"; 
        isWin = true;
    }

    const updateQuery = { $inc: { spins: -1 } };
    if (isWin) {
        updateQuery.$push = { 
            prizes: { 
                _id: new ObjectId(), 
                name: prizeName, 
                date: new Date(), 
                status: 'pending_delivery'
            } 
        };
    }

    await usersCollection.updateOne({ _id: userId }, updateQuery);

    res.json({ 
        prize: prizeName, 
        isWin,
        remainingSpins: user.spins - 1 
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en la ruleta' });
  }
});

app.put('/api/dispatcher/user/:userId/prize/:prizeId/dispatch', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { userId, prizeId } = req.params;
    try {
        const usersCollection = db.collection('users');
        const result = await usersCollection.updateOne(
            { _id: new ObjectId(userId), "prizes._id": new ObjectId(prizeId) },
            { $set: { "prizes.$.status": "shipped", "prizes.$.shippedAt": new Date() } }
        );
        if (result.modifiedCount === 0) return res.status(404).json({ message: 'No modificado' });
        res.status(200).json({ message: 'Premio despachado' });
    } catch (error) {
        res.status(500).send();
    }
});

// --- Gestión de Dispatcher ---

app.post('/api/auth/dispatcher/login', async (req, res) => {
  const { username, password } = req.body;
  if (!db) return res.status(500).json({ message: 'Error DB' });
  try {
    const dispatchersCollection = db.collection('dispatchers');
    const dispatcherUser = await dispatchersCollection.findOne({ username });
    if (!dispatcherUser) return res.status(401).json({ message: 'Usuario no encontrado' });
    const isMatch = await bcrypt.compare(password, dispatcherUser.password);
    if (!isMatch) return res.status(401).json({ message: 'Contraseña incorrecta' });
    res.status(200).json({ message: 'Login exitoso', user: { username: dispatcherUser.username, role: dispatcherUser.role } });
  } catch (error) {
    res.status(500).json({ message: 'Error servidor' });
  }
});

app.get('/api/dispatcher/orders/pending', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).send();
  try {
    const ordersCollection = db.collection('orders');
    const pendingOrders = await ordersCollection.aggregate([
        { $match: { status: 'paid' } },
        { $lookup: { from: "employees", localField: "referralCode", foreignField: "referralCode", as: "referredByEmployeeInfo" } },
        { $unwind: { path: "$referredByEmployeeInfo", preserveNullAndEmptyArrays: true } },
        { $sort: { createdAt: -1 } }
    ]).toArray();
    res.status(200).json(pendingOrders);
  } catch (error) {
    res.status(500).send();
  }
});

app.get('/api/dispatcher/orders/shipped', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).send();
  try {
    const ordersCollection = db.collection('orders');
    const shippedOrders = await ordersCollection.aggregate([
        { $match: { status: 'shipped' } },
        { $lookup: { from: "employees", localField: "referralCode", foreignField: "referralCode", as: "referredByEmployeeInfo" } },
        { $unwind: { path: "$referredByEmployeeInfo", preserveNullAndEmptyArrays: true } },
        { $sort: { shippedAt: -1 } }
    ]).toArray();
    res.status(200).json(shippedOrders);
  } catch (error) {
    res.status(500).send();
  }
});

app.put('/api/dispatcher/order/:orderId/dispatch', ensureDispatcherAuthenticated, async (req, res) => {
  if (!db) return res.status(500).send();
  const { orderId } = req.params;
  const { trackingNumber } = req.body;
  try {
    const ordersCollection = db.collection('orders');
    const orderObjectId = new ObjectId(orderId);
    const updateData = { status: 'shipped', shippedAt: new Date(), updatedAt: new Date() };
    if (trackingNumber) updateData['shippingDetails.trackingNumber'] = trackingNumber;
    
    await ordersCollection.updateOne({ _id: orderObjectId }, { $set: updateData });
    res.status(200).json({ message: 'Orden despachada' });
  } catch (error) {
    res.status(500).send();
  }
});

app.put('/api/dispatcher/order/:orderId/unship', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { orderId } = req.params;
    try {
        const ordersCollection = db.collection('orders');
        const updateData = { status: 'paid', shippedAt: null, 'shippingDetails.trackingNumber': null, updatedAt: new Date() };
        await ordersCollection.updateOne({ _id: new ObjectId(orderId) }, { $set: updateData });
        res.status(200).json({ message: 'Revertido' });
    } catch (error) {
        res.status(500).send();
    }
});

app.get('/api/dispatcher/users', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    try {
        const usersCollection = db.collection('users');
        const users = await usersCollection.find({}, { projection: { password: 0 } }).sort({ createdAt: -1 }).toArray();
        res.status(200).json(users);
    } catch (error) {
        res.status(500).send();
    }
});

app.post('/api/dispatcher/users', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { name, email, password, phone, spins } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Datos incompletos' });
    
    try {
        const usersCollection = db.collection('users');
        const existing = await usersCollection.findOne({ email });
        if (existing) return res.status(400).json({ message: 'Email ya registrado' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            name, email, phone, password: hashedPassword,
            spins: parseInt(spins) || 0,
            progressAmount: 0,
            prizes: [],
            createdAt: new Date()
        };
        await usersCollection.insertOne(newUser);
        res.status(201).json({ message: 'Usuario creado' });
    } catch (error) {
        res.status(500).send();
    }
});

app.put('/api/dispatcher/user/:userId', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { userId } = req.params;
    const { spins } = req.body;
    try {
        const usersCollection = db.collection('users');
        await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { spins: parseInt(spins) } });
        res.status(200).json({ message: 'Usuario actualizado' });
    } catch (error) {
        res.status(500).send();
    }
});

app.delete('/api/dispatcher/user/:userId', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { userId } = req.params;
    try {
        const usersCollection = db.collection('users');
        await usersCollection.deleteOne({ _id: new ObjectId(userId) });
        res.status(200).json({ message: 'Usuario eliminado' });
    } catch (error) {
        res.status(500).send();
    }
});

app.get('/api/dispatcher/user/:userId/details', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { userId } = req.params;
    try {
        const usersCollection = db.collection('users');
        const ordersCollection = db.collection('orders');
        
        const user = await usersCollection.findOne({ _id: new ObjectId(userId) }, { projection: { password: 0 } });
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        const orders = await ordersCollection.find({ userId: userId }).sort({ createdAt: -1 }).toArray();
        
        res.status(200).json({ user, orders });
    } catch (error) {
        res.status(500).send();
    }
});

app.post('/api/dispatcher/user/:userId/manual-purchase', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { userId } = req.params;
    const { amount } = req.body;
    const purchaseAmount = parseFloat(amount);

    if (isNaN(purchaseAmount) || purchaseAmount <= 0) {
        return res.status(400).json({ message: 'Monto inválido' });
    }

    try {
        const usersCollection = db.collection('users');
        const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        const SPIN_THRESHOLD = 500;
        let currentProgress = user.progressAmount || 0;
        let totalPool = currentProgress + purchaseAmount;
        
        const newSpins = Math.floor(totalPool / SPIN_THRESHOLD);
        const newProgress = totalPool % SPIN_THRESHOLD;

        await usersCollection.updateOne(
            { _id: new ObjectId(userId) },
            { 
                $inc: { spins: newSpins },
                $set: { progressAmount: newProgress }
            }
        );

        res.status(200).json({ 
            message: 'Compra registrada', 
            addedSpins: newSpins, 
            newProgress 
        });
    } catch (error) {
        res.status(500).send();
    }
});

app.post('/api/products/data', async (req, res) => {
    if (!db) return res.status(500).send();
    const { productIds } = req.body;
    try {
        const inventoryCollection = db.collection('products');
        const productData = await inventoryCollection.find({ productId: { $in: productIds } }).toArray();
        const dataMap = {};
        productData.forEach(item => { dataMap[item.productId] = { stock: item.stock, price: item.price }; });
        res.status(200).json(dataMap);
    } catch (error) {
        res.status(500).send();
    }
});

app.post('/api/products/stock', async (req, res) => {
    if (!db) return res.status(500).send();
    const { productIds } = req.body;
    try {
        const inventoryCollection = db.collection('products');
        const stockData = await inventoryCollection.find({ productId: { $in: productIds } }).toArray();
        const stockMap = {};
        stockData.forEach(item => { stockMap[item.productId] = item.stock; });
        productIds.forEach(id => { if (!(id in stockMap)) stockMap[id] = 0; });
        res.status(200).json(stockMap);
    } catch (error) {
        res.status(500).send();
    }
});

app.put('/api/dispatcher/product/:productId/update', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { productId } = req.params;
    const { newStock, newPrice } = req.body;
    try {
        const inventoryCollection = db.collection('products');
        const updateFields = {};
        if (newStock !== undefined) updateFields.stock = newStock;
        if (newPrice !== undefined) updateFields.price = newPrice;
        
        await inventoryCollection.updateOne(
            { productId: productId },
            { $set: updateFields, $setOnInsert: { productId: productId } },
            { upsert: true }
        );
        res.status(200).json({ message: 'Producto actualizado' });
    } catch (error) {
        res.status(500).send();
    }
});

app.put('/api/dispatcher/product/:productId/stock', ensureDispatcherAuthenticated, async (req, res) => {
    if (!db) return res.status(500).send();
    const { productId } = req.params;
    const { newStock } = req.body;
    try {
        const inventoryCollection = db.collection('products');
        await inventoryCollection.updateOne(
            { productId: productId },
            { $set: { stock: newStock }, $setOnInsert: { productId: productId } },
            { upsert: true }
        );
        res.status(200).json({ message: 'Stock actualizado' });
    } catch (error) {
        res.status(500).send();
    }
});

app.post('/api/create-preference', async (req, res) => {
  const orderData = req.body;
  const currentFrontendUrl = req.get('origin');
  if (!db) return res.status(500).send();

  const ordersCollection = db.collection('orders');
  const inventoryCollection = db.collection('products');
  const session = clientMongo.startSession();
  
  let createdOrderId;
  let itemsForRollback = [];

  try {
    await session.withTransaction(async (currentSession) => {
      for (const item of orderData.items) {
        const productInInventory = await inventoryCollection.findOne({ productId: item.id }, { session: currentSession });
        if (!productInInventory || productInInventory.stock < item.quantity) {
          throw new Error(`Stock insuficiente para ${item.name}`);
        }
      }

      for (const item of orderData.items) {
        await inventoryCollection.updateOne(
          { productId: item.id },
          { $inc: { stock: -item.quantity } },
          { session: currentSession }
        );
        itemsForRollback.push({ productId: item.id, quantity: item.quantity });
      }

      const newOrder = {
        userId: orderData.userId || null,
        customerDetails: orderData.customerDetails,
        items: orderData.items.map(i => ({
          productId: i.id,
          name: i.name,
          presentation: i.presentation,
          quantity: i.quantity,
          unitPrice: parseFloat(i.unit_price) || 0,
          totalItemPrice: i.quantity * (parseFloat(i.unit_price) || 0)
        })),
        totalAmount: parseFloat(orderData.totalAmount) || 0,
        status: 'pending_payment',
        paymentDetails: { method: 'mercadopago', paymentStatus: 'pending' },
        shippingDetails: { method: "Por definir", trackingNumber: null },
        createdAt: new Date(),
        updatedAt: new Date(),
        referralCode: orderData.referralCode || null
      };

      const savedOrder = await ordersCollection.insertOne(newOrder, { session: currentSession });
      createdOrderId = savedOrder.insertedId;
    });

    const effectiveFrontendUrl = allowedOrigins.includes(currentFrontendUrl) ? currentFrontendUrl : allowedOrigins[0];
    const preferenceItems = orderData.items.map(item => ({
      id: item.id,
      title: item.name,
      quantity: item.quantity,
      unit_price: parseFloat(item.unit_price),
      currency_id: 'MXN',
    }));

    const preferenceData = {
      body: {
        items: preferenceItems,
        payer: { name: orderData.customerDetails.name, email: orderData.customerDetails.email },
        back_urls: { success: `${effectiveFrontendUrl}/payment-success?order_id=${createdOrderId.toString()}`, failure: `${effectiveFrontendUrl}/payment-failure?order_id=${createdOrderId.toString()}`, pending: `${effectiveFrontendUrl}/payment-pending?order_id=${createdOrderId.toString()}`, },
        notification_url: `${backendUrl}/api/mercadopago-webhook?source_news=webhooks&orderId=${createdOrderId.toString()}`,
        external_reference: createdOrderId.toString(),
      }
    };

    const mpPreference = await preference.create(preferenceData);
    await ordersCollection.updateOne({ _id: createdOrderId }, { $set: { 'paymentDetails.mercadoPagoPreferenceId': mpPreference.id } });
    res.status(201).json({ mercadoPagoUrl: mpPreference.init_point });

  } catch (error) {
    if (itemsForRollback.length > 0 && !error.message.toLowerCase().includes('stock')) {
      for (const { productId, quantity } of itemsForRollback) {
        await inventoryCollection.updateOne({ productId: productId }, { $inc: { stock: quantity } });
      }
    }
    res.status(500).json({ message: error.message });
  } finally {
    await session.endSession();
  }
});

app.post('/api/mercadopago-webhook', async (req, res) => {
  const { query, body } = req;
  const topic = query.topic || query.type;

  if (topic === 'payment' || body?.type === 'payment') {
    const paymentId = body?.data?.id;
    if (paymentId && db) {
      const session = clientMongo.startSession();
      try {
        await session.withTransaction(async (currentSession) => {
          const paymentInfoResult = await payment.get({ id: paymentId.toString() });
          const paymentStatusFromMP = paymentInfoResult?.status;
          const externalReference = paymentInfoResult?.external_reference;

          const ordersCollection = db.collection('orders');
          const inventoryCollection = db.collection('products');
          const usersCollection = db.collection('users');

          const orderObjectId = new ObjectId(externalReference);
          const order = await ordersCollection.findOne({ _id: orderObjectId }, { session: currentSession });

          if (order) {
            let newOrderStatusInDB;
            let paymentDetailsUpdate = {
              'paymentDetails.mercadoPagoPaymentId': paymentId.toString(),
              'paymentDetails.paymentStatus': paymentStatusFromMP,
              updatedAt: new Date()
            };

            if (paymentStatusFromMP === 'approved') {
              newOrderStatusInDB = 'paid';
              paymentDetailsUpdate['paymentDetails.paidAt'] = new Date();
              
              if (order.status !== 'paid' && order.userId) {
                const SPIN_THRESHOLD = 500;
                const user = await usersCollection.findOne({ _id: new ObjectId(order.userId) }, { session: currentSession });
                let currentProgress = user?.progressAmount || 0;
                let totalPool = currentProgress + order.totalAmount;
                
                const newSpins = Math.floor(totalPool / SPIN_THRESHOLD);
                const newProgress = totalPool % SPIN_THRESHOLD;

                if (newSpins > 0 || newProgress !== currentProgress) {
                    await usersCollection.updateOne(
                      { _id: new ObjectId(order.userId) },
                      { 
                          $inc: { spins: newSpins },
                          $set: { progressAmount: newProgress }
                      },
                      { session: currentSession }
                    );
                }
              }
            } else if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(paymentStatusFromMP)) {
              newOrderStatusInDB = 'failed';
              if (order.status === 'pending_payment') {
                for (const item of order.items) {
                  await inventoryCollection.updateOne(
                    { productId: item.productId },
                    { $inc: { stock: item.quantity } },
                    { session: currentSession }
                  );
                }
              }
            } else if (paymentStatusFromMP === 'in_process' || paymentStatusFromMP === 'pending') {
              newOrderStatusInDB = 'pending_payment';
            }

            if (newOrderStatusInDB) {
              paymentDetailsUpdate.status = newOrderStatusInDB;
              await ordersCollection.updateOne({ _id: orderObjectId }, { $set: paymentDetailsUpdate }, { session: currentSession });
            }
          }
        });
      } catch (err) {
        console.error(err);
      } finally {
        await session.endSession();
      }
    }
  }
  res.sendStatus(200);
});

app.listen(port, () => {
  console.log(`Server running port ${port}`);
});