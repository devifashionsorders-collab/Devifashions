// server.js - production-ready with Cloudinary + S3 + local disk fallback
require('dotenv').config();

const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const https = require('https');
const http = require('http');

// cloudinary (optional)
const cloudinary = require('cloudinary').v2;

// AWS SDK (v3) (optional)
const { S3Client } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const PORT = process.env.PORT || 3000;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || `${25 * 1024 * 1024}`, 10); // 25MB default
const ALLOWED_IMAGE_MIMES = (process.env.ALLOWED_IMAGE_MIMES || 'image/jpeg,image/png,image/webp,image/gif').split(',');

// ----------------- Cloudinary config (optional) -----------------
const CLOUDINARY_CONFIGURED = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
if (CLOUDINARY_CONFIGURED) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
  console.log('Cloudinary mode enabled. Cloud:', process.env.CLOUDINARY_CLOUD_NAME);
} else {
  console.log('Cloudinary not configured.');
}

// ----------------- S3 config (optional) -----------------
const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
let s3Client = null;
const S3_CONFIGURED = !!(S3_BUCKET && S3_REGION);
if (S3_CONFIGURED) {
  s3Client = new S3Client({ region: S3_REGION });
  console.log('S3 mode enabled. Bucket:', S3_BUCKET, 'Region:', S3_REGION);
} else {
  console.log('S3 not configured.');
}

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Directories for local mode
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

console.log('Project root:', projectRoot);
console.log('Serving static from:', publicDir);
console.log('Uploads dir:', uploadsDir);

// ---------- multer configuration ----------
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '';
    cb(null, `${unique}${ext}`);
  }
});

const uploadDisk = multer({
  storage: diskStorage,
  limits: { fileSize: MAX_FILE_SIZE }
});

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

// ---------- helpers ----------
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
function normalizeToAbsolute(src) {
  if (!src) return '';
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith('/')) return SITE_URL + src;
  return SITE_URL + '/uploads/' + src;
}
function isAllowedImageMime(mime) {
  if (!mime) return false;
  return ALLOWED_IMAGE_MIMES.includes(mime.toLowerCase());
}

// ---------- Cloudinary helper (if configured) ----------
async function uploadBufferToCloudinary(buffer, filename, folder = 'devifashions') {
  if (!CLOUDINARY_CONFIGURED) throw new Error('Cloudinary not configured');
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        use_filename: true,
        unique_filename: true,
        resource_type: 'image'
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result); // contains secure_url, public_id, etc
      }
    );
    stream.end(buffer);
  });
}

// ---------- S3 upload helper (if S3 configured) ----------
async function uploadBufferToS3(buffer, filename, mimeType = 'application/octet-stream') {
  if (!s3Client || !S3_BUCKET || !S3_REGION) {
    throw new Error('S3 not configured');
  }
  const key = `uploads/${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(filename) || ''}`;
  const parallelUpload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      ACL: 'public-read'
    }
  });
  await parallelUpload.done();
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
}

// Fetch remote URL into buffer (used for CSV remote images when S3 is desired)
function fetchBufferFromUrl(url) {
  return new Promise((resolve, reject) => {
    try {
      const client = url.startsWith('https://') ? https : http;
      client.get(url, (res) => {
        const status = res.statusCode;
        if (status >= 400) return reject(new Error('Failed to fetch remote image, status ' + status));
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(err));
      }).on('error', (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });
}

// ---------- routes ----------

// Serve index/admin explicitly (if present)
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
// Behavior priority:
// 1) Cloudinary (if configured)
// 2) S3 (if configured)
// 3) local disk
app.post('/api/products', (req, res, next) => {
  // We'll accept both 'image' (single) and 'images' (multiple) from the form.
  if (CLOUDINARY_CONFIGURED || S3_CONFIGURED) {
    // use memory storage so we can upload buffers to cloud services
    const fields = [
      { name: 'image', maxCount: 1 },
      { name: 'images', maxCount: 20 }
    ];
    return uploadMemory.fields(fields)(req, res, (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'multer error', details: err.message });
      handleCloudOrS3Product(req, res).catch(e => {
        console.error('upload error', e);
        res.status(500).json({ ok: false, error: 'upload failed', details: e.message });
      });
    });
  } else {
    // local disk storage - accept both fields
    const fields = [
      { name: 'image', maxCount: 1 },
      { name: 'images', maxCount: 20 }
    ];
    return uploadDisk.fields(fields)(req, res, (err) => {
      if (err) return res.status(500).json({ ok: false, error: 'multer error', details: err.message });
      try {
        handleDiskProduct(req, res);
      } catch (e) {
        console.error('upload->disk error', e);
        res.status(500).json({ ok: false, error: 'upload failed', details: e.message });
      }
    });
  }
});

// Handler for Cloudinary or S3 uploads
async function handleCloudOrS3Product(req, res) {
  const { name, sku, description, price, category } = req.body;
  if (!name || !sku) return res.status(400).json({ ok: false, error: 'name and sku required' });

  const products = readProducts();
  const id = Date.now().toString();
  const images = [];

  // Collect uploaded files from either field names: req.files['image'] and req.files['images']
  const files = [];
  if (req.files && req.files.image && Array.isArray(req.files.image) && req.files.image.length) {
    files.push(...req.files.image);
  }
  if (req.files && req.files.images && Array.isArray(req.files.images) && req.files.images.length) {
    files.push(...req.files.images);
  }

  if (files.length > 0) {
    // Process in parallel but safely
    const uploadPromises = files.map(async (f) => {
      if (!isAllowedImageMime(f.mimetype)) {
        throw new Error('disallowed mime type: ' + f.mimetype);
      }
      if (CLOUDINARY_CONFIGURED) {
        const result = await uploadBufferToCloudinary(f.buffer, f.originalname, 'devifashions/products');
        return { ok: true, url: result.secure_url, meta: result };
      } else {
        const url = await uploadBufferToS3(f.buffer, f.originalname, f.mimetype);
        return { ok: true, url };
      }
    });

    const settled = await Promise.allSettled(uploadPromises);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        images.push(s.value.url);
      } else {
        console.warn('file upload failed for one file:', s.reason && s.reason.message);
        // we continue — don't abort entire product creation
      }
    }
  }

  const product = {
    id,
    name,
    sku,
    description: description || '',
    price: price || '',
    category: category || 'Uncategorized',
    images, // cloud URLs or S3 URLs
    url: `${SITE_URL}/product/${id}`
  };

  products.push(product);
  writeProducts(products);

  res.json({ ok: true, product });
}

// Handler for disk uploads
function handleDiskProduct(req, res) {
  const { name, sku, description, price, category } = req.body;
  if (!name || !sku) return res.status(400).json({ ok: false, error: 'name and sku required' });

  const products = readProducts();
  const id = Date.now().toString();
  const images = [];

  // disk multer stores files into req.files (object when using fields)
  if (req.files) {
    if (req.files.image && Array.isArray(req.files.image)) {
      req.files.image.forEach(f => images.push(`/uploads/${f.filename}`));
    }
    if (req.files.images && Array.isArray(req.files.images)) {
      req.files.images.forEach(f => images.push(`/uploads/${f.filename}`));
    }
  }

  // support older case where uploadDisk.array('images') was used
  if (Array.isArray(req.files) && req.files.length) {
    req.files.forEach(f => images.push(`/uploads/${f.filename}`));
  }

  const product = {
    id,
    name,
    sku,
    description: description || '',
    price: price || '',
    category: category || 'Uncategorized',
    images,
    url: `${SITE_URL}/product/${id}`
  };

  products.push(product);
  writeProducts(products);

  res.json({ ok: true, product });
}

// CSV upload: expected headers name,sku,description,price,imageUrl,category
app.post('/api/upload-csv', (req, res, next) => {
  // Use disk-based multer for CSV upload (to allow stream parsing)
  uploadDisk.single('csvfile')(req, res, (err) => {
    if (err) return res.status(500).json({ ok: false, error: 'multer error', details: err.message });
    if (!req.file) return res.status(400).json({ ok: false, error: 'csvfile required' });

    const results = [];
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', async () => {
        try {
          const products = readProducts();
          let addedCount = 0;
          for (const row of results) {
            const id = Date.now().toString() + Math.round(Math.random()*1e5);
            const p = {
              id,
              name: (row.name || '').trim(),
              sku: (row.sku || '').trim(),
              description: (row.description || '').trim(),
              price: (row.price || '').trim(),
              category: (row.category || 'Uncategorized').trim(),
              images: [],
              url: `${SITE_URL}/product/${id}`
            };

            // If imageUrl present, attempt to upload to cloud or S3 (or keep as-is for local)
            const remote = (row.imageUrl || '').trim();
            if (remote) {
              try {
                if (CLOUDINARY_CONFIGURED) {
                  // Cloudinary can ingest remote URLs directly
                  const r = await cloudinary.uploader.upload(remote, {
                    folder: `devifashions/products`,
                    resource_type: 'image',
                    use_filename: true,
                    unique_filename: true
                  });
                  p.images.push(r.secure_url);
                } else if (S3_CONFIGURED) {
                  // fetch remote buffer then upload to S3
                  const buffer = await fetchBufferFromUrl(remote);
                  const url = await uploadBufferToS3(buffer, path.basename(remote), 'image/*');
                  p.images.push(url);
                } else {
                  // local mode: keep remote URL as-is (or optionally download to local uploads dir)
                  p.images.push(remote);
                }
              } catch (err) {
                console.warn('Failed to import remote image for CSV row', p.sku || p.name, err.message);
                // skip image but continue
              }
            }

            if (p.name && p.sku) {
              products.push(p);
              addedCount++;
            }
          }

          writeProducts(products);
          try { fs.unlinkSync(req.file.path); } catch (e) {}
          res.json({ ok: true, added: addedCount });
        } catch (err) {
          console.error('CSV processing error', err);
          try { fs.unlinkSync(req.file.path); } catch (_) {}
          res.status(500).json({ ok: false, error: 'csv processing failed', details: err.message });
        }
      })
      .on('error', (err) => {
        console.error('CSV stream error', err);
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        res.status(500).json({ ok: false, error: 'csv read error', details: err.message });
      });
  });
});

// Update categories by SKU mapping
// Body: { mappings: { "SKU1": "Silk", "SKU2": "Cotton" } }
app.post('/api/update-categories', (req, res) => {
  try {
    const mappings = req.body && req.body.mappings;
    if (!mappings || typeof mappings !== 'object') return res.status(400).json({ ok: false, error: 'mappings object required' });

    const products = readProducts();
    let updated = 0;
    const notFound = [];

    const skuIndex = {};
    products.forEach((p, i) => { if (p.sku) skuIndex[p.sku] = i; });

    Object.keys(mappings).forEach(sku => {
      if (skuIndex.hasOwnProperty(sku)) {
        const idx = skuIndex[sku];
        products[idx].category = mappings[sku];
        updated++;
      } else {
        notFound.push(sku);
      }
    });

    writeProducts(products);
    res.json({ ok: true, updated, notFound });
  } catch (err) {
    console.error('update-categories error', err);
    res.status(500).json({ ok: false, error: 'internal' });
  }
});

// PRODUCT PAGE (MULTI-IMAGE GALLERY + SWIPE SLIDER + SEO)
app.get("/product/:id", (req, res) => {
  const id = req.params.id;
  const products = readProducts();
  const p = products.find(x => x.id === id || x.sku === id);
  if (!p) return res.status(404).send("Product Not Found");

  // images array (may contain Cloudinary/S3 URLs or local paths)
  const images = Array.isArray(p.images) ? p.images : [];

  const title = `${escapeHtml(p.name)} — SKU ${escapeHtml(p.sku)} | Devi Fashions`;
  const desc = escapeHtml(p.description || '');
  const canonical = `${SITE_URL}/product/${encodeURIComponent(id)}`;

  // build slide items and ensure absolute srcs
  const slidesHtml = images.map(src => {
    const abs = /^https?:\/\//i.test(src) ? src : (src.startsWith('/') ? SITE_URL + src : SITE_URL + '/uploads/' + src);
    return `<div class="slide"><img src="${abs}" alt="${escapeHtml(p.name)}"></div>`;
  }).join('');

  const dotsHtml = images.map((_, i) => `<span class="dot" data-index="${i}"></span>`).join('');

  // fallback mainImage
  const mainImage = images.length ? (/^https?:\/\//i.test(images[0]) ? images[0] : (images[0].startsWith('/') ? SITE_URL + images[0] : SITE_URL + '/uploads/' + images[0])) : `${SITE_URL}/uploads/placeholder.png`;

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
    .slider-container { width:100%; max-width:600px; margin:0 auto 20px; overflow:hidden; border-radius:12px; }
    .slider-track { display:flex; transition:transform .35s ease; touch-action:pan-y; }
    .slide { min-width:100%; user-select:none; }
    .slide img { width:100%; height:auto; display:block; border-radius:12px; }
    .slider-dots { text-align:center; margin-top:10px; }
    .dot { width:12px; height:12px; background:#bbb; border-radius:50%; display:inline-block; margin:0 4px; cursor:pointer; transition:.25s; }
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
    let index = 0;
    let startX = 0;
    let isDragging = false;

    function updateSlider() {
      if (!track) return;
      track.style.transform = 'translateX(-' + (index * 100) + '%)';
      dots.forEach(d => d.classList.remove('active'));
      if (dots[index]) dots[index].classList.add('active');
    }

    dots.forEach(d => d.addEventListener('click', () => {
      index = Number(d.dataset.index);
      updateSlider();
    }));

    // touch handlers
    track.addEventListener('touchstart', e => { startX = e.touches[0].clientX; isDragging = true; });
    track.addEventListener('touchmove', e => {
      if (!isDragging) return;
      const diff = e.touches[0].clientX - startX;
      track.style.transform = 'translateX(' + (diff - index*100) + '%)';
    });
    track.addEventListener('touchend', e => {
      isDragging = false;
      const diff = e.changedTouches[0].clientX - startX;
      if (diff > 50 && index > 0) index--;
      if (diff < -50 && index < slides.length - 1) index++;
      updateSlider();
    });

    // mouse drag
    track.addEventListener('mousedown', e => { startX = e.clientX; isDragging = true; });
    track.addEventListener('mousemove', e => {
      if (!isDragging) return;
      const diff = e.clientX - startX;
      track.style.transform = 'translateX(' + (diff - index*100) + '%)';
    });
    track.addEventListener('mouseup', e => {
      isDragging = false;
      const diff = e.clientX - startX;
      if (diff > 50 && index > 0) index--;
      if (diff < -50 && index < slides.length - 1) index++;
      updateSlider();
    });

    // initialize
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
