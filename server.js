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

// Парсим страницу товара через Browserbase
async function parsePage(url) {
  let session;
  try {
    session = await bb.sessions.create({
      projectId: process.env.BROWSERBASE_PROJECT_ID,
    });

    const browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // Название
      const name =
        document.querySelector('h1')?.innerText?.trim() ||
        document.querySelector('[class*="product-title"], [class*="product__title"], [class*="goods-title"]')?.innerText?.trim() ||
        document.title.split(/[–—|·]/)[0].trim();

      // Цена — ищем самую первую цифру рядом с ₽
      let price = null;
      const priceEl = [...document.querySelectorAll('*')]
        .find(el =>
          el.children.length === 0 &&
          /^\s*[\d\s]{4,12}\s*[₽руб]/.test(el.innerText)
        );
      if (priceEl) {
        const m = priceEl.innerText.match(/(\d[\d\s]{3,10})/);
        if (m) price = parseInt(m[1].replace(/\s/g, ''));
      }
      if (!price) {
        const m = bodyText.match(/(\d[\d\s]{3,9})\s*[₽руб]/);
        if (m) price = parseInt(m[1].replace(/\s/g, ''));
      }

      // Размер — ДxШxВ
      let size = null;
      const sizePatterns = [
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*см/,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*[xхх×]\s*(\d{2,3})/,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*см/,
      ];
      for (const p of sizePatterns) {
        const m = bodyText.match(p);
        if (m) {
          size = m[3] ? `${m[1]}x${m[2]}x${m[3]}` : `${m[1]}x${m[2]}`;
          break;
        }
      }

      // Цвет/материал
      let color = null;
      const colorPatterns = [
        /(?:цвет|обивка)[:\s]+([^\n,\.;]{3,60})/i,
        /(?:материал|ткань)[:\s]+([^\n,\.;]{3,60})/i,
        /(?:велюр|бархат|кожа|рогожка|шенилл|флок|текстиль|букле)[^\n,\.;]{0,50}/i,
      ];
      for (const p of colorPatterns) {
        const m = bodyText.match(p);
        if (m) { color = (m[1] || m[0]).trim().slice(0, 80); break; }
      }

      // Фото — og:image первым делом
      let image_url =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[name="og:image"]')?.content ||
        null;

      // Потом крупные img исключая логотипы и иконки
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
            i.w > 300 && i.h > 300 &&
            !i.alt.includes('logo') &&
            !i.src_lower.includes('logo') &&
            !i.src_lower.includes('icon') &&
            !i.src_lower.includes('banner')
          )
          .sort((a, b) => (b.w * b.h) - (a.w * a.h));

        if (imgs.length > 0) image_url = imgs[0].src;
      }

      // data-src для lazy-load
      if (!image_url) {
        const lazy = [...document.querySelectorAll('img[data-src],img[data-lazy],img[data-original]')]
          .map(i => i.dataset.src || i.dataset.lazy || i.dataset.original)
          .filter(s => s && s.startsWith('http') && !s.includes('logo'))[0];
        if (lazy) image_url = lazy;
      }

      return { name, price, size, color, image_url };
    });

    await browser.close();
    return { ok: true, ...result, url };

  } catch (e) {
    console.error('Ошибка парсинга:', e.message);
    return { ok: false, error: e.message, url };
  }
}

// API endpoint
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

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Запуск
app.listen(PORT, () => {
  console.log(`ezhome-parser запущен на порту ${PORT}`);
});
