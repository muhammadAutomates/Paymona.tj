const fs = require('fs');
const path = require('path');
const heicConvert = require('heic-convert');

const sourceDir = 'F:\\Paymona';
const destDir = path.join(__dirname, 'assets', 'products');

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

async function processImages() {
    console.log('Starting image processing...');
    const files = fs.readdirSync(sourceDir).filter(f => f.toLowerCase().endsWith('.heic'));
    
    let productsList = [];
    const categories = ['appliances', 'dishes', 'home'];
    
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const srcPath = path.join(sourceDir, file);
        const destFileName = `product_${i + 1}.jpg`;
        const destPath = path.join(destDir, destFileName);
        
        try {
            console.log(`Processing ${i + 1}/${files.length}: ${file}`);
            const inputBuffer = fs.readFileSync(srcPath);
            const outputBuffer = await heicConvert({
                buffer: inputBuffer,
                format: 'JPEG',
                quality: 0.6 // Medium quality for fast processing and smaller file size
            });
            fs.writeFileSync(destPath, outputBuffer);
            
            // Assign random category and basic info
            const cat = categories[i % categories.length];
            let price = 50 + Math.floor(Math.random() * 200);
            
            productsList.push({
                id: i + 1,
                name: `Товар ${i + 1}`,
                category: cat,
                price: price,
                image: `assets/products/${destFileName}`,
                badge: i % 10 === 0 ? 'Хит' : (i % 7 === 0 ? 'Новинка' : null)
            });
        } catch (err) {
            console.error(`Error processing ${file}:`, err.message);
        }
    }
    
    // Write product JSON
    const dataPath = path.join(__dirname, 'products.json');
    fs.writeFileSync(dataPath, JSON.stringify(productsList, null, 2));
    console.log('Processing complete! Wrote', productsList.length, 'products to products.json');
}

processImages();
