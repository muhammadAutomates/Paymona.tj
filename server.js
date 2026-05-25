const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets in storefront and css/js
app.use(express.static(__dirname));

// Data paths
const PRODUCTS_PATH = path.join(__dirname, 'products.json');
const PRODUCTS_JS_PATH = path.join(__dirname, 'js', 'products.js');
const CATEGORIES_PATH = path.join(__dirname, 'data', 'categories.json');
const REVIEWS_PATH = path.join(__dirname, 'data', 'reviews.json');
const ORDERS_PATH = path.join(__dirname, 'data', 'orders.json');
const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');
const TRAFFIC_PATH = path.join(__dirname, 'data', 'traffic.json');

// Memory storage for online clients tracking
const activeSessions = new Map(); // sessionToken -> timestamp

// Helper to read JSON files safely
function readJSON(filePath, defaultValue = []) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content || JSON.stringify(defaultValue));
    } catch (err) {
        console.error(`Error reading ${filePath}:`, err);
        return defaultValue;
    }
}

// Helper to write JSON files safely
function writeJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(`Error writing ${filePath}:`, err);
    }
}

// Update products.js static file for backward compatibility (if needed)
function syncProductsJS(products) {
    try {
        fs.writeFileSync(PRODUCTS_JS_PATH, `const products = ${JSON.stringify(products, null, 2)};`);
    } catch (err) {
        console.error('Failed to sync products.js:', err);
    }
}

// --- DATABASE HYBRID STORAGE SETUP (MongoDB Atlas + Local JSON Fallback) ---
let isMongo = false;

// Define Schemas
const ProductSchema = new mongoose.Schema({
    id: { type: Number, unique: true },
    name: String,
    category: String,
    price: Number,
    oldPrice: Number,
    image: String,
    badge: String,
    videoUrl: String,
    colors: [String],
    sizes: [String],
    description: String
});

const CategorySchema = new mongoose.Schema({
    id: { type: String, unique: true },
    name_ru: String,
    name_tj: String,
    name_en: String,
    icon: String
});

const ReviewSchema = new mongoose.Schema({
    id: Number,
    productId: Number,
    name: String,
    rating: Number,
    comment: String,
    date: Date
});

const OrderSchema = new mongoose.Schema({
    id: { type: Number, unique: true },
    phone: String,
    date: Date,
    status: String,
    totalPrice: Number,
    items: [mongoose.Schema.Types.Mixed]
});

const SettingsSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    passcode: { type: String, default: 'admin123' },
    telegramChatId: { type: String, default: '' }
});

const TrafficSchema = new mongoose.Schema({
    timestamp: Date,
    type: String
});

const ProductModel = mongoose.model('Product', ProductSchema);
const CategoryModel = mongoose.model('Category', CategorySchema);
const ReviewModel = mongoose.model('Review', ReviewSchema);
const OrderModel = mongoose.model('Order', OrderSchema);
const SettingsModel = mongoose.model('Settings', SettingsSchema);
const TrafficModel = mongoose.model('Traffic', TrafficSchema);

// Connection logic
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
    console.log('Attempting to connect to MongoDB Cloud Database...');
    mongoose.connect(MONGODB_URI)
        .then(async () => {
            console.log('=================================================');
            console.log('  SUCCESS: Connected to MongoDB Cloud Database!');
            console.log('=================================================');
            isMongo = true;

            // 1. Auto-seed Categories from JSON if collection is empty
            try {
                const count = await CategoryModel.countDocuments();
                if (count === 0) {
                    const defaultCats = readJSON(CATEGORIES_PATH);
                    if (defaultCats.length > 0) {
                        await CategoryModel.insertMany(defaultCats);
                        console.log(`Seeded ${defaultCats.length} default categories to MongoDB.`);
                    }
                }
            } catch (e) { console.error('Failed to seed categories:', e); }

            // 2. Auto-seed Products from JSON if collection is empty
            try {
                const count = await ProductModel.countDocuments();
                if (count === 0) {
                    const defaultProds = readJSON(PRODUCTS_PATH);
                    if (defaultProds.length > 0) {
                        await ProductModel.insertMany(defaultProds);
                        console.log(`Seeded ${defaultProds.length} default products to MongoDB.`);
                    }
                }
            } catch (e) { console.error('Failed to seed products:', e); }

            // 3. Auto-seed Settings from JSON if empty
            try {
                const count = await SettingsModel.countDocuments();
                if (count === 0) {
                    const defaultSettings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
                    await SettingsModel.create({ key: 'main', ...defaultSettings });
                    console.log('Seeded default settings configuration to MongoDB.');
                }
            } catch (e) { console.error('Failed to seed settings:', e); }
        })
        .catch(err => {
            console.error('=================================================');
            console.error('  ERROR: MongoDB connection failed.');
            console.error('  Falling back to Local JSON Files Storage.');
            console.error('=================================================');
            isMongo = false;
        });
} else {
    console.log('No MONGODB_URI provided in environment variables.');
    console.log('Running server with Local JSON Files Database fallback.');
}

// Populate mock traffic in local files if empty
function initializeMockTraffic() {
    const traffic = readJSON(TRAFFIC_PATH);
    if (traffic.length === 0) {
        console.log('Generating realistic traffic logs for the last 24 hours...');
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        for (let i = 24; i >= 0; i--) {
            const hourTime = now - (i * oneHour);
            const hourNum = new Date(hourTime).getHours();
            let visitsCount = 5 + Math.floor(Math.random() * 10);
            
            if (hourNum >= 18 && hourNum <= 23) {
                visitsCount += 15 + Math.floor(Math.random() * 15);
            } else if (hourNum >= 8 && hourNum <= 17) {
                visitsCount += 10 + Math.floor(Math.random() * 10);
            } else if (hourNum >= 1 && hourNum <= 6) {
                visitsCount = Math.floor(Math.random() * 4);
            }
            
            for (let v = 0; v < visitsCount; v++) {
                const minOffset = Math.floor(Math.random() * 60) * 60 * 1000;
                traffic.push({
                    timestamp: new Date(hourTime + minOffset).toISOString(),
                    type: 'visit'
                });
            }
            
            const ordersCount = Math.floor(visitsCount * (0.04 + Math.random() * 0.05));
            for (let o = 0; o < ordersCount; o++) {
                const minOffset = Math.floor(Math.random() * 60) * 60 * 1000;
                traffic.push({
                    timestamp: new Date(hourTime + minOffset).toISOString(),
                    type: 'order'
                });
            }
        }
        
        traffic.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        writeJSON(TRAFFIC_PATH, traffic);
    }
}
initializeMockTraffic();

// --- API ENDPOINTS ---

// Settings APIs
app.get('/api/settings', async (req, res) => {
    try {
        if (isMongo) {
            let settings = await SettingsModel.findOne({ key: 'main' });
            if (!settings) {
                settings = await SettingsModel.create({ key: 'main', passcode: 'admin123', telegramChatId: '' });
            }
            res.json({ passcode: settings.passcode, telegramChatId: settings.telegramChatId });
        } else {
            const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
            res.json({ passcode: settings.passcode, telegramChatId: settings.telegramChatId });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const { passcode, telegramChatId } = req.body;
        if (isMongo) {
            const update = {};
            if (passcode) update.passcode = passcode;
            if (telegramChatId !== undefined) update.telegramChatId = telegramChatId;
            
            await SettingsModel.updateOne({ key: 'main' }, { $set: update }, { upsert: true });
            res.json({ success: true, message: 'Settings saved to MongoDB' });
        } else {
            const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
            if (passcode) settings.passcode = passcode;
            if (telegramChatId !== undefined) settings.telegramChatId = telegramChatId;
            writeJSON(SETTINGS_PATH, settings);
            res.json({ success: true, message: 'Settings saved locally' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin Authentication API
app.post('/api/admin/login', async (req, res) => {
    try {
        const { passcode } = req.body;
        let adminPasscode = 'admin123';
        
        if (isMongo) {
            const settings = await SettingsModel.findOne({ key: 'main' });
            if (settings) adminPasscode = settings.passcode;
        } else {
            const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
            adminPasscode = settings.passcode;
        }
        
        if (passcode === adminPasscode) {
            res.json({ success: true, token: 'paymona-admin-session-auth' });
        } else {
            res.status(401).json({ success: false, message: 'Неверный пароль / Нокобили вуруд' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Products CRUD APIs
app.get('/api/products', async (req, res) => {
    try {
        if (isMongo) {
            const products = await ProductModel.find().sort({ id: 1 });
            res.json(products);
        } else {
            const products = readJSON(PRODUCTS_PATH);
            res.json(products);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/products', async (req, res) => {
    try {
        const newProduct = req.body;
        
        // Add defaults
        if (!newProduct.colors) newProduct.colors = [];
        if (!newProduct.sizes) newProduct.sizes = [];
        if (!newProduct.description) newProduct.description = '';
        if (!newProduct.videoUrl) newProduct.videoUrl = '';
        if (!newProduct.badge) newProduct.badge = null;
        
        if (isMongo) {
            const lastProduct = await ProductModel.findOne().sort({ id: -1 });
            const nextId = lastProduct ? lastProduct.id + 1 : 1;
            newProduct.id = nextId;
            
            const created = await ProductModel.create(newProduct);
            
            // Sync to local files in background
            const allProds = await ProductModel.find().sort({ id: 1 });
            writeJSON(PRODUCTS_PATH, allProds);
            syncProductsJS(allProds);
            
            res.status(201).json(created);
        } else {
            const products = readJSON(PRODUCTS_PATH);
            const nextId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
            newProduct.id = nextId;
            
            products.push(newProduct);
            writeJSON(PRODUCTS_PATH, products);
            syncProductsJS(products);
            
            res.status(201).json(newProduct);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/products/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        
        if (isMongo) {
            const updated = await ProductModel.findOneAndUpdate({ id }, { $set: req.body }, { new: true });
            if (!updated) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            // Sync to local files in background
            const allProds = await ProductModel.find().sort({ id: 1 });
            writeJSON(PRODUCTS_PATH, allProds);
            syncProductsJS(allProds);
            
            res.json(updated);
        } else {
            const products = readJSON(PRODUCTS_PATH);
            const index = products.findIndex(p => p.id === id);
            
            if (index === -1) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            products[index] = { ...products[index], ...req.body, id };
            writeJSON(PRODUCTS_PATH, products);
            syncProductsJS(products);
            
            res.json(products[index]);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        
        if (isMongo) {
            const deleted = await ProductModel.findOneAndDelete({ id });
            if (!deleted) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            const allProds = await ProductModel.find().sort({ id: 1 });
            writeJSON(PRODUCTS_PATH, allProds);
            syncProductsJS(allProds);
            
            res.json({ success: true, message: 'Product deleted from MongoDB' });
        } else {
            let products = readJSON(PRODUCTS_PATH);
            const exists = products.some(p => p.id === id);
            
            if (!exists) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            products = products.filter(p => p.id !== id);
            writeJSON(PRODUCTS_PATH, products);
            syncProductsJS(products);
            
            res.json({ success: true, message: 'Product deleted locally' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Categories APIs
app.get('/api/categories', async (req, res) => {
    try {
        if (isMongo) {
            const categories = await CategoryModel.find().sort({ name_ru: 1 });
            res.json(categories);
        } else {
            const categories = readJSON(CATEGORIES_PATH);
            res.json(categories);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/categories', async (req, res) => {
    try {
        const newCategory = req.body;
        
        if (isMongo) {
            const exists = await CategoryModel.findOne({ id: newCategory.id });
            if (exists) {
                return res.status(400).json({ error: 'Category ID already exists' });
            }
            const created = await CategoryModel.create(newCategory);
            res.status(201).json(created);
        } else {
            const categories = readJSON(CATEGORIES_PATH);
            if (categories.some(c => c.id === newCategory.id)) {
                return res.status(400).json({ error: 'Category ID already exists' });
            }
            categories.push(newCategory);
            writeJSON(CATEGORIES_PATH, categories);
            res.status(201).json(newCategory);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/categories/:id', async (req, res) => {
    try {
        const id = req.params.id;
        
        if (isMongo) {
            const deleted = await CategoryModel.findOneAndDelete({ id });
            if (!deleted) {
                return res.status(404).json({ error: 'Category not found' });
            }
            res.json({ success: true, message: 'Category deleted from MongoDB' });
        } else {
            let categories = readJSON(CATEGORIES_PATH);
            const exists = categories.some(c => c.id === id);
            
            if (!exists) {
                return res.status(404).json({ error: 'Category not found' });
            }
            
            categories = categories.filter(c => c.id !== id);
            writeJSON(CATEGORIES_PATH, categories);
            res.json({ success: true, message: 'Category deleted locally' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reviews APIs
app.get('/api/reviews/:productId', async (req, res) => {
    try {
        const productId = parseInt(req.params.productId);
        
        if (isMongo) {
            const productReviews = await ReviewModel.find({ productId }).sort({ date: -1 });
            res.json(productReviews);
        } else {
            const reviews = readJSON(REVIEWS_PATH);
            const productReviews = reviews.filter(r => r.productId === productId);
            res.json(productReviews.reverse());
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reviews', async (req, res) => {
    try {
        const newReview = req.body;
        newReview.id = Date.now();
        newReview.date = new Date();
        newReview.productId = parseInt(newReview.productId);
        newReview.rating = parseInt(newReview.rating);
        
        if (isMongo) {
            const created = await ReviewModel.create(newReview);
            res.status(201).json(created);
        } else {
            const reviews = readJSON(REVIEWS_PATH);
            reviews.push(newReview);
            writeJSON(REVIEWS_PATH, reviews);
            res.status(201).json(newReview);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Orders & Telegram Bot APIs
app.get('/api/orders', async (req, res) => {
    try {
        if (isMongo) {
            const orders = await OrderModel.find().sort({ id: -1 });
            res.json(orders);
        } else {
            const orders = readJSON(ORDERS_PATH);
            res.json(orders.reverse());
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/orders', async (req, res) => {
    try {
        const orderData = req.body;
        let orderId = 1001;
        let finalOrder = null;
        
        if (isMongo) {
            const lastOrder = await OrderModel.findOne().sort({ id: -1 });
            orderId = lastOrder ? lastOrder.id + 1 : 1001;
            
            orderData.id = orderId;
            orderData.date = new Date();
            orderData.status = 'New';
            
            finalOrder = await OrderModel.create(orderData);
            
            // Log visit stats
            await TrafficModel.create({ timestamp: new Date(), type: 'order' });
        } else {
            const orders = readJSON(ORDERS_PATH);
            orderId = orders.length > 0 ? Math.max(...orders.map(o => o.id)) + 1 : 1001;
            
            orderData.id = orderId;
            orderData.date = new Date().toISOString();
            orderData.status = 'New';
            
            orders.push(orderData);
            writeJSON(ORDERS_PATH, orders);
            
            const traffic = readJSON(TRAFFIC_PATH);
            traffic.push({
                timestamp: new Date().toISOString(),
                type: 'order'
            });
            writeJSON(TRAFFIC_PATH, traffic);
            
            finalOrder = orderData;
        }
        
        // Dispatch Telegram Bot Notification
        let telegramChatId = '';
        if (isMongo) {
            const settings = await SettingsModel.findOne({ key: 'main' });
            if (settings) telegramChatId = settings.telegramChatId;
        } else {
            const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
            telegramChatId = settings.telegramChatId;
        }
        
        const botToken = '8684204571:AAFCzHuh7oZX5QZp6ykKwLjvsU0j0MIxLZM';
        
        if (telegramChatId) {
            let itemsText = '';
            orderData.items.forEach(item => {
                const colorInfo = item.color ? ` | Цвет: ${item.color}` : '';
                const sizeInfo = item.size ? ` | Размер: ${item.size}` : '';
                itemsText += `• ${item.name} x${item.quantity}${colorInfo}${sizeInfo} — ${item.price * item.quantity} c.\n`;
            });
            
            const messageText = `🛍️ *Новый заказ №${orderId}* в Paymona!\n\n` +
                                `👤 *Клиент:* +992 ${orderData.phone}\n` +
                                `📦 *Товары:*\n${itemsText}\n` +
                                `💵 *Итого к оплате:* *${orderData.totalPrice} c.*\n` +
                                `📅 *Время:* ${new Date(orderData.date).toLocaleString('ru-RU')}`;
                                
            const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
            
            try {
                await fetch(telegramUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramChatId,
                        text: messageText,
                        parse_mode: 'Markdown'
                    })
                });
                console.log(`Telegram notification sent successfully to Chat ID: ${telegramChatId}`);
            } catch (err) {
                console.error('Failed to send Telegram message:', err.message);
            }
        }
        
        res.status(201).json({ success: true, orderId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Live Visitors Tracking (Pings)
app.post('/api/ping', (req, res) => {
    const { token } = req.body;
    if (token) {
        activeSessions.set(token, Date.now());
    }
    res.json({ success: true });
});

// Fetch active users in last 15 seconds
app.get('/api/online-count', (req, res) => {
    const now = Date.now();
    const threshold = 15000;
    
    for (const [token, timestamp] of activeSessions.entries()) {
        if (now - timestamp > threshold) {
            activeSessions.delete(token);
        }
    }
    
    res.json({ count: Math.max(1, activeSessions.size) });
});

// Log visitor visits
app.post('/api/log-visit', async (req, res) => {
    try {
        if (isMongo) {
            await TrafficModel.create({ timestamp: new Date(), type: 'visit' });
        } else {
            const traffic = readJSON(TRAFFIC_PATH);
            traffic.push({
                timestamp: new Date().toISOString(),
                type: 'visit'
            });
            writeJSON(TRAFFIC_PATH, traffic);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Traffic statistics API
app.get('/api/traffic-stats', async (req, res) => {
    try {
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        const stats = [];
        for (let i = 23; i >= 0; i--) {
            const timePoint = new Date(now - (i * oneHour));
            stats.push({
                timeLabel: timePoint.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
                timeISO: timePoint.toISOString(),
                visits: 0,
                orders: 0
            });
        }
        
        let traffic = [];
        if (isMongo) {
            traffic = await TrafficModel.find({
                timestamp: { $gte: new Date(now - 24 * oneHour) }
            });
        } else {
            traffic = readJSON(TRAFFIC_PATH);
        }
        
        traffic.forEach(log => {
            const logDate = new Date(log.timestamp);
            const logTime = logDate.getTime();
            
            if (now - logTime <= 24 * oneHour) {
                let closestBin = null;
                let minDiff = Infinity;
                
                stats.forEach(bin => {
                    const binTime = new Date(bin.timeISO).getTime();
                    const diff = Math.abs(logTime - binTime);
                    if (diff < minDiff && diff < oneHour) {
                        minDiff = diff;
                        closestBin = bin;
                    }
                });
                
                if (closestBin) {
                    if (log.type === 'visit') closestBin.visits++;
                    if (log.type === 'order') closestBin.orders++;
                }
            }
        });
        
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fallback to serve index.html for UI client routing if needed
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Server
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`  PAYMONA ("Паймона") E-Commerce Server Running`);
    console.log(`  Local Address: http://localhost:${PORT}`);
    console.log(`  Admin Dashboard: http://localhost:${PORT}/admin.html`);
    console.log(`=================================================`);
});
