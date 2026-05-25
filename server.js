const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

// Populate mock traffic if empty
function initializeMockTraffic() {
    const traffic = readJSON(TRAFFIC_PATH);
    if (traffic.length === 0) {
        console.log('Generating realistic traffic logs for the last 24 hours...');
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        // Generate visits and orders for the past 24 hours
        for (let i = 24; i >= 0; i--) {
            const hourTime = now - (i * oneHour);
            // Hour-based distribution: peak in evening (18:00 - 22:00), low in night (02:00 - 06:00)
            const hourNum = new Date(hourTime).getHours();
            let visitsCount = 5 + Math.floor(Math.random() * 10); // base traffic
            
            if (hourNum >= 18 && hourNum <= 23) {
                visitsCount += 15 + Math.floor(Math.random() * 15);
            } else if (hourNum >= 8 && hourNum <= 17) {
                visitsCount += 10 + Math.floor(Math.random() * 10);
            } else if (hourNum >= 1 && hourNum <= 6) {
                visitsCount = Math.floor(Math.random() * 4);
            }
            
            for (let v = 0; v < visitsCount; v++) {
                // Spread minutes in that hour
                const minOffset = Math.floor(Math.random() * 60) * 60 * 1000;
                traffic.push({
                    timestamp: new Date(hourTime + minOffset).toISOString(),
                    type: 'visit'
                });
            }
            
            // Generate some orders (roughly 5-8% conversion)
            const ordersCount = Math.floor(visitsCount * (0.04 + Math.random() * 0.05));
            for (let o = 0; o < ordersCount; o++) {
                const minOffset = Math.floor(Math.random() * 60) * 60 * 1000;
                traffic.push({
                    timestamp: new Date(hourTime + minOffset).toISOString(),
                    type: 'order'
                });
            }
        }
        
        // Sort chronologically
        traffic.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        writeJSON(TRAFFIC_PATH, traffic);
    }
}
initializeMockTraffic();

// --- API ENDPOINTS ---

// Settings APIs
app.get('/api/settings', (req, res) => {
    const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
    res.json({ passcode: settings.passcode, telegramChatId: settings.telegramChatId });
});

app.post('/api/settings', (req, res) => {
    const { passcode, telegramChatId } = req.body;
    const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
    if (passcode) settings.passcode = passcode;
    if (telegramChatId !== undefined) settings.telegramChatId = telegramChatId;
    writeJSON(SETTINGS_PATH, settings);
    res.json({ success: true, message: 'Settings saved successfully' });
});

// Admin Authentication API
app.post('/api/admin/login', (req, res) => {
    const { passcode } = req.body;
    const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
    if (passcode === settings.passcode) {
        res.json({ success: true, token: 'paymona-admin-session-auth' });
    } else {
        res.status(401).json({ success: false, message: 'Неверный пароль / Нокобили вуруд' });
    }
});

// Products CRUD APIs
app.get('/api/products', (req, res) => {
    const products = readJSON(PRODUCTS_PATH);
    res.json(products);
});

app.post('/api/products', (req, res) => {
    const products = readJSON(PRODUCTS_PATH);
    const newProduct = req.body;
    
    // Auto increment ID
    const nextId = products.length > 0 ? Math.max(...products.map(p => p.id)) + 1 : 1;
    newProduct.id = nextId;
    
    // Add default values for variations and description if empty
    if (!newProduct.colors) newProduct.colors = [];
    if (!newProduct.sizes) newProduct.sizes = [];
    if (!newProduct.description) newProduct.description = '';
    if (!newProduct.videoUrl) newProduct.videoUrl = '';
    if (!newProduct.badge) newProduct.badge = null;
    
    products.push(newProduct);
    writeJSON(PRODUCTS_PATH, products);
    syncProductsJS(products);
    
    res.status(201).json(newProduct);
});

app.put('/api/products/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const products = readJSON(PRODUCTS_PATH);
    const index = products.findIndex(p => p.id === id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Product not found' });
    }
    
    // Merge updated values
    products[index] = { ...products[index], ...req.body, id }; // lock ID
    writeJSON(PRODUCTS_PATH, products);
    syncProductsJS(products);
    
    res.json(products[index]);
});

app.delete('/api/products/:id', (req, res) => {
    const id = parseInt(req.params.id);
    let products = readJSON(PRODUCTS_PATH);
    const exists = products.some(p => p.id === id);
    
    if (!exists) {
        return res.status(404).json({ error: 'Product not found' });
    }
    
    products = products.filter(p => p.id !== id);
    writeJSON(PRODUCTS_PATH, products);
    syncProductsJS(products);
    
    res.json({ success: true, message: 'Product deleted' });
});

// Categories APIs
app.get('/api/categories', (req, res) => {
    const categories = readJSON(CATEGORIES_PATH);
    res.json(categories);
});

app.post('/api/categories', (req, res) => {
    const categories = readJSON(CATEGORIES_PATH);
    const newCategory = req.body;
    
    // Validate uniqueness of ID
    if (categories.some(c => c.id === newCategory.id)) {
        return res.status(400).json({ error: 'Category ID already exists' });
    }
    
    categories.push(newCategory);
    writeJSON(CATEGORIES_PATH, categories);
    res.status(201).json(newCategory);
});

app.delete('/api/categories/:id', (req, res) => {
    const id = req.params.id;
    let categories = readJSON(CATEGORIES_PATH);
    const exists = categories.some(c => c.id === id);
    
    if (!exists) {
        return res.status(404).json({ error: 'Category not found' });
    }
    
    categories = categories.filter(c => c.id !== id);
    writeJSON(CATEGORIES_PATH, categories);
    res.json({ success: true, message: 'Category deleted' });
});

// Reviews APIs
app.get('/api/reviews/:productId', (req, res) => {
    const productId = parseInt(req.params.productId);
    const reviews = readJSON(REVIEWS_PATH);
    const productReviews = reviews.filter(r => r.productId === productId);
    res.json(productReviews);
});

app.post('/api/reviews', (req, res) => {
    const reviews = readJSON(REVIEWS_PATH);
    const newReview = req.body;
    
    newReview.id = Date.now();
    newReview.date = new Date().toISOString();
    newReview.productId = parseInt(newReview.productId);
    newReview.rating = parseInt(newReview.rating);
    
    reviews.push(newReview);
    writeJSON(REVIEWS_PATH, reviews);
    res.status(201).json(newReview);
});

// Orders & Telegram Bot APIs
app.get('/api/orders', (req, res) => {
    const orders = readJSON(ORDERS_PATH);
    res.json(orders);
});

app.post('/api/orders', async (req, res) => {
    const orders = readJSON(ORDERS_PATH);
    const orderData = req.body;
    
    orderData.id = orders.length > 0 ? Math.max(...orders.map(o => o.id)) + 1 : 1001;
    orderData.date = new Date().toISOString();
    orderData.status = 'New';
    
    orders.push(orderData);
    writeJSON(ORDERS_PATH, orders);
    
    // Log this order to traffic analytics
    const traffic = readJSON(TRAFFIC_PATH);
    traffic.push({
        timestamp: new Date().toISOString(),
        type: 'order'
    });
    writeJSON(TRAFFIC_PATH, traffic);
    
    // Dispatch Telegram Bot Notification
    const settings = readJSON(SETTINGS_PATH, { passcode: 'admin123', telegramChatId: '' });
    const botToken = '8684204571:AAFCzHuh7oZX5QZp6ykKwLjvsU0j0MIxLZM';
    
    if (settings.telegramChatId) {
        // Format items message
        let itemsText = '';
        orderData.items.forEach(item => {
            const colorInfo = item.color ? ` | Цвет: ${item.color}` : '';
            const sizeInfo = item.size ? ` | Размер: ${item.size}` : '';
            itemsText += `• ${item.name} x${item.quantity}${colorInfo}${sizeInfo} — ${item.price * item.quantity} c.\n`;
        });
        
        const messageText = `🛍️ *Новый заказ №${orderData.id}* в Paymona!\n\n` +
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
                    chat_id: settings.telegramChatId,
                    text: messageText,
                    parse_mode: 'Markdown'
                })
            });
            console.log(`Telegram notification sent successfully to Chat ID: ${settings.telegramChatId}`);
        } catch (err) {
            console.error('Failed to send Telegram message:', err.message);
        }
    } else {
        console.warn('Telegram Chat ID not set in Admin Settings. Skipping notification.');
    }
    
    res.status(201).json({ success: true, orderId: orderData.id });
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
    const threshold = 15000; // 15 seconds
    
    // Purge expired sessions
    for (const [token, timestamp] of activeSessions.entries()) {
        if (now - timestamp > threshold) {
            activeSessions.delete(token);
        }
    }
    
    res.json({ count: Math.max(1, activeSessions.size) }); // always show at least 1 (the admin or guest)
});

// Log visitor visits
app.post('/api/log-visit', (req, res) => {
    const traffic = readJSON(TRAFFIC_PATH);
    traffic.push({
        timestamp: new Date().toISOString(),
        type: 'visit'
    });
    writeJSON(TRAFFIC_PATH, traffic);
    res.json({ success: true });
});

// Traffic statistics API
app.get('/api/traffic-stats', (req, res) => {
    const traffic = readJSON(TRAFFIC_PATH);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    
    // Initialize hourly bins for the last 24 hours
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
    
    // Bucket traffic logs into their respective hourly bins
    traffic.forEach(log => {
        const logDate = new Date(log.timestamp);
        const logTime = logDate.getTime();
        
        // Only count logs within the last 24 hours
        if (now - logTime <= 24 * oneHour) {
            // Find closest hourly bin
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
