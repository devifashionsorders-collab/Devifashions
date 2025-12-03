/* public/js/wa-order.js
   Replaces blocking prompt() with a small modal.
   Usage: add class "order-whatsapp" to Order buttons and include data attributes:
     data-sku, data-name, data-price, data-url
*/
(function () {
  'use strict';

  const CONFIG_URL = '/api/config';
  const LS_KEY = 'devifashions_wa_number';

  async function fetchConfig() {
    try {
      const res = await fetch(CONFIG_URL, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      console.warn('fetchConfig error', err);
      return null;
    }
  }

  function buildWhatsappUrl(number, text) {
    const digits = String(number || '').replace(/\D/g, '');
    if (!digits) return null;
    const q = encodeURIComponent(text || '');
    return `https://wa.me/${digits}?text=${q}`;
  }

  function createModal() {
    if (document.getElementById('waNumberModal')) return document.getElementById('waNumberModal');
    const modal = document.createElement('div');
    modal.id = 'waNumberModal';
    modal.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:40%',
      'transform:translate(-50%,-50%)',
      'z-index:99999',
      'background:#fff',
      'padding:14px',
      'border-radius:10px',
      'box-shadow:0 8px 30px rgba(0,0,0,0.35)',
      'min-width:320px',
      'max-width:90%',
      'font-family:system-ui,Segoe UI,Roboto,"Helvetica Neue",Arial'
    ].join(';');

    modal.innerHTML = `
      <div style="font-weight:600;margin-bottom:10px">Enter WhatsApp number (international, e.g. 9198xxxxxxx)</div>
      <input id="waNumberInput" type="tel" inputmode="numeric" placeholder="9198xxxxxxxx" 
             style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:15px;box-sizing:border-box" />
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button id="waCancelBtn" style="background:#eee;border:none;padding:8px 12px;border-radius:6px;cursor:pointer">Cancel</button>
        <button id="waSaveBtn" style="background:#28a745;color:#fff;border:none;padding:8px 12px;border-radius:6px;cursor:pointer">Save & Continue</button>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  }

  function promptNumberModal(defaultValue = '') {
    return new Promise(resolve => {
      const modal = createModal();
      const input = modal.querySelector('#waNumberInput');
      const save = modal.querySelector('#waSaveBtn');
      const cancel = modal.querySelector('#waCancelBtn');

      input.value = defaultValue || '';
      modal.style.display = 'block';
      input.focus();

      function cleanup() {
        modal.style.display = 'none';
        save.removeEventListener('click', onSave);
        cancel.removeEventListener('click', onCancel);
        input.removeEventListener('keydown', onKey);
      }

      function onSave() {
        let v = input.value.trim();
        v = v.replace(/\D/g, '');
        if (!v) {
          input.style.borderColor = 'crimson';
          return;
        }
        cleanup();
        resolve(v);
      }

      function onCancel() {
        cleanup();
        resolve(null);
      }

      function onKey(e) {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter') onSave();
      }

      save.addEventListener('click', onSave);
      cancel.addEventListener('click', onCancel);
      input.addEventListener('keydown', onKey);
    });
  }

  async function handleOrderClick(productData) {
    const cfg = await fetchConfig();
    let serverNumber = cfg && cfg.whatsapp ? String(cfg.whatsapp).replace(/\D/g, '') : null;

    let localNumber = null;
    try { localNumber = localStorage.getItem(LS_KEY); } catch (e) { localNumber = null; }

    let number = serverNumber || localNumber;
    if (!number) {
      const entered = await promptNumberModal(localNumber || '');
      if (!entered) return;
      number = entered;
      try { localStorage.setItem(LS_KEY, number); } catch (e) {}
    }

    const name = productData.name || '';
    const sku = productData.sku || '';
    const price = productData.price || '';
    const pageUrl = (productData.url && productData.url.startsWith('http')) ? productData.url : (location.origin + (productData.url || location.pathname));
    const msg = `Hi, I would like to order: ${name} (SKU: ${sku}). Price: ${price}. Product: ${pageUrl}`;

    const waUrl = buildWhatsappUrl(number, msg);
    if (!waUrl) {
      alert('Invalid phone number.');
      return;
    }

    window.open(waUrl, '_blank', 'noopener,noreferrer');
  }

  function attachHandlers(root = document) {
    const buttons = root.querySelectorAll('.order-whatsapp');
    buttons.forEach(btn => {
      if (btn.__wa_attached) return;
      btn.__wa_attached = true;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const el = e.currentTarget;
        const product = {
          sku: el.getAttribute('data-sku') || el.dataset.sku,
          name: el.getAttribute('data-name') || el.dataset.name,
          price: el.getAttribute('data-price') || el.dataset.price,
          url: el.getAttribute('data-url') || el.dataset.url
        };
        handleOrderClick(product);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => attachHandlers(document));
  } else {
    attachHandlers(document);
  }

  window.attachWaOrderHandlers = attachHandlers;

})();
