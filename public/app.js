/* public/app.js - robust product rendering + visible WhatsApp buttons */
(async function () {
  const container = document.getElementById('catalog');
  if (!container) { console.error('No #catalog element found.'); return; }

  const placeholder = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="100%" height="100%" fill="#f6f7fb"/><text x="50%" y="60%" text-anchor="middle" fill="#9aa" font-family="Arial">No image</text></svg>`
  );

  // get server config
  let serverWhats = '';
  try {
    const r = await fetch('/api/config');
    if (r.ok) {
      const cfg = await r.json();
      serverWhats = (cfg.whatsapp || '').trim();
    }
  } catch(e) { /* ignore */ }

  // build image src
  function buildImageSrc(v){
    if (!v) return placeholder;
    v = v.toString().trim();
    if (!v) return placeholder;
    if (/^https?:\/\//i.test(v)) return v;
    if (v.startsWith('/')) return window.location.origin + v;
    return window.location.origin + '/uploads/' + v;
  }

  // fetch products and render
  async function loadProducts(){
    let products = [];
    try {
      const r = await fetch('/api/products');
      products = r.ok ? await r.json() : [];
    } catch(e){ console.error('Failed to fetch products', e); products = []; }

    container.innerHTML = '';
    if (!products || products.length === 0) {
      container.innerHTML = '<p style="padding:18px">No products yet. Add some in <a href="/admin.html">Admin</a>.</p>';
      return;
    }

    products.forEach((p, idx) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.id = 'product-' + (p.id || idx);

      // image
      //const img = document.createElement('img');
      //img.alt = p.name || 'product';
      //img.src = buildImageSrc(p.image);
      //img.onerror = () => { img.src = placeholder; };
      //card.appendChild(img);

      /* Display first image (or placeholder)
      const img = document.createElement('img');
      if (p.images && p.images.length > 0) {
      img.src = p.images[0];
      } else {
      img.src = "/placeholder.png"; // optional fallback
      }
      img.alt = p.name;
      card.appendChild(img);*/

      // MINI SLIDER inside catalog card
      const slider = document.createElement('div');
      slider.className = 'mini-slider';
      // main image
      const mainImg = document.createElement('img');
      mainImg.className = 'mini-main';

      const imgs = Array.isArray(p.images) ? p.images : [];
      const normalize = s => {
        if (!s) return "/placeholder.png";
        if (/^https?:/i.test(s)) return s;
        if (s.startsWith('/')) return window.location.origin + s;
        return window.location.origin + '/uploads/' + s;
      };

      mainImg.src = imgs.length ? normalize(imgs[0]) : "/placeholder.png";
      slider.appendChild(mainImg);
      
      // thumbnails row
      const thumbs = document.createElement('div');
      thumbs.className = 'mini-thumbs';
      
      imgs.forEach((src, i) => {
        const t = document.createElement('img');
        t.src = normalize(src);
        t.className = "mini-thumb";

        if (i === 0) t.classList.add("active");

        t.addEventListener("click", () => {
          mainImg.src = t.src;
          thumbs.querySelectorAll("img").forEach(im => im.classList.remove("active"));
          t.classList.add("active");
        });
        thumbs.appendChild(t);
      });
      slider.appendChild(thumbs);
      card.appendChild(slider);

      // content
      const h3 = document.createElement('h3'); h3.textContent = p.name || 'Unnamed'; card.appendChild(h3);
      const sku = document.createElement('div'); sku.innerHTML = '<small>SKU: ' + (p.sku||'-') + '</small>'; card.appendChild(sku);
      const desc = document.createElement('p'); desc.textContent = p.description || ''; card.appendChild(desc);
      if (p.price) { const price = document.createElement('div'); price.innerHTML = '<strong>' + p.price + '</strong>'; card.appendChild(price); }

      // WhatsApp button (always visible)
      const btn = document.createElement('a');
      btn.className = 'btn whatsapp';
      btn.textContent = 'Order on WhatsApp';
      btn.href = '#';
      // inline style to ensure visibility before CSS loads
      btn.style.display = 'inline-block';
      btn.style.background = '#25D366';
      btn.style.color = '#fff';
      btn.style.padding = '10px 14px';
      btn.style.borderRadius = '8px';
      btn.style.textDecoration = 'none';
      btn.style.marginTop = '8px';
      btn.onclick = (ev) => {
        ev.preventDefault();
        const number = serverWhats || prompt('Enter WhatsApp number (international, e.g. 9198xxxxxxx):');
        if (!number) return;
        const text = `Hello, I want to order: ${p.name || ''} (SKU: ${p.sku || ''}). Qty: ___ .`;
        window.open(`https://wa.me/${encodeURIComponent(number)}?text=${encodeURIComponent(text)}`, '_blank');
      };

      card.appendChild(btn);
      container.appendChild(card);
      

      // --- reveal animation helper: run after products are rendered ---
      function revealCatalogCards(stagger = 100) {
        const cards = Array.from(document.querySelectorAll('.card'));
        cards.forEach((card, i) => {
          // small delay to allow layout to settle
          setTimeout(() => {
            card.classList.add('visible');
          }, i * stagger);
        });
      }
      // If your app renders products dynamically, call revealCatalogCards()
    // after the rendering is finished. Example: at end of loadProducts() call:
    revealCatalogCards(120);



    });
    
  }

  loadProducts();
})();
