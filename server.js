const express = require('express');
const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const bb = new Browserbase({
  apiKey: process.env.BROWSERBASE_API_KEY,
});

async function parsePage(url) {
  let browser;
  try {
    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      proxies: true,
      browserSettings: { stealth: true }
    });

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) {}
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {

      // ── МУСОРНЫЕ ФРАЗЫ для цвета ──
      const GARBAGE = [
        'на фото может', 'может отличаться', 'реального изделия', 'представленного на фото',
        'выдерживает', 'эксплуатацию', 'особенностей', 'изображениях', 'фотографий',
        'отправим', 'мессенджер', 'доставка', 'оплата', 'подробнее', 'добавить',
        'корзину', 'купить', 'заказать', 'наличии'
      ];
      const isGarbage = (s) => !s || GARBAGE.some(g => s.toLowerCase().includes(g));

      // ── JSON-LD structured data ──
      let jsonld = null;
      try {
        const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const s of scripts) {
          const d = JSON.parse(s.textContent);
          const prod = d['@type'] === 'Product' ? d : (Array.isArray(d) ? d.find(x => x['@type'] === 'Product') : null);
          if (prod) { jsonld = prod; break; }
        }
      } catch(e) {}

      const bodyText = document.body.innerText;

      // ── НАЗВАНИЕ ──
      const name =
        document.querySelector('h1')?.innerText?.trim() ||
        document.querySelector('[class*="product-title"], [class*="product__title"], [class*="goods-title"]')?.innerText?.trim() ||
        document.title.split(/[–—|·]/)[0].trim();

      // ── ЦЕНА ──
      let price = null;

      // 1. JSON-LD
      if (jsonld?.offers) {
        const offers = Array.isArray(jsonld.offers) ? jsonld.offers[0] : jsonld.offers;
        const p = parseFloat(offers?.price);
        if (p > 100 && p < 100000000) price = p;
      }

      // 2. meta og:price
      if (!price) {
        const metaPrice = document.querySelector('meta[property="product:price:amount"], meta[name="price"]')?.content;
        if (metaPrice) {
          const p = parseFloat(metaPrice.replace(/\s/g, '').replace(',', '.'));
          if (p > 100 && p < 100000000) price = p;
        }
      }

      // 3. Элементы с price/cost в классе — только листовые
      if (!price) {
        const priceEl = [...document.querySelectorAll('[class*="price"],[class*="cost"],[class*="Price"],[itemprop="price"]')]
          .find(el => el.children.length === 0 && /[\d]/.test(el.innerText));
        if (priceEl) {
          const m = priceEl.innerText.match(/(\d[\d\s]{2,10})/);
          if (m) {
            const p = parseInt(m[1].replace(/\s/g, ''));
            if (p > 100 && p < 100000000) price = p;
          }
        }
      }

      // 4. Regex по тексту — рубли
      if (!price) {
        const priceElRub = [...document.querySelectorAll('*')]
          .find(el =>
            el.children.length === 0 &&
            /^\s*[\d\s]{4,12}\s*[₽руб]/.test(el.innerText)
          );
        if (priceElRub) {
          const m = priceElRub.innerText.match(/(\d[\d\s]{3,10})/);
          if (m) {
            const p = parseInt(m[1].replace(/\s/g, ''));
            if (p > 100 && p < 100000000) price = p;
          }
        }
      }
      if (!price) {
        const m = bodyText.match(/(\d[\d\s]{3,9})\s*[₽руб]/);
        if (m) {
          const p = parseInt(m[1].replace(/\s/g, ''));
          if (p > 100 && p < 100000000) price = p;
        }
      }

      // 5. Евро
      if (!price) {
        const m = bodyText.match(/([\d.,]+)\s*€/) || bodyText.match(/€\s*([\d.,]+)/);
        if (m) {
          const p = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
          if (p > 1 && p < 1000000) price = p;
        }
      }

      // ── РАЗМЕР ──
      let size = null;

      // Паттерны — числа от 10 до 999
      const sizePatterns = [
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*см/i,
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})/i,
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*см/i,
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})/i,
        /диаметр[:\s]*([1-9]\d{0,2}[\d,.]*)\s*см/i,
        /ø\s*([1-9]\d{0,2}[\d,.]*)/i,
      ];

      // Ищем в элементах с size/dimension в классе сначала
      const sizeEl = [...document.querySelectorAll('[class*="size"],[class*="dimension"],[class*="param"],[class*="spec"]')]
        .map(el => el.innerText).join('\n');

      const searchText = sizeEl + '\n' + bodyText;

      for (const p of sizePatterns) {
        const m = searchText.match(p);
        if (m) {
          const nums = [m[1], m[2], m[3]].filter(Boolean).map(Number);
          // Все числа должны быть в реалистичном диапазоне для мебели
          if (nums.every(n => n >= 10 && n <= 500)) {
            if (nums.length === 3) size = `${nums[0]}x${nums[1]}x${nums[2]}`;
            else if (nums.length === 2) size = `${nums[0]}x${nums[1]}`;
            else size = `⌀${nums[0]}`;
            break;
          }
        }
      }

      // ── ЦВЕТ ──
      let color = null;

      // 1. JSON-LD
      if (jsonld?.color && !isGarbage(jsonld.color)) {
        color = jsonld.color.trim().slice(0, 60);
      }

      // 2. Meta
      if (!color) {
        const metaColor = document.querySelector('meta[property="product:color"]')?.content;
        if (metaColor && !isGarbage(metaColor)) color = metaColor.trim().slice(0, 60);
      }

      // 3. Элементы с color/colour/цвет в классе или тексте
      if (!color) {
        const colorEls = [...document.querySelectorAll('[class*="color"],[class*="colour"],[class*="цвет"],[class*="Color"]')]
          .filter(el => el.children.length === 0 && el.innerText.trim().length > 1 && el.innerText.trim().length < 60);
        for (const el of colorEls) {
          const t = el.innerText.trim();
          if (!isGarbage(t)) { color = t; break; }
        }
      }

      // 4. Паттерны по тексту
      if (!color) {
        const colorPatterns = [
          /(?:^|\n)цвет[:\s]+([^\n,\.;]{2,40})/im,
          /(?:^|\n)обивка[:\s]+([^\n,\.;]{2,40})/im,
          /(?:^|\n)покрытие[:\s]+([^\n,\.;]{2,40})/im,
          /(?:^|\n)цвет корпуса[:\s]+([^\n,\.;]{2,40})/im,
          /(?:^|\n)colour[:\s]+([^\n,\.;]{2,40})/im,
          /(?:^|\n)color[:\s]+([^\n,\.;]{2,40})/im,
        ];
        for (const p of colorPatterns) {
          const m = bodyText.match(p);
          if (m && !isGarbage(m[1])) { color = m[1].trim().slice(0, 60); break; }
        }
      }

      // 5. Известные материалы
      if (!color) {
        const materialPatterns = [
          /\b(велюр|бархат|экокожа|рогожка|шенилл|флок|текстиль|букле|лён|хлопок|замша)\b[^\n,\.;]{0,30}/i,
          /\b(дуб|бук|берёза|сосна|металл|хром|матовый|глянцевый)\b[^\n,\.;]{0,20}/i,
        ];
        for (const p of materialPatterns) {
          const m = bodyText.match(p);
          if (m && !isGarbage(m[0])) { color = m[0].trim().slice(0, 60); break; }
        }
      }

      // ── ФОТО ──
      let image_url =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[name="og:image"]')?.content ||
        null;

      // Фильтруем svg, favicon, пустые
      if (image_url && (image_url.includes('.svg') || image_url.includes('favicon') || image_url.includes('logo'))) {
        image_url = null;
      }

      if (!image_url && jsonld?.image) {
        const img = Array.isArray(jsonld.image) ? jsonld.image[0] : jsonld.image;
        if (typeof img === 'string' && img.startsWith('http')) image_url = img;
        else if (img?.url) image_url = img.url;
      }

      if (!image_url) {
        const imgs = [...document.querySelectorAll('img')]
          .map(i => ({
            src: i.src || i.currentSrc,
            w: i.naturalWidth,
            h: i.naturalHeight,
            alt: (i.alt || '').toLowerCase(),
            src_lower: (i.src || '').toLowerCase()
          }))
          .filter(i =>
            i.src &&
            i.src.startsWith('http') &&
            !i.src.includes('.svg') &&
            !i.src.includes('favicon') &&
            i.w > 300 && i.h > 300 &&
            !i.alt.includes('logo') &&
            !i.src_lower.includes('logo') &&
            !i.src_lower.includes('icon') &&
            !i.src_lower.includes('banner')
          )
          .sort((a, b) => (b.w * b.h) - (a.w * a.h));
        if (imgs.length > 0) image_url = imgs[0].src;
      }

      if (!image_url) {
        const lazy = [...document.querySelectorAll('img[data-src],img[data-lazy],img[data-original]')]
          .map(i => i.dataset.src || i.dataset.lazy || i.dataset.original)
          .filter(s => s && s.startsWith('http') && !s.includes('logo') && !s.includes('.svg'))[0];
        if (lazy) image_url = lazy;
      }

      return { name, price, size, color, image_url };
    });

    await browser.close();
    return { ok: true, ...result, url };

  } catch (e) {
    console.error('Ошибка парсинга:', e.message);
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: e.message, url };
  }
}

app.post('/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  console.log('Парсю:', url);
  const start = Date.now();
  const result = await parsePage(url);
  result.time_ms = Date.now() - start;
  console.log('Готово за', result.time_ms, 'мс:', result.name);
  res.json(result);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`ezhome-parser запущен на порту ${PORT}`);
});
