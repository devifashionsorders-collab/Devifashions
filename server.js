// server.js - Final production-ready with optional S3 uploads
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

// AWS SDK v3
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const PORT = process.env.PORT || 3000;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const SITE_URL = (process.env.SITE_URL && process.env.SITE_URL.replace(/\/$/,'')) || `http://localhost:${PORT}`;

const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || '';
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || '';

let s3Client = null;
if (S3_BUCKET && S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
  s3Client = new S3Client({
    region: S3_REGION,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY
    }
  });
  console.log('S3 mode enabled. Bucket:', S3_BUCKET, 'Region:', S3_REGION);
} else {
  console.log('S3 not fully configured. Using local disk uploads (development).');
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

// Ensure folders exist
[publicDir, uploadsDir, dataDir].forEach(dir => {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
});

if (!fs.existsSync(productsFile)) fs.writeFileSync(productsFile, JSON.stringify([], null, 2));

app.use(express.static(publicDir));

console.log('Project root:', projectRoot);
console.log('Serving static from:', publicDir);
console.log('Uploads dir:', uploadsDir);

// multer setups
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random()*1e9);
    const ext = path.extname(file.originalname) || '';
    cb(null, `${unique}${ext}`);
  }
});
const uploadDisk = multer({ storage: diskStorage });
const uploadMemory = multer({ storage: multer.memoryStorage() });

// helpers
function readProducts() {
  try { return JSON.parse(fs.readFileSync(productsFile)); }
  catch (e) { return []; }
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
function toAbsoluteUrl(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return SITE_URL + src;
  return SITE_URL + '/uploads/' + src;
}

// S3 upload helper using @aws-sdk/lib-storage (Upload)
async function uploadBufferToS3(buffer, filename, mimeType = 'application/octet-stream') {
  if (!s3Client) throw new Error('S3 not configured');

  const key = `uploads/${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(filename) || ''}`;

  const parallelUpload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ACL: 'public-read' // ensure objects are publicly readable
    }
  });

  await parallelUpload.done();

  // Return the public S3 URL (standard format)
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

// Routes

// Serve index/admin explicitly
app.get('/', (req, res) => {
  const file = path.join(publicDir, 'index.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('index.html not found.');
});
app.get('/admin.html', (req, res) => {
  const file = path.join(publicDir, 'admin.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).send('admin.html not found.');
});

// config endpoint
app.get('/api/config', (req, res) => {
  res.json({ whatsapp: WHATSAPP_NUMBER || '', siteUrl: SITE_URL });
});

// list products
app.get('/api/products', (req, res) => {
  const products = readProducts();
  res.json(products);
});

// Add / Create product (multi-image support)
// If S3 configured -> upload images to S3 (memory), else -> save to /public/uploads
if (s3Client) {
  app.post('/api/products', uploadMemory.array('images', 20), async (req, res) => {
    try {
      const { name, sku, description, price, category } = req.body;
      if (!name || !sku) return res.status(400).json({ error: 'name and sku required' });

      const products = readProducts();
      const id = Date.now().toString();
      const images = [];

      if (Array.isArray(req.files) && req.files.length > 0) {
        for (const f of req.files) {
          const url = await uploadBufferToS3(f.buffer, f.originalname, f.mimetype);
          images.push(url);
        }
      }

      const product = {
        id,
        name,
        sku,
        description: description || '',
        price: price || '',
        category: category || 'Uncategorized',
        images, // full S3 URLs
        url: `${SITE_URL}/product/${id}`
      };

      products.push(product);
      writeProducts(products);

      res.json({ ok: true, product });
    } catch (err) {
      console.error('upload->s3 error', err);
      res.status(500).json({ error: 'upload failed', details: err.message });
    }
  });
} else {
  // disk fallback
  app.post('/api/products', uploadDisk.array('images', 20), (req, res) => {
    try {
      const { name, sku, description, price, category } = req.body;
      if (!name || !sku) return res.status(400).json({ error: 'name and sku required' });

      const products = readProducts();
      const id = Date.now().toString();
      const images = [];

      if (Array.isArray(req.files) && req.files.length > 0) {
        req.files.forEach(f => images.push(`/uploads/${f.filename}`));
      }

      const product = {
        id,
        name,
        sku,
        description: description || '',
        price: price || '',
        category: category || 'Uncategorized',
        images, // local paths
        url: `${SITE_URL}/product/${id}`
      };

      products.push(product);
      writeProducts(products);

      res.json({ ok: true, product });
    } catch (err) {
      console.error('upload->disk error', err);
      res.status(500).json({ error: 'upload failed', details: err.message });
    }
  });
}

// CSV upload: name,sku,description,price,imageUrl,category
app.post('/api/upload-csv', uploadDisk.single('csvfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'csvfile required' });
  const results = [];
  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', () => {
      const products = readProducts();
      results.forEach(row => {
        const id = Date.now().toString() + Math.round(Math.random()*1e5);
        const product = {
          id,
          name: (row.name || '').trim(),
          sku: (row.sku || '').trim(),
          description: (row.description || '').trim(),
          price: (row.price || '').trim(),
          category: (row.category || 'Uncategorized').trim(),
          images: row.imageUrl ? [ (row.imageUrl || '').trim() ] : [],
          url: `${SITE_URL}/product/${id}`
        };
        if (product.name && product.sku) products.push(product);
      });
      writeProducts(products);
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      res.json({ ok: true, added: results.length });
    });
});

// Update categories by SKU mapping: POST { mappings: { "<SKU>": "Category", ... } }
app.post('/api/update-categories', (req, res) => {
  try {
    const mappings = req.body && req.body.mappings;
    if (!mappings || typeof mappings !== 'object') return res.status(400).json({ error: 'mappings object required' });

    const products = readProducts();
    let updated = 0;
    const notFound = [];
    const skuIndex = {};
    products.forEach((p, i) => { if (p.sku) skuIndex[p.sku] = i; });

    Object.keys(mappings).forEach(sku => {
      if (skuIndex.hasOwnProperty(sku)) {
        products[skuIndex[sku]].category = mappings[sku];
        updated++;
      } else notFound.push(sku);
    });

    writeProducts(products);
    res.json({ ok: true, updated, notFound });
  } catch (err) {
    console.error('update-categories error', err);
    res.status(500).json({ error: 'internal' });
  }
});

// PRODUCT PAGE (multi-image gallery + swipe slider + SEO)
app.get("/product/:id", (req, res) => {
  const id = req.params.id;
  const products = readProducts();
  const p = products.find(x => x.id === id || x.sku === id);
  if (!p) return res.status(404).send("Product Not Found");

  const images = Array.isArray(p.images) ? p.images : [];
  const mainImage = images.length ? (images[0].startsWith('http') ? images[0] : (images[0].startsWith('/') ? SITE_URL + images[0] : SITE_URL + '/uploads/' + images[0])) : `${SITE_URL}/uploads/placeholder.png`;
  const slidesHtml = images.map(src => {
    const abs = /^https?:\/\//i.test(src) ? src : (src.startsWith('/') ? SITE_URL + src : SITE_URL + '/uploads/' + src);
    return `<div class="slide"><img src="${abs}" alt="${escapeHtml(p.name)}" /></div>`;
  }).join('');
  const dotsHtml = images.map((_, i) => `<span class="dot" data-index="${i}"></span>`).join('');

  const title = `${escapeHtml(p.name)} — SKU ${escapeHtml(p.sku)} | Devi Fashions`;
  const desc = escapeHtml(p.description || '');
  const canonical = `${SITE_URL}/product/${encodeURIComponent(id)}`;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<meta name="description" content="${desc}" />
<link rel="canonical" href="${canonical}" />
<meta property="og:image" content="${mainImage}" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/styles.css" />
<style>
  .slider-container { width:100%; max-width:700px; margin:0 auto 20px; overflow:hidden; border-radius:12px; }
  .slider-track { display:flex; transition:transform .35s ease; touch-action:pan-y; }
  .slide { min-width:100%; user-select:none; }
  .slide img { width:100%; display:block; border-radius:12px; }
  .slider-dots { text-align:center; margin-top:10px; }
  .dot { width:12px; height:12px; background:#bbb; border-radius:50%; display:inline-block; margin:0 4px; cursor:pointer; transition:.25s;}
  .dot.active { background:#5727A3; }
</style>
</head>
<body>
  <main style="padding:20px;max-width:900px;margin:auto;">
    <h1>${escapeHtml(p.name)}</h1>
    <div class="slider-container">
      <div class="slider-track">
        ${slidesHtml}
      </div>
      <div class="slider-dots">${dotsHtml}</div>
    </div>

    <p><strong>Description:</strong><br/>${escapeHtml(p.description)}</p>
    <p><strong>SKU:</strong> ${escapeHtml(p.sku)}</p>
    <p><strong>Price:</strong> ${escapeHtml(p.price || 'Contact for price')}</p>
    <p><strong>Category:</strong> ${escapeHtml(p.category || 'Uncategorized')}</p>

    <p><a href="/" style="background:#333;color:#fff;padding:10px 14px;border-radius:8px;text-decoration:none;">Back to Catalog</a></p>
  </main>

<script>
(function(){
  const track = document.querySelector('.slider-track');
  const slides = document.querySelectorAll('.slide');
  const dots = document.querySelectorAll('.dot');
  let index = 0, startX = 0, isDragging = false;
  function updateSlider(){
    if (!track) return;
    track.style.transform = 'translateX(-' + (index * 100) + '%)';
    dots.forEach(d => d.classList.remove('active'));
    if (dots[index]) dots[index].classList.add('active');
  }
  dots.forEach(d => d.addEventListener('click', () => { index = Number(d.dataset.index); updateSlider(); }));
  if(track){
    track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; isDragging = true; });
    track.addEventListener('touchmove', e => { if(!isDragging) return; const diff = e.touches[0].clientX - startX; track.style.transform = 'translateX(' + (diff - index*100) + '%)'; });
    track.addEventListener('touchend', e => { isDragging = false; const diff = e.changedTouches[0].clientX - startX; if(diff > 50 && index > 0) index--; if(diff < -50 && index < slides.length-1) index++; updateSlider(); });

    track.addEventListener('mousedown', e => { startX = e.clientX; isDragging = true; });
    track.addEventListener('mousemove', e => { if(!isDragging) return; const diff = e.clientX - startX; track.style.transform = 'translateX(' + (diff - index*100) + '%)'; });
    track.addEventListener('mouseup', e => { isDragging = false; const diff = e.clientX - startX; if(diff > 50 && index > 0) index--; if(diff < -50 && index < slides.length-1) index++; updateSlider(); });
  }
  updateSlider();
})();
</script>
</body>
</html>`;

  res.send(html);
});

// sitemap
app.get('/sitemap.xml', (req, res) => {
  const products = readProducts();
  const urls = [
    `${SITE_URL}/`,
    `${SITE_URL}/admin.html`,
    ...products.map(p => `${SITE_URL}/product/${encodeURIComponent(p.id)}`)
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map(u => `  <url><loc>${u}</loc></url>`).join('\n') +
    `\n</urlset>`;
  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

// start server
app.listen(PORT, () => {
  console.log(`Server running at ${SITE_URL} (PORT=${PORT})`);
});
