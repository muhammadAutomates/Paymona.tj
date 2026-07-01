// Global crash prevention handlers to ensure 100% uptime in production
process.on('uncaughtException', (err) => {
    console.error('CRITICAL: Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const multer = require('multer');
const heicConvert = require('heic-convert');

// Configure multer for product media upload (images + video)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const dest = path.join(__dirname, 'assets', 'products');
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        cb(null, dest);
    },
    filename: function (req, file, cb) {
        const ext = path.extname(file.originalname);
        const uniqueName = 'uploaded_' + Date.now() + '_' + Math.round(Math.random() * 1E9) + ext;
        cb(null, uniqueName);
    }
});

// File filter: allow images and video
const mediaFilter = function (req, file, cb) {
    if (file.fieldname === 'photos') {
        // Accept images only
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed for photos'), false);
        }
    } else if (file.fieldname === 'video') {
        // Accept video files only
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'), false);
        }
    } else {
        cb(null, true);
    }
};

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max per file
    fileFilter: mediaFilter
});

// Multi-file upload handler: up to 4 photos + 1 video
const uploadMedia = upload.fields([
    { name: 'photos', maxCount: 4 },
    { name: 'video', maxCount: 1 }
]);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static assets in storefront and css/js
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

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
let cachedLightweightProducts = null; // in-memory cache for storefront product list


// Periodically clean up expired active sessions every 60 seconds to prevent memory leaks
setInterval(() => {
    const now = Date.now();
    const threshold = 45000; // 45 seconds grace period for 30s ping interval
    for (const [token, timestamp] of activeSessions.entries()) {
        if (now - timestamp > threshold) {
            activeSessions.delete(token);
        }
    }
}, 60000);

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

// Helper to strip heavy fields from products array (description, images, videoUrl)
function getLightweightProducts(products) {
    return products.map(p => {
        const obj = p.toObject ? p.toObject() : p;
        const { images, description, descriptionTj, videoUrl, ...rest } = obj;
        return rest;
    });
}

// Update products.js static file for backward compatibility (if needed)
function syncProductsJS(products) {
    try {
        const lightweight = getLightweightProducts(products);
        fs.writeFileSync(PRODUCTS_JS_PATH, `const products = ${JSON.stringify(lightweight, null, 2)};`);
    } catch (err) {
        console.error('Failed to sync products.js:', err);
    }
}

// Debounce local files sync to prevent OOM spikes when multiple mutations occur concurrently
let syncTimeout = null;
function syncLocalFilesFallback() {
    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }
    syncTimeout = setTimeout(async () => {
        try {
            let products = [];
            if (isMongo) {
                // Fetch the full product documents to preserve descriptions and gallery images in products.json
                products = await ProductModel.find({}).sort({ id: 1 }).lean();
            } else {
                products = readJSON(PRODUCTS_PATH);
            }
            // Save the lossless full products array to products.json backup
            writeJSON(PRODUCTS_PATH, products);
            
            // Sync lightweight products to products.js for backward-compatible frontend consumption
            const lightweight = getLightweightProducts(products);
            fs.writeFileSync(PRODUCTS_JS_PATH, `const products = ${JSON.stringify(lightweight, null, 2)};`);
            console.log('Successfully synced products to local fallback files (lossless).');
        } catch (err) {
            console.error('Failed to sync local fallback files:', err.message);
        }
    }, 5000);
}

// Helper to enforce a time-limit timeout on MongoDB promises to prevent hanging connections
function withTimeout(promise, ms = 5000) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Database query timed out')), ms);
    });
    return Promise.race([promise, timeout]);
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
    image: String,          // Main/cover photo
    images: [String],       // Additional gallery photos (up to 3 extra)
    badge: String,
    videoUrl: String,       // Uploaded or external video URL
    colors: [String],
    sizes: [String],
    description: String,
    descriptionTj: String
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
    address: String,
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
    timestamp: { type: Date, index: true },
    type: String
});

const ProductModel = mongoose.model('Product', ProductSchema);
const CategoryModel = mongoose.model('Category', CategorySchema);
const ReviewModel = mongoose.model('Review', ReviewSchema);
const OrderModel = mongoose.model('Order', OrderSchema);
const SettingsModel = mongoose.model('Settings', SettingsSchema);
const TrafficModel = mongoose.model('Traffic', TrafficSchema);

// Function to clean up old traffic records (older than 48 hours) to prevent database bloat
async function cleanOldTrafficData() {
    try {
        if (isMongo) {
            const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const res = await TrafficModel.deleteMany({ timestamp: { $lt: cutoff } });
            console.log(`Successfully cleaned up old traffic stats from MongoDB. Deleted: ${res.deletedCount}`);
            const totalRemaining = await TrafficModel.countDocuments();
            console.log(`Total remaining traffic records in MongoDB: ${totalRemaining}`);
        }
    } catch (err) {
        console.error('Failed to clean up old traffic stats:', err.message);
    }
}

// Periodically clean up old traffic data from MongoDB every 12 hours
setInterval(cleanOldTrafficData, 12 * 60 * 60 * 1000);

// Connection logic
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.set('bufferCommands', false);

if (MONGODB_URI) {
    console.log('Attempting to connect to MongoDB Cloud Database...');
    mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
        .then(async () => {
            console.log('=================================================');
            console.log('  SUCCESS: Connected to MongoDB Cloud Database!');
            console.log('=================================================');
            isMongo = true;

            // 1. Sync Categories from JSON if empty
            try {
                const count = await CategoryModel.countDocuments();
                if (count === 0) {
                    const defaultCats = readJSON(CATEGORIES_PATH);
                    if (defaultCats.length > 0) {
                        await CategoryModel.insertMany(defaultCats);
                        console.log('Categories successfully seeded to MongoDB Cloud.');
                    }
                } else {
                    console.log('Categories collection already populated. Skipping seed.');
                }
            } catch (e) { console.error('Failed to seed categories:', e); }

            // 2. Sync Products from JSON if empty
            try {
                const count = await ProductModel.countDocuments();
                if (count === 0) {
                    const defaultProds = readJSON(PRODUCTS_PATH);
                    if (defaultProds.length > 0) {
                        await ProductModel.insertMany(defaultProds);
                        console.log('Products successfully seeded to MongoDB Cloud.');
                    }
                } else {
                    console.log('Products collection already populated. Skipping seed.');
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

            // 4. Clean up old traffic stats
            try {
                await cleanOldTrafficData();
            } catch (e) { console.error('Failed to perform initial traffic cleanup:', e); }

            // 6. One-time deletion of seeded default products (ID <= 117)
            try {
                const deleteResult = await ProductModel.deleteMany({ id: { $lte: 117 } });
                if (deleteResult.deletedCount > 0) {
                    console.log(`Successfully deleted ${deleteResult.deletedCount} default seeded products from MongoDB.`);
                    // Invalidate cache
                    cachedLightweightProducts = null;
                    // Sync local fallback files
                    syncLocalFilesFallback();
                }
            } catch (e) {
                console.error('Failed to delete default products:', e);
            }

            // 5. Measure product data sizes in MongoDB using aggregation database-side (prevents server RAM OOM)
            try {
                const totalCount = await ProductModel.countDocuments();
                const oversizedProds = await ProductModel.aggregate([
                    {
                        $project: {
                            id: 1,
                            name: 1,
                            imageSize: { $strLenCP: { $ifNull: ["$image", ""] } },
                            imagesSize: {
                                $cond: {
                                    if: { $isArray: "$images" },
                                    then: {
                                        $reduce: {
                                            input: "$images",
                                            initialValue: 0,
                                            in: { $add: ["$$value", { $strLenCP: { $ifNull: ["$$this", ""] } }] }
                                        }
                                    },
                                    else: 0
                                }
                            }
                        }
                    },
                    {
                        $project: {
                            id: 1,
                            name: 1,
                            totalSizeKB: { $round: [ { $divide: [ { $add: ["$imageSize", "$imagesSize"] }, 1024 ] }, 0 ] }
                        }
                    },
                    {
                        $match: {
                            totalSizeKB: { $gt: 200 }
                        }
                    }
                ]);

                console.log('=================================================');
                console.log(`  Database Diagnostics:`);
                console.log(`  Total Products in MongoDB: ${totalCount}`);
                if (oversizedProds.length > 0) {
                    console.log(`  WARNING: Found ${oversizedProds.length} oversized products (over 200KB):`);
                    oversizedProds.forEach(op => {
                        console.log(`    - Product #${op.id} "${op.name}": ~${op.totalSizeKB} KB`);
                    });
                    console.log(`  Recommendation: Re-upload photos for these products in the Admin Panel to compress them.`);
                } else {
                    console.log(`  All products are under 200KB. Database size is optimal.`);
                }
                console.log('=================================================');
            } catch (e) { console.error('Failed to run product size diagnostics Aggregation:', e); }
            
            // Sync MongoDB products to local fallback JSON files at startup
            syncLocalFilesFallback();
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

// Helper to convert uploaded files to Base64 data URLs (and handle HEIC format conversion if needed)
async function convertFileToBase64(absolutePath, originalName, mimeType) {
    try {
        let buffer = fs.readFileSync(absolutePath);
        let finalMimeType = mimeType;
        const ext = path.extname(originalName).toLowerCase();
        
        // Auto convert HEIC/HEIF images to JPEG so browsers can display them
        if (ext === '.heic' || ext === '.heif' || mimeType.includes('heic') || mimeType.includes('heif')) {
            try {
                buffer = await heicConvert({
                    buffer: buffer,
                    format: 'JPEG',
                    quality: 0.75
                });
                finalMimeType = 'image/jpeg';
            } catch (convErr) {
                console.error('HEIC conversion failed:', convErr);
            }
        }
        
        const base64Data = `data:${finalMimeType};base64,${buffer.toString('base64')}`;
        
        // Delete temporary file from disk immediately
        try {
            fs.unlinkSync(absolutePath);
        } catch (unLinkErr) {
            console.error('Failed to delete temp file:', unLinkErr);
        }
        
        return base64Data;
    } catch (err) {
        console.error('Failed to process image buffer:', err);
        throw err;
    }
}

// Single file upload (legacy endpoint for backward compat)
app.post('/api/upload', upload.single('photo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        const absolutePath = path.join(__dirname, 'assets', 'products', req.file.filename);
        const base64Data = await convertFileToBase64(absolutePath, req.file.originalname, req.file.mimetype);
        res.json({ success: true, imagePath: base64Data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Multi-media upload: up to 4 photos + 1 video
app.post('/api/upload-media', (req, res) => {
    uploadMedia(req, res, async function(err) {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        
        const result = { success: true, photos: [], video: null };
        
        // Process uploaded photos
        if (req.files && req.files['photos']) {
            for (const f of req.files['photos']) {
                const absolutePath = path.join(__dirname, 'assets', 'products', f.filename);
                try {
                    const base64Data = await convertFileToBase64(absolutePath, f.originalname, f.mimetype);
                    result.photos.push(base64Data);
                } catch (processErr) {
                    // Fallback to local path if conversion fails
                    result.photos.push(`assets/products/${f.filename}`);
                }
            }
        }
        
        // Process uploaded video (remains on disk as before)
        if (req.files && req.files['video'] && req.files['video'].length > 0) {
            result.video = `assets/products/${req.files['video'][0].filename}`;
        }
        
        res.json(result);
    });
});

// Settings APIs
app.get('/api/settings', async (req, res) => {
    try {
        if (isMongo) {
            let settings = await SettingsModel.findOne({ key: 'main' }).lean();
            if (!settings) {
                const settingsDoc = await SettingsModel.create({ key: 'main', passcode: 'admin123', telegramChatId: '' });
                settings = settingsDoc.toObject();
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
            const settings = await SettingsModel.findOne({ key: 'main' }).lean();
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

// Helper to resolve client payloads containing dynamic image URLs back to database base64 values
function resolveProductPayloadImages(payload, existingProduct) {
    if (!existingProduct) return payload;
    
    // 1. Resolve main image
    if (payload.image && typeof payload.image === 'string' && payload.image.startsWith('/api/products/')) {
        const imageMatch = payload.image.match(/\/api\/products\/(\d+)\/image$/);
        const galleryMatch = payload.image.match(/\/api\/products\/(\d+)\/images\/(\d+)$/);
        
        if (imageMatch) {
            payload.image = existingProduct.image;
        } else if (galleryMatch) {
            const origIndex = parseInt(galleryMatch[2]);
            if (existingProduct.images && existingProduct.images[origIndex]) {
                payload.image = existingProduct.images[origIndex];
            }
        }
    }
    
    // 2. Resolve gallery images
    if (payload.images && Array.isArray(payload.images)) {
        payload.images = payload.images.map(img => {
            if (img && typeof img === 'string' && img.startsWith('/api/products/')) {
                const imageMatch = img.match(/\/api\/products\/(\d+)\/image$/);
                const galleryMatch = img.match(/\/api\/products\/(\d+)\/images\/(\d+)$/);
                
                if (imageMatch) {
                    return existingProduct.image;
                } else if (galleryMatch) {
                    const origIndex = parseInt(galleryMatch[2]);
                    if (existingProduct.images && existingProduct.images[origIndex]) {
                        return existingProduct.images[origIndex];
                    }
                }
            }
            return img;
        });
    }
    
    return payload;
}

// Serve cover image dynamically
app.get('/api/products/:id/image', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        let product;
        if (isMongo) {
            product = await ProductModel.findOne({ id }).lean();
        } else {
            const products = readJSON(PRODUCTS_PATH);
            product = products.find(p => p.id === id);
        }
        
        if (!product || !product.image) {
            return res.status(404).send('Image not found');
        }
        
        const imageStr = product.image;
        if (imageStr.startsWith('data:')) {
            const matches = imageStr.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
                const mimeType = matches[1];
                const buffer = Buffer.from(matches[2], 'base64');
                res.set('Content-Type', mimeType);
                res.set('Cache-Control', 'public, max-age=3600');
                return res.send(buffer);
            }
        }
        
        // If it's a URL or file path, redirect
        if (imageStr.startsWith('http://') || imageStr.startsWith('https://')) {
            return res.redirect(imageStr);
        }
        
        const redirectPath = imageStr.startsWith('/') ? imageStr : '/' + imageStr;
        return res.redirect(redirectPath);
    } catch (err) {
        console.error('Error serving product image:', err);
        res.status(500).send('Internal server error');
    }
});

// Serve gallery images dynamically
app.get('/api/products/:id/images/:index', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const index = parseInt(req.params.index);
        let product;
        if (isMongo) {
            product = await ProductModel.findOne({ id }).lean();
        } else {
            const products = readJSON(PRODUCTS_PATH);
            product = products.find(p => p.id === id);
        }
        
        if (!product || !product.images || !product.images[index]) {
            return res.status(404).send('Image not found');
        }
        
        const imageStr = product.images[index];
        if (imageStr.startsWith('data:')) {
            const matches = imageStr.match(/^data:([^;]+);base64,(.+)$/);
            if (matches) {
                const mimeType = matches[1];
                const buffer = Buffer.from(matches[2], 'base64');
                res.set('Content-Type', mimeType);
                res.set('Cache-Control', 'public, max-age=3600');
                return res.send(buffer);
            }
        }
        
        // If it's a URL or file path, redirect
        if (imageStr.startsWith('http://') || imageStr.startsWith('https://')) {
            return res.redirect(imageStr);
        }
        
        const redirectPath = imageStr.startsWith('/') ? imageStr : '/' + imageStr;
        return res.redirect(redirectPath);
    } catch (err) {
        console.error('Error serving product gallery image:', err);
        res.status(500).send('Internal server error');
    }
});

// Products CRUD APIs
app.get('/api/products', async (req, res) => {
    try {
        if (isMongo) {
            if (cachedLightweightProducts) {
                return res.json(cachedLightweightProducts);
            }
            try {
                // Exclude heavy fields and base64 cover image from query to prevent network/RAM spikes
                const products = await withTimeout(
                    ProductModel.find({}, { image: 0, images: 0, description: 0, descriptionTj: 0, videoUrl: 0 }).sort({ id: 1 }).lean(),
                    4000
                );
                const processedProducts = products.map(p => {
                    return { ...p, image: `/api/products/${p.id}/image` };
                });
                cachedLightweightProducts = processedProducts;
                return res.json(processedProducts);
            } catch (mongoErr) {
                console.error('MongoDB GET /api/products query failed/timed out, falling back to local files:', mongoErr.message);
                // Continue to local files fallback below
            }
        }
        
        // Local files fallback
        const allProducts = readJSON(PRODUCTS_PATH);
        const products = allProducts.map(p => {
            const { images, description, descriptionTj, videoUrl, ...rest } = p;
            if (rest.image && rest.image.startsWith('data:')) {
                rest.image = `/api/products/${p.id}/image`;
            }
            return rest;
        });
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isMongo) {
            try {
                const product = await withTimeout(ProductModel.findOne({ id }).lean(), 4000);
                if (!product) return res.status(404).json({ error: 'Product not found' });
                
                const processedProduct = { ...product };
                if (processedProduct.image && processedProduct.image.startsWith('data:')) {
                    processedProduct.image = `/api/products/${id}/image`;
                }
                if (processedProduct.images && Array.isArray(processedProduct.images)) {
                    processedProduct.images = processedProduct.images.map((img, i) => {
                        if (img && img.startsWith('data:')) {
                            return `/api/products/${id}/images/${i}`;
                        }
                        return img;
                    });
                }
                return res.json(processedProduct);
            } catch (mongoErr) {
                console.error(`MongoDB GET /api/products/${id} query failed/timed out, falling back to local files:`, mongoErr.message);
                // Continue to local files fallback below
            }
        }
        
        // Local files fallback
        const products = readJSON(PRODUCTS_PATH);
        const product = products.find(p => p.id === id);
        if (!product) return res.status(404).json({ error: 'Product not found' });
        
        const processedProduct = { ...product };
        if (processedProduct.image && processedProduct.image.startsWith('data:')) {
            processedProduct.image = `/api/products/${id}/image`;
        }
        if (processedProduct.images && Array.isArray(processedProduct.images)) {
            processedProduct.images = processedProduct.images.map((img, i) => {
                if (img && img.startsWith('data:')) {
                    return `/api/products/${id}/images/${i}`;
                }
                return img;
            });
        }
        res.json(processedProduct);
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
        if (!newProduct.descriptionTj) newProduct.descriptionTj = '';
        if (!newProduct.videoUrl) newProduct.videoUrl = '';
        if (!newProduct.badge) newProduct.badge = null;
        
        if (isMongo) {
            const lastProduct = await ProductModel.findOne().sort({ id: -1 }).lean();
            const nextId = lastProduct ? lastProduct.id + 1 : 1;
            newProduct.id = nextId;
            
            const created = await ProductModel.create(newProduct);
            
            // Invalidate cache
            cachedLightweightProducts = null;
            
            // Sync to local files in background (debounced)
            syncLocalFilesFallback();
            
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
            const existingProduct = await ProductModel.findOne({ id }).lean();
            if (!existingProduct) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            const resolvedBody = resolveProductPayloadImages(req.body, existingProduct);
            const updated = await ProductModel.findOneAndUpdate({ id }, { $set: resolvedBody }, { returnDocument: 'after' });
            if (!updated) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            // Invalidate cache
            cachedLightweightProducts = null;
            
            // Sync to local files in background (debounced)
            syncLocalFilesFallback();
            
            // Process images before sending
            const processedProduct = updated.toObject ? updated.toObject() : { ...updated };
            if (processedProduct.image && processedProduct.image.startsWith('data:')) {
                processedProduct.image = `/api/products/${id}/image`;
            }
            if (processedProduct.images && Array.isArray(processedProduct.images)) {
                processedProduct.images = processedProduct.images.map((img, i) => {
                    if (img && img.startsWith('data:')) {
                        return `/api/products/${id}/images/${i}`;
                    }
                    return img;
                });
            }
            res.json(processedProduct);
        } else {
            const products = readJSON(PRODUCTS_PATH);
            const index = products.findIndex(p => p.id === id);
            
            if (index === -1) {
                return res.status(404).json({ error: 'Product not found' });
            }
            
            const existingProduct = products[index];
            const resolvedBody = resolveProductPayloadImages(req.body, existingProduct);
            products[index] = { ...existingProduct, ...resolvedBody, id };
            writeJSON(PRODUCTS_PATH, products);
            syncProductsJS(products);
            
            const processedProduct = { ...products[index] };
            if (processedProduct.image && processedProduct.image.startsWith('data:')) {
                processedProduct.image = `/api/products/${id}/image`;
            }
            if (processedProduct.images && Array.isArray(processedProduct.images)) {
                processedProduct.images = processedProduct.images.map((img, i) => {
                    if (img && img.startsWith('data:')) {
                        return `/api/products/${id}/images/${i}`;
                    }
                    return img;
                });
            }
            res.json(processedProduct);
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/products-clear-catalog', async (req, res) => {
    try {
        const { passcode } = req.query;
        if (passcode !== 'admin123') {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        if (isMongo) {
            const result = await ProductModel.deleteMany({ id: { $gte: 125 } });
            cachedLightweightProducts = null;
            syncLocalFilesFallback();
            res.json({ success: true, message: `Deleted ${result.deletedCount} products from MongoDB` });
        } else {
            let products = readJSON(PRODUCTS_PATH);
            const countBefore = products.length;
            products = products.filter(p => p.id < 125);
            writeJSON(PRODUCTS_PATH, products);
            syncProductsJS(products);
            res.json({ success: true, message: `Deleted ${countBefore - products.length} products locally` });
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
            
            // Invalidate cache
            cachedLightweightProducts = null;
            
            // Sync to local files in background (debounced)
            syncLocalFilesFallback();
            
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
            const categories = await CategoryModel.find().sort({ name_ru: 1 }).lean();
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
            const exists = await CategoryModel.findOne({ id: newCategory.id }).lean();
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
            const productReviews = await ReviewModel.find({ productId }).sort({ date: -1 }).lean();
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
            try {
                const orders = await withTimeout(OrderModel.find().sort({ id: -1 }).lean(), 4000);
                return res.json(orders);
            } catch (mongoErr) {
                console.error('MongoDB GET /api/orders query failed/timed out, falling back to local files:', mongoErr.message);
                // Continue to local files fallback below
            }
        }
        
        // Local files fallback
        const orders = readJSON(ORDERS_PATH);
        res.json(orders.reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/orders/:id/status', async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const { status } = req.body;
        
        if (isMongo) {
            const updated = await OrderModel.findOneAndUpdate({ id }, { $set: { status } }, { returnDocument: 'after' });
            if (!updated) {
                return res.status(404).json({ error: 'Order not found' });
            }
            const allOrders = await OrderModel.find().sort({ id: -1 }).lean();
            writeJSON(ORDERS_PATH, allOrders);
            res.json(updated);
        } else {
            const orders = readJSON(ORDERS_PATH);
            const index = orders.findIndex(o => o.id === id);
            if (index === -1) {
                return res.status(404).json({ error: 'Order not found' });
            }
            orders[index].status = status;
            writeJSON(ORDERS_PATH, orders);
            res.json(orders[index]);
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
            const lastOrder = await OrderModel.findOne().sort({ id: -1 }).lean();
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
            const now = Date.now();
            const fortyEightHours = 48 * 60 * 60 * 1000;
            // Clean up old local traffic records
            const filtered = traffic.filter(log => (now - new Date(log.timestamp).getTime()) <= fortyEightHours);
            filtered.push({
                timestamp: new Date().toISOString(),
                type: 'order'
            });
            writeJSON(TRAFFIC_PATH, filtered);
            
            finalOrder = orderData;
        }
        
        // Dispatch Telegram Bot Notification
        let telegramChatId = '';
        if (isMongo) {
            const settings = await SettingsModel.findOne({ key: 'main' }).lean();
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
            
            const addressText = orderData.address ? `📍 *Адрес:* ${orderData.address}\n` : '';
            const messageText = `🛍️ *Новый заказ №${orderId}* в Paymona!\n\n` +
                                `👤 *Клиент:* +992 ${orderData.phone}\n` +
                                addressText +
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

// Clear Order History & Traffic Stats
app.delete('/api/orders', async (req, res) => {
    try {
        if (isMongo) {
            await OrderModel.deleteMany({});
            await TrafficModel.deleteMany({});
            writeJSON(ORDERS_PATH, []);
            writeJSON(TRAFFIC_PATH, []);
        } else {
            writeJSON(ORDERS_PATH, []);
            writeJSON(TRAFFIC_PATH, []);
        }
        console.log('Order history and traffic stats cleared successfully!');
        res.json({ success: true, message: 'История заказов и выручка успешно очищены!' });
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
    const threshold = 45000; // 45 seconds timeout
    
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
            try {
                await withTimeout(TrafficModel.create({ timestamp: new Date(), type: 'visit' }), 3000);
            } catch (err) {
                console.error('Failed to log ping to MongoDB, falling back to local files:', err.message);
                const traffic = readJSON(TRAFFIC_PATH);
                const now = Date.now();
                const fortyEightHours = 48 * 60 * 60 * 1000;
                const filtered = traffic.filter(log => (now - new Date(log.timestamp).getTime()) <= fortyEightHours);
                filtered.push({
                    timestamp: new Date().toISOString(),
                    type: 'visit'
                });
                writeJSON(TRAFFIC_PATH, filtered);
            }
        } else {
            const traffic = readJSON(TRAFFIC_PATH);
            const now = Date.now();
            const fortyEightHours = 48 * 60 * 60 * 1000;
            // Clean up old local traffic records
            const filtered = traffic.filter(log => (now - new Date(log.timestamp).getTime()) <= fortyEightHours);
            filtered.push({
                timestamp: new Date().toISOString(),
                type: 'visit'
            });
            writeJSON(TRAFFIC_PATH, filtered);
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
            try {
                traffic = await withTimeout(
                    TrafficModel.find({
                        timestamp: { $gte: new Date(now - 24 * oneHour) }
                    }, { timestamp: 1, type: 1, _id: 0 }).lean(),
                    4000
                );
            } catch (mongoErr) {
                console.error('MongoDB GET /api/traffic-stats query failed/timed out, falling back to local files:', mongoErr.message);
                traffic = readJSON(TRAFFIC_PATH);
            }
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

// Database diagnostics API
app.get('/api/debug-db', async (req, res) => {
    try {
        let prodsCount = 0;
        let categoriesCount = 0;
        let ordersCount = 0;
        let testProduct = null;
        let testError = null;
        
        if (isMongo && mongoose.connection.readyState === 1) {
            prodsCount = await ProductModel.countDocuments();
            categoriesCount = await CategoryModel.countDocuments();
            ordersCount = await OrderModel.countDocuments();
            try {
                testProduct = await ProductModel.findOne({}, { id: 1, name: 1 }).lean();
            } catch (err) {
                testError = err.message;
            }
        } else {
            prodsCount = readJSON(PRODUCTS_PATH).length;
            categoriesCount = readJSON(CATEGORIES_PATH).length;
            ordersCount = readJSON(ORDERS_PATH).length;
        }

        res.json({
            isMongo,
            readyState: mongoose.connection.readyState,
            hasUri: !!process.env.MONGODB_URI,
            products: prodsCount,
            categories: categoriesCount,
            orders: ordersCount,
            testProduct,
            testError
        });
    } catch (err) {
        res.json({
            error: err.message,
            isMongo,
            readyState: mongoose.connection.readyState
        });
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
