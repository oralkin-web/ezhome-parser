const express = require('express');
const { chromium } = require('playwright-core');
const Browserbase = require('@browserbasehq/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('public'));

const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });

async function parsePage(url, debug = false) {
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

    // Грузим страницу — ждём только domcontentloaded (быстро)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Ждём появления цены ИЛИ максимум 5 секунд
    try {
      await page.waitForSelector(
        '[data-testid="price"],[class*="price__current"],[class*="price_current"],[itemprop="price"],[class*="price__value"],[class*="product__price"]',
        { timeout: 5000 }
      );
    } catch(e) {}

    // Закрываем попапы
    try {
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await btn.innerText().catch(() => '');
        if (text.includes('Да') || text.includes('верно') || text.includes('Принять')) {
          await btn.click({ force: true });
          break;
        }
      }
    } catch(e) {}
    try { await page.keyboard.press('Escape'); } catch(e) {}

    // Минимальная пауза для рендера
    await page.waitForTimeout(1000);

    const result = await page.evaluate((isDebug) => {
      const GARBAGE = [
        'на фото может', 'может отличаться', 'реального изделия', 'представленного на фото',
        'выдерживает', 'эксплуатацию', 'особенностей', 'изображениях', 'фотографий',
        'отправим', 'мессенджер', 'доставка', 'оплата', 'подробнее', 'добавить',
        'корзину', 'купить', 'заказать', 'наличии', 'популярные', 'запросы', 'обивки:',
        'на сайте могут', 'от реальных', 'изображени', 'фотограф'
      ];
      const isGarbage = (s) => !s || s.trim().length < 2 || GARBAGE.some(g => s.toLowerCase().includes(g));
      const isColorGarbage = (s) => !s || /^[\d\s\+\-]+$/.test(s.trim()) || isGarbage(s);

      // JSON-LD
      let jsonld = null;
      try {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
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
      const debugPrices = [];
      let price = null;

      const priceSelectors = [
        '[data-testid="price"]','[data-test="price"]','[data-qa="price"]',
        '[class*="price__current"]','[class*="price_current"]','[class*="price-current"]',
        '[class*="price__value"]','[class*="price-value"]','[class*="priceValue"]',
        '[class*="product__price"]','[class*="productPrice"]','[class*="product-price"]',
        '[itemprop="price"]','[class*="offer__price"]','[class*="item-price"]',
        '[class*="main-price"]','[class*="actual-price"]','[class*="final-price"]',
        '[class*="price__number"]','[class*="price__amount"]','[class*="price__sale"]',
        '[class*="price__new"]',
      ];
      const cssFound = [];
      for (const sel of priceSelectors) {
        // Для data-testid берём ТОЛЬКО ПЕРВЫЙ элемент — это цена текущего товара
        const isTestId = sel.includes('data-testid') || sel.includes('data-test') || sel.includes('data-qa');
        const els = isTestId
          ? [document.querySelector(sel)].filter(Boolean)
          : [...document.querySelectorAll(sel)];
        for (const el of els) {
          const allowChildren = isTestId;
          if ((allowChildren || el.children.length === 0) && /\d/.test(el.innerText)) {
            const m = el.innerText.replace(/руб\.?/g, '₽').match(/(\d[\d\s]{2,10})/);
            if (m) {
              const p = parseInt(m[1].replace(/\s/g, ''));
              if (p >= 1000 && p <= 10000000) cssFound.push({ sel, text: el.innerText.trim(), val: p });
            }
          }
        }
        if (cssFound.length > 0) break; // Нашли в первом подходящем селекторе — хватит
      }
      if (isDebug) debugPrices.push({ source: 'css', found: cssFound });
      const cssVals = cssFound.map(x => x.val).filter(p => p >= 3000);
      if (cssVals.length > 0) price = cssVals[0]; // Первая найденная цена

      // JSON-LD
      if (!price && jsonld?.offers) {
        const offers = Array.isArray(jsonld.offers) ? jsonld.offers[0] : jsonld.offers;
        const p = parseFloat(String(offers?.price || '').replace(/\s/g, ''));
        if (p >= 1000 && p <= 10000000) price = p;
        if (isDebug) debugPrices.push({ source: 'jsonld', val: p });
      }

      // Fallback — все элементы с ₽ или руб, берём наибольшую разумную
      if (!price) {
        const allRub = [];
        for (const el of document.querySelectorAll('*')) {
          if (el.children.length === 0 && /[\d\s]{3,12}[₽]|[\d\s]{3,12}руб/.test(el.innerText)) {
            const m = el.innerText.replace(/руб\.?/g, '₽').match(/(\d[\d\s]{2,10})/);
            if (m) {
              const p = parseInt(m[1].replace(/\s/g, ''));
              // Пропускаем старые/зачёркнутые цены
            const cls = (el.className || '').toLowerCase();
            const isOldPrice = cls.includes('old') || cls.includes('cross') || cls.includes('strike') || cls.includes('origin') || cls.includes('before') || cls.includes('prev');
            if (p >= 3000 && p <= 10000000 && !isOldPrice) allRub.push({ val: p, cls: el.className?.slice(0,50) });
            }
          }
        }
        allRub.sort((a, b) => b.val - a.val);
        if (isDebug) debugPrices.push({ source: 'rub_elements', top5: allRub.slice(0,5) });
        if (allRub.length > 0) price = allRub[0].val;
      }

      // Евро
      if (!price) {
        const m = bodyText.match(/([\d.,]+)\s*€/) || bodyText.match(/€\s*([\d.,]+)/);
        if (m) {
          const p = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
          if (p >= 10 && p <= 100000) price = p;
        }
      }

      // ── РАЗМЕР ──
      let size = null;
      const specText = [...document.querySelectorAll(
        '[class*="spec"],[class*="param"],[class*="char"],[class*="dimension"],[class*="size"],[class*="feature"]'
      )].map(el => el.innerText).join('\n');
      const sizeSearch = specText + '\n' + bodyText;

      const sizePatterns = [
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*см/i,
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})/i,
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})\s*см/i,
        /([1-9]\d{1,2})\s*[xхх×]\s*([1-9]\d{1,2})/i,
        /диаметр[:\s]*(\d+[\d,.]*)\s*см/i,
        /ø\s*([1-9]\d{0,2}[\d,.]*)/i,
      ];
      for (const p of sizePatterns) {
        const m = sizeSearch.match(p);
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
      // Fallback из названия
      if (!size && name) {
        for (const p of sizePatterns) {
          const m = name.match(p);
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
      }

      // ── ЦВЕТ ──
      let color = null;
      if (jsonld?.color && !isColorGarbage(jsonld.color)) color = jsonld.color.trim().slice(0, 60);
      if (!color) {
        const colorEls = [...document.querySelectorAll('[class*="color"],[class*="colour"],[class*="Color"]')]
          .filter(el => el.children.length === 0 && el.innerText.trim().length >= 2 && el.innerText.trim().length <= 40 && !isColorGarbage(el.innerText));
        if (colorEls.length > 0) color = colorEls[0].innerText.trim();
      }
      if (!color) {
        const activeColor = document.querySelector(
          '[class*="active"][class*="color"],[class*="selected"][class*="color"],' +
          '[class*="color"][class*="active"],[class*="color"][class*="selected"],' +
          '[class*="swatch"][class*="active"],[class*="chip"][class*="active"]'
        );
        if (activeColor) {
          const t = activeColor.innerText?.trim() || activeColor.getAttribute('title') || activeColor.getAttribute('data-name');
          if (t && !isColorGarbage(t)) color = t.slice(0, 60);
        }
      }
      if (!color) {
        const strictPatterns = [
          /(?:^|\n)\s*цвет\s*[:\-]?\s*([^\n]{2,40})/im,
          /(?:^|\n)\s*обивка\s*[:\-]?\s*([^\n]{2,40})/im,
          /(?:^|\n)\s*покрытие\s*[:\-]?\s*([^\n]{2,40})/im,
          /(?:^|\n)\s*colour\s*[:\-]?\s*([^\n]{2,40})/im,
          /(?:^|\n)\s*color\s*[:\-]?\s*([^\n]{2,40})/im,
        ];
        for (const p of strictPatterns) {
          const m = bodyText.match(p);
          if (m && !isColorGarbage(m[1])) { color = m[1].trim().slice(0, 60); break; }
        }
      }
      if (!color) {
        const m = bodyText.match(/\b(велюр|бархат|экокожа|рогожка|шенилл|флок|текстиль|букле|лён|замша)\b[^\n,\.;]{0,25}/i);
        if (m && !isColorGarbage(m[0])) color = m[0].trim().slice(0, 60);
      }
      if (!color && name) {
        const mName = name.match(/(?:цвет|обивка)[:\s]+([^\n,\.;]{2,40})/i) ||
                      name.match(/\b(велюр|бархат|экокожа|рогожка|шенилл|флок|букле)\b[^\n,\.;]{0,20}/i);
        if (mName && !isColorGarbage(mName[1] || mName[0])) color = (mName[1] || mName[0]).trim().slice(0, 60);
      }
      // Базовые цвета из названия
      if (!color && name) {
        const basicColors = name.match(/\b(чёрный|черный|белый|серый|бежевый|коричневый|синий|зеленый|зелёный|красный|розовый|голубой|жёлтый|желтый|оранжевый|фиолетовый|золотой|серебристый)\b/i);
        if (basicColors) color = basicColors[0].trim();
      }

      // ── ФОТО ──
      let image_url = document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[name="og:image"]')?.content || null;
      if (image_url && (image_url.includes('.svg') || image_url.includes('favicon') || image_url.includes('logo'))) image_url = null;
      if (!image_url && jsonld?.image) {
        const img = Array.isArray(jsonld.image) ? jsonld.image[0] : jsonld.image;
        if (typeof img === 'string' && img.startsWith('http') && !img.includes('.svg')) image_url = img;
        else if (img?.url) image_url = img.url;
      }
      if (!image_url) {
        const imgs = [...document.querySelectorAll('img')]
          .map(i => ({ src: i.src||i.currentSrc, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt||'').toLowerCase(), src_lower: (i.src||'').toLowerCase() }))
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

      if (isDebug) return { name, price, size, color, image_url, _debug: { prices: debugPrices, jsonld_color: jsonld?.color, jsonld_price: jsonld?.offers?.price } };
      return { name, price, size, color, image_url };
    }, debug);

    await browser.close();
    return { ok: true, ...result, url };
  } catch (e) {
    console.error('Ошибка:', e.message);
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: e.message, url };
  }
}

app.post('/parse', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  console.log('Парсю:', url);
  const start = Date.now();
  const result = await parsePage(url, false);
  result.time_ms = Date.now() - start;
  console.log('Готово за', result.time_ms, 'мс:', result.name);
  res.json(result);
});

app.post('/debug', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL обязателен' });
  const result = await parsePage(url, true);
  res.json(result);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log(`ezhome-parser запущен на порту ${PORT}`));
