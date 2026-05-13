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
    // Прокси только для сайтов с защитой
    const PROXY_SITES = ['hoff.ru', 'divan.ru'];
    const needsProxy = PROXY_SITES.some(site => url.includes(site));

    const session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      ...(needsProxy ? { proxies: true } : {}),
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
      const isColorGarbage = (s) => !s || /^[\d\s\+\-]+$/.test(s.trim()) || /^\(\d+\)$/.test(s.trim()) || isGarbage(s);

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

      // ── ЦЕНА — только в верхних 800px страницы ──
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
        const isTestId = sel.includes('data-testid') || sel.includes('data-test') || sel.includes('data-qa');
        // Для data-testid берём первый элемент в верхних 800px
        const els = isTestId
          ? [document.querySelector(sel)].filter(Boolean)
          : [...document.querySelectorAll(sel)].filter(el => {
              const rect = el.getBoundingClientRect();
              return rect.top < 800; // только первый экран
            });
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
        if (cssFound.length > 0) break;
      }
      if (isDebug) debugPrices.push({ source: 'css', found: cssFound });
      const cssVals = cssFound.map(x => x.val).filter(p => p >= 3000);
      if (cssVals.length > 0) price = cssVals[0];

      // JSON-LD
      if (!price && jsonld?.offers) {
        const offers = Array.isArray(jsonld.offers) ? jsonld.offers[0] : jsonld.offers;
        const p = parseFloat(String(offers?.price || '').replace(/\s/g, ''));
        if (p >= 1000 && p <= 10000000) price = p;
      }

      // Fallback — ₽ только в верхних 800px
      if (!price) {
        const allRub = [];
        for (const el of document.querySelectorAll('*')) {
          const rect = el.getBoundingClientRect();
          if (rect.top > 800) continue;
          if (el.children.length === 0 && /[\d\s]{3,12}[₽]|[\d\s]{3,12}руб/.test(el.innerText)) {
            const m = el.innerText.replace(/руб\.?/g, '₽').match(/(\d[\d\s]{2,10})/);
            if (m) {
              const p = parseInt(m[1].replace(/\s/g, ''));
              const cls = (el.className || '').toLowerCase();
              const isOld = cls.includes('old') || cls.includes('cross') || cls.includes('strike') || cls.includes('origin') || cls.includes('before') || cls.includes('prev');
              if (p >= 3000 && p <= 10000000 && !isOld) allRub.push({ val: p });
            }
          }
        }
        allRub.sort((a, b) => b.val - a.val);
        if (isDebug) debugPrices.push({ source: 'rub_top800', top5: allRub.slice(0,5) });
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

      // Ищем блок характеристик по заголовку
      let specBlock = '';
      const headings = [...document.querySelectorAll('h2,h3,h4,th,dt,[class*="title"],[class*="heading"]')];
      for (const h of headings) {
        const t = h.innerText?.toLowerCase() || '';
        if (t.includes('характеристик') || t.includes('параметр') || t.includes('габарит') || t.includes('размер')) {
          // Берём текст следующего блока
          let next = h.nextElementSibling;
          for (let i = 0; i < 5 && next; i++) {
            specBlock += next.innerText + '\n';
            next = next.nextElementSibling;
          }
          // Также берём родительский блок
          if (h.parentElement) specBlock += h.parentElement.innerText + '\n';
          break;
        }
      }

      // Также стандартные блоки характеристик
      const specElText = [...document.querySelectorAll(
        '[class*="spec"],[class*="param"],[class*="char"],[class*="dimension"],[class*="feature"],' +
        '[class*="detail"][class*="table"],[class*="detailtable"],[class*="properties"],[class*="attrs"],' +
        '[class*="technical"],[class*="info-table"],[class*="product-info"]'
      )].map(el => el.innerText).join('\n');

      const sizeSearch = specBlock + '\n' + specElText + '\n' + bodyText;

      // 1. Паттерны ШхГхВ из твоего списка
      const namedPatterns = [
        // Divan.ru: "Длина 272 см x Ширина 112 см x Высота 83 см"
        /длина\s+(\d{2,3})\s*см\s*x\s*ширина\s+(\d{2,3})\s*см\s*x\s*высота\s+(\d{2,3})\s*см/i,
        /длина\s+(\d{2,3})\s*x\s*ширина\s+(\d{2,3})\s*x\s*высота\s+(\d{2,3})/i,
        // ШхГхВ формат: 140х80х90
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*см/i,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*[xхх×]\s*(\d{2,3})/i,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*см/i,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})/i,
        // Диаметр
        /диаметр[:\s]*(\d+[\d,.]*)\s*см/i,
        /ø\s*([1-9]\d{0,2}[\d,.]*)/i,
      ];

      for (const p of namedPatterns) {
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

      // 2. Собираем Ширину/Глубину/Высоту по словам из списка
      if (!size) {
        const dimMap = {};

        // Паттерны поиска из твоего списка
        const dimKeywords = [
          { keys: ['ширина', 'габаритная ширина', 'шир', 'width', 'w'], dim: 'w' },
          { keys: ['глубина', 'габаритная глубина', 'глуб', 'depth', 'г'], dim: 'd' },
          { keys: ['высота', 'габаритная высота', 'выс', 'height', 'в'], dim: 'h' },
          { keys: ['длина', 'length', 'д'], dim: 'l' },
        ];

        for (const { keys, dim } of dimKeywords) {
          for (const key of keys) {
            // Ищем "Ширина, см\n53" или "Ширина: 53" или "Ширина 53 см"
            const re = new RegExp(key + '[,:\\s,см]+([\\d]+)', 'i');
            const m = sizeSearch.match(re);
            if (m) {
              const val = parseInt(m[1]);
              if (val >= 10 && val <= 500) { dimMap[dim] = val; break; }
            }
          }
        }

        // Собираем размер
        if (dimMap.w && dimMap.d && dimMap.h) size = `${dimMap.w}x${dimMap.d}x${dimMap.h}`;
        else if (dimMap.l && dimMap.w && dimMap.h) size = `${dimMap.l}x${dimMap.w}x${dimMap.h}`;
        else if (dimMap.w && dimMap.h) size = `${dimMap.w}x${dimMap.h}`;
        else if (dimMap.l && dimMap.h) size = `${dimMap.l}x${dimMap.h}`;
        else if (dimMap.w && dimMap.d) size = `${dimMap.w}x${dimMap.d}`;
      }

      // 3. Fallback из названия
      if (!size && name) {
        for (const p of namedPatterns) {
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
      // Ткань из строки "Ткань 1: Ультра Серый велюр" на divan.ru
      if (!color) {
        const fabricLine = bodyText.match(/ткань\s*\d*\s*:\s*[^\n]{3,60}/i);
        if (fabricLine) {
          const fabricVal = fabricLine[0].replace(/ткань\s*\d*\s*:\s*/i, '').trim();
          if (!isColorGarbage(fabricVal)) color = fabricVal.slice(0, 60);
        }
      }
      if (!color) {
        const m = bodyText.match(/\b(велюр|бархат|экокожа|рогожка|шенилл|флок|текстиль|букле|лён|замша)\b[^\n,\.;]{0,25}/i);
        if (m && !isColorGarbage(m[0])) color = m[0].trim().slice(0, 60);
      }
      if (!color && name) {
        const afterSize = name.match(/\d+[x×хх][\d×хх\d]+\s+([А-ЯЁа-яёA-Za-z][^\d\n,\.]{1,40})/i);
        if (afterSize && !isColorGarbage(afterSize[1])) color = afterSize[1].trim().slice(0, 60);
      }
      if (!color && name) {
        const basicColors = name.match(/\b(чёрный|черный|белый|серый|бежевый|коричневый|синий|зеленый|зелёный|красный|розовый|голубой|жёлтый|желтый|оранжевый|фиолетовый|золотой|серебристый|латте|капучино|мокко|антрацит|графит|слоновая)\b/i);
        if (basicColors) color = basicColors[0].trim();
      }
      // Ткань/материал из скобок в названии: "Пуф Аура (ткань Teddy 33)" → "ткань Teddy 33"
      if (!color && name) {
        const inParens = name.match(/\(([^)]{3,50})\)/);
        if (inParens && !isColorGarbage(inParens[1])) color = inParens[1].trim().slice(0, 60);
      }

      // ── ФОТО ──
      let image_url = document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[name="og:image"]')?.content || null;
      if (image_url && (image_url.includes('.svg') || image_url.includes('favicon') || image_url.includes('logo') || image_url.includes('photo_image') || image_url.includes('no_photo') || image_url.includes('no-photo') || image_url.includes('noimage') || image_url.includes('placeholder'))) image_url = null;

      if (!image_url && jsonld?.image) {
        const img = Array.isArray(jsonld.image) ? jsonld.image[0] : jsonld.image;
        if (typeof img === 'string' && img.startsWith('http') && !img.includes('.svg')) image_url = img;
        else if (img?.url) image_url = img.url;
      }

      // Карусель/галерея — первое фото товара
      if (!image_url) {
        const carouselImg = document.querySelector(
          '[class*="carousel"] img,[class*="gallery"] img,[class*="slider"] img,' +
          '[class*="swiper"] img,[class*="product-image"] img,[class*="productImage"] img,' +
          '[class*="product__image"] img,[class*="product-photo"] img'
        );
        if (carouselImg) {
          const src = carouselImg.src || carouselImg.currentSrc || carouselImg.dataset.src;
          if (src && src.startsWith('http') && !src.includes('.svg') && !src.includes('logo')) image_url = src;
        }
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

      if (isDebug) return { name, price, size, color, image_url, _debug: { prices: debugPrices } };
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
