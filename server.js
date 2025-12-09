// server.js - AWS S3 ready (Node 18+)
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

// AWS SDK v3
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const PORT = process.env.PORT || 8080;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// S3 config
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
let s3Client = null;
if (S3_BUCKET && S3_REGION) {
  // If running on EB with an instance role, no credentials required here.
  s3Client = new S3Client({ region: S3_REGION });
  console.log('S3 enabled. Bucket:', S3_BUCKET, 'Region:', S3_REGION);
} else {
  console.log('S3 not configured. Using local disk uploads.');
}

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Directories
const projectRoot = __dirname;
const publicDir = path.join(projectRoot, 'public');
const uploadsDir = path.join(publicDir, 'uploads');
const dataDir = path.join(projectRoot, 'data');
const productsFile = path.join(dataDir, 'products.json');

[publicDir, uploadsDir, dataDir].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
});
if (!fs.existsSync(productsFile)) fs.writeFileSync(productsFile, JSON.stringify([]));

app.use(express.static(publicDir));

// Multer
const uploadDisk = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random()*1e9);
    const ext = path.extname(file.originalname) || '';
    cb(null, `${unique}${ext}`);
  }
})});
const uploadMemory = multer({ storage: multer.memoryStorage() });

// Helpers
function readProducts() {
  try { return JSON.parse(fs.readFileSync(productsFile)); } catch (e) { return []; }
}
function writeProducts(arr) {
  fs.writeFileSync(productsFile, JSON.stringify(arr, null, 2));
}
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Upload buffer to S3 (returns public URL)
async function uploadBufferToS3(buffer, filename, mimeType='application/octet-stream') {
  if (!s3Client || !S3_BUCKET || !S3_REGION) throw new Error('S3 not configured');

  const key = `uploads/${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(filename) || ''}`;

  const parallelUpload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ACL: 'public-read' // ensure object is public
    }
  });

  await parallelUpload.done();

  // Public URL format for standard S3
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

// Routes
app.get('/', (req, res) => {
  const file = path.join(publicDir, 'index.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('index.html not found');
});
app.get('/admin.html', (req, res) => {
  const file = path.join(publicDir, 'admin.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('admin.html not found');
});

app.get('/api/config', (req,res) => {
  res.json({ whatsapp: WHATSAPP_NUMBER || '', siteUrl: SITE_URL });
});
app.get('/api/products', (req, res) => {
  const products = readProducts();
  res.json(products);
});

// Add product - S3 mode uses memory upload, otherwise disk
if (s3Client) {
  app.post('/api/products', uploadMemory.array('images', 20), async (req,res) => {
    try {
      const { name, sku, description, price, category } = req.body;
      if (!name || !sku) return res.status(400).json({ error: 'name and sku required' });

      const products = readProducts();
      const id = Date.now().toString();
      const images = [];

      if (Array.isArray(req.files) && req.files.length) {
        for (const f of req.files) {
          const url = await uploadBufferToS3(f.buffer, f.originalname, f.mimetype);
          images.push(url);
        }
      }

      const product = { id, name, sku, description: description||'', price: price||'', category: category||'Uncategorized', images, url: `${SITE_URL}/product/${id}` };
      products.push(product);
      writeProducts(products);
      res.json({ ok:true, product });
    } catch (err) {
      console.error('upload->s3 error', err);
      res.status(500).json({ error: 'upload failed', details: err.message });
    }
  });
} else {
  // Local disk fallback
  app.post('/api/products', uploadDisk.array('images', 20), (req,res) => {
    try {
      const { name, sku, description, price, category } = req.body;
      if (!name || !sku) return res.status(400).json({ error: 'name and sku required' });

      const products = readProducts();
      const id = Date.now().toString();
      const images = [];
      if (Array.isArray(req.files) && req.files.length) req.files.forEach(f => images.push(`/uploads/${f.filename}`));

      const product = { id, name, sku, description: description||'', price: price||'', category: category||'Uncategorized', images, url: `${SITE_URL}/product/${id}` };
      products.push(product);
      writeProducts(products);
      res.json({ ok:true, product });
    } catch (err) {
      console.error('upload->disk error', err);
      res.status(500).json({ error: 'upload failed', details: err.message });
    }
  });
}

// Product page with slider (same as your current)
app.get('/product/:id', (req,res) => {
  const id = req.params.id;
  const products = readProducts();
  const p = products.find(x => x.id === id || x.sku === id);
  if (!p) return res.status(404).send('Product Not Found');
  const images = Array.isArray(p.images) ? p.images : [];
  const mainImage = images.length ? images[0] : `${SITE_URL}/uploads/placeholder.png`;
  const title = `${escapeHtml(p.name)} — SKU ${escapeHtml(p.sku)} | Devi Fashions`;
  const desc = escapeHtml(p.description || '');
  const canonical = `${SITE_URL}/product/${encodeURIComponent(id)}`;

  const slidesHtml = images.map(src => `<div class="slide"><img src="${src}" alt="${escapeHtml(p.name)}"></div>`).join('');
  const dotsHtml = images.map((_, i) => `<span class="dot" data-index="${i}"></span>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="canonical" href="${canonical}"/><meta property="og:image" content="${mainImage}"/><link rel="stylesheet" href="/styles.css"/></head><body><main style="padding:20px;max-width:900px;margin:auto;"><h1>${escapeHtml(p.name)}</h1><div class="slider-container"><div class="slider-track">${slidesHtml}</div><div class="slider-dots">${dotsHtml}</div></div><p><strong>Description:</strong><br/>${escapeHtml(p.description)}</p><p><strong>SKU:</strong> ${escapeHtml(p.sku)}</p><p><strong>Price:</strong> ${escapeHtml(p.price || 'Contact for price')}</p><p><strong>Category:</strong> ${escapeHtml(p.category || 'Uncategorized')}</p><p><a href="/" style="background:#333;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;">Back to Catalog</a></p></main><script>/* slider script (omitted for brevity) */</script></body></html>`;
  res.send(html);
});

// sitemap
app.get('/sitemap.xml', (req,res) => {
  const products = readProducts();
  const urls = [`${SITE_URL}/`,`${SITE_URL}/admin.html`, ...products.map(p => `${SITE_URL}/product/${encodeURIComponent(p.id)}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
  res.header('Content-Type', 'application/xml').send(xml);
});

app.listen(PORT, () => {
  console.log(`Project root: ${projectRoot}`);
  console.log(`Serving static from: ${publicDir}`);
  console.log(`Uploads dir: ${uploadsDir}`);
  if (s3Client) console.log('S3 mode enabled. Bucket:', S3_BUCKET, 'Region:', S3_REGION);
  console.log(`Server running at ${SITE_URL} (PORT=${PORT})`);
});
