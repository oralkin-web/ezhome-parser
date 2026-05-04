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

async function openPage(url) {
  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    proxies: true,
    browserSettings: { stealth: true }
  });
  const browser = await chromium.connectOverCDP(session.connectUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) {}
  await page.waitForTimeout(2000);
  return { browser, page };
}

// ── МУСОРНЫЕ ФРАЗЫ ──
const GARBAGE = [
  'на фото может', 'может отличаться', 'реального изделия', 'представленного на фото',
  'выдерживает', 'эксплуатацию', 'особенностей', 'изображениях', 'фотографий',
  'отправим', 'мессенджер', 'доставка', 'оплата', 'подробнее', 'добавить',
  'корзину', 'купить', 'заказать', 'наличии', 'популярные запросы', 'запросы'
];
const isGarbage = (s) => !s || s.trim().length < 2 || GARBAGE.some(g => s.toLowerCase().includes(g));

async function extractData(page) {
  return await page.evaluate(() => {
    const GARBAGE = [
      'на фото может', 'может отличаться', 'реального изделия', 'представленного на фото',
      'выдерживает', 'эксплуатацию', 'особенностей', 'изображениях', 'фотографий',
      'отправим', 'мессенджер', 'доставка', 'оплата', 'подробнее', 'добавить',
      'корзину', 'купить', 'заказать', 'наличии', 'популярные запросы', 'запросы'
    ];
    const isGarbage = (s) => !s || s.trim().length < 2 || GARBAGE.some(g => s.toLowerCase().includes(g));

    // JSON-LD
    let jsonld = null;
    try {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      for (const s of scripts) {
        const d = JSON.parse(s.textContent);
        const prod = d['@type'] === 'Product' ? d :
          (Array.isArray(d) ? d.find(x => x['@type'] === 'Product') : null);
        if (prod) { jsonld = prod; break; }
      }
    } catch(e) {}

    const bodyText = document.body.innerText;

    // ── НАЗВАНИЕ ──
    const name =
      document.querySelector('h1')?.innerText?.trim() ||
      document.querySelector('[class*="product-title"],[class*="product__title"],[class*="goods-title"]')?.innerText?.trim() ||
      document.title.split(/[–—|·]/)[0].trim();

    // ── ЦЕНА ──
    let price = null;

    // 1. Regex по всему тексту — рубли (самый надёжный для РФ сайтов)
    // Берём ВСЕ совпадения и выбираем наиболее вероятную цену товара
    const rubMatches = [];
    const rubRegex = /(\d[\d\s]{3,9})\s*[₽руб]/g;
    let m;
    while ((m = rubRegex.exec(bodyText)) !== null) {
      const p = parseInt(m[1].replace(/\s/g, ''));
      if (p >= 500 && p <= 10000000) rubMatches.push(p);
    }
    if (rubMatches.length > 0) {
      // Берём медиану — убирает выбросы (доставка, артикулы)
      rubMatches.sort((a, b) => a - b);
      const mid = Math.floor(rubMatches.length / 2);
      // Если много совпадений — берём самое частое значение или первое в разумном диапазоне
      // Фильтруем явно мусорные (< 1000 или > 5 000 000)
      const filtered = rubMatches.filter(p => p >= 1000 && p <= 5000000);
      if (filtered.length > 0) price = filtered[0]; // первая реальная цена на странице
    }

    // 2. Элементы с price в классе — листовые, приоритет
    if (!price) {
      const priceEls = [...document.querySelectorAll(
        '[class*="price__current"],[class*="price_current"],[class*="price-current"],' +
        '[class*="price__value"],[class*="price-value"],[class*="priceValue"],' +
        '[itemprop="price"],[class*="product__price"],[class*="productPrice"]'
      )].filter(el => el.children.length === 0 && /\d/.test(el.innerText));

      for (const el of priceEls) {
        const m = el.innerText.match(/(\d[\d\s]{2,10})/);
        if (m) {
          const p = parseInt(m[1].replace(/\s/g, ''));
          if (p >= 500 && p <= 10000000) { price = p; break; }
        }
      }
    }

    // 3. JSON-LD — только если цена в разумном диапазоне
    if (!price && jsonld?.offers) {
      const offers = Array.isArray(jsonld.offers) ? jsonld.offers[0] : jsonld.offers;
      const p = parseFloat(String(offers?.price || '').replace(/\s/g, ''));
      if (p >= 500 && p <= 10000000) price = p;
    }

    // 4. Евро
    if (!price) {
      const mEur = bodyText.match(/([\d.,]+)\s*€/) || bodyText.match(/€\s*([\d.,]+)/);
      if (mEur) {
        const p = parseFloat(mEur[1].replace(/\./g, '').replace(',', '.'));
        if (p >= 10 && p <= 100000) price = p;
      }
    }

    // ── РАЗМЕР ──
    let size = null;
    const sizePatterns = [
      /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*см/i,
      /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})/i,
      /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*см/i,
      /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})/i,
      /диаметр[:\s]*([1-9]\d{0,2}[\d,.]*)\s*см/i,
      /ø\s*([1-9]\d{0,2}[\d,.]*)/i,
    ];

    // Ищем сначала в блоках характеристик
    const specText = [...document.querySelectorAll(
      '[class*="spec"],[class*="param"],[class*="char"],[class*="dimension"],[class*="size"]'
    )].map(el => el.innerText).join('\n');

    const searchText = specText + '\n' + bodyText;

    for (const p of sizePatterns) {
      const m = searchText.match(p);
      if (m) {
        const nums = [m[1], m[2], m[3]].filter(Boolean).map(Number);
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

    // 1. JSON-LD color
    if (jsonld?.color && !isGarbage(jsonld.color)) {
      color = jsonld.color.trim().slice(0, 60);
    }

    // 2. Элементы с цветом в классе — только короткие значения
    if (!color) {
      const colorEls = [...document.querySelectorAll(
        '[class*="color"],[class*="colour"],[class*="цвет"],[class*="Color"]'
      )].filter(el =>
        el.children.length === 0 &&
        el.innerText.trim().length >= 2 &&
        el.innerText.trim().length <= 40 &&
        !isGarbage(el.innerText)
      );
      if (colorEls.length > 0) color = colorEls[0].innerText.trim();
    }

    // 3. Строгие паттерны — ищем после метки с новой строки
    if (!color) {
      const strictPatterns = [
        /(?:^|\n)\s*цвет\s*[:\-]?\s*([^\n]{2,40})/im,
        /(?:^|\n)\s*обивка\s*[:\-]?\s*([^\n]{2,40})/im,
        /(?:^|\n)\s*покрытие\s*[:\-]?\s*([^\n]{2,40})/im,
        /(?:^|\n)\s*цвет корпуса\s*[:\-]?\s*([^\n]{2,40})/im,
        /(?:^|\n)\s*colour\s*[:\-]?\s*([^\n]{2,40})/im,
        /(?:^|\n)\s*color\s*[:\-]?\s*([^\n]{2,40})/im,
      ];
      for (const p of strictPatterns) {
        const m = bodyText.match(p);
        if (m && !isGarbage(m[1])) { color = m[1].trim().slice(0, 60); break; }
      }
    }

    // 4. Материалы
    if (!color) {
      const matPat = /\b(велюр|бархат|экокожа|рогожка|шенилл|флок|текстиль|букле|лён|замша)\b[^\n,\.;]{0,25}/i;
      const m = bodyText.match(matPat);
      if (m && !isGarbage(m[0])) color = m[0].trim().slice(0, 60);
    }

    // ── ФОТО ──
    let image_url =
      document.querySelector('meta[property="og:image"]')?.content ||
      document.querySelector('meta[name="og:image"]')?.content ||
      null;

    if (image_url && (image_url.includes('.svg') || image_url.includes('favicon') || image_url.includes('logo'))) {
      image_url = null;
    }

    if (!image_url && jsonld?.image) {
      const img = Array.isArray(jsonld.image) ? jsonld.image[0] : jsonld.image;
      if (typeof img === 'string' && img.startsWith('http') && !img.includes('.svg')) image_url = img;
      else if (img?.url) image_url = img.url;
    }

    if (!image_url) {
      const imgs = [...document.querySelectorAll('img')]
        .map(i => ({ src: i.src || i.currentSrc, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt||'').toLowerCase(), src_lower: (i.src||'').toLowerCase() }))
        .filter(i => i.src && i.src.startsWith('http') && !i.src.includes('.svg') && !i.src.includes('favicon') && i.w > 300 && i.h > 300 && !i.alt.includes('logo') && !i.src_lower.includes('logo') && !i.src_lower.includes('icon') && !i.src_lower.includes('banner'))
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
}

async function parsePage(url) {
  let browser;
  try {
    const { browser: b, page } = await openPage(url);
    browser = b;
    const result = await extractData(page);
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
