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
    });

    browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0];
    const page = context.pages()[0];

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    // Ждём полной загрузки включая редиректы
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Ждём пока навигация полностью завершится
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
    } catch (e) {
      // networkidle timeout — ок, продолжаем
    }

    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // Название
      const name =
        document.querySelector('h1')?.innerText?.trim() ||
        document.querySelector('[class*="product-title"], [class*="product__title"], [class*="goods-title"]')?.innerText?.trim() ||
        document.title.split(/[–—|·]/)[0].trim();

      // Цена — рубли, евро (разные форматы), доллары
      let price = null;

      // Рубли: 12 990 ₽ или 12990руб
      const priceElRub = [...document.querySelectorAll('*')]
        .find(el =>
          el.children.length === 0 &&
          /^\s*[\d\s]{4,12}\s*[₽руб]/.test(el.innerText)
        );
      if (priceElRub) {
        const m = priceElRub.innerText.match(/(\d[\d\s]{3,10})/);
        if (m) price = parseInt(m[1].replace(/\s/g, ''));
      }
      if (!price) {
        const m = bodyText.match(/(\d[\d\s]{3,9})\s*[₽руб]/);
        if (m) price = parseInt(m[1].replace(/\s/g, ''));
      }

      // Евро: 399,00 € или € 399 или 399.00€
      if (!price) {
        const m = bodyText.match(/([\d.,]+)\s*€/) || bodyText.match(/€\s*([\d.,]+)/);
        if (m) price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      }

      // Доллары
      if (!price) {
        const m = bodyText.match(/\$\s*([\d.,]+)/);
        if (m) price = parseFloat(m[1].replace(',', '.'));
      }

      // Размер — ДxШxВ + диаметр
      let size = null;
      const sizePatterns = [
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*см/i,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*[xхх×]\s*(\d{2,3})/i,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})\s*см/i,
        /(\d{2,3})\s*[xхх×]\s*(\d{2,3})/i,
        /диаметр\s*(\d+[\d,.]*)\s*см/i,
        /ø\s*(\d+[\d,.]*)/i,
        /(\d{2,3})\s*см/i,
      ];
      for (const p of sizePatterns) {
        const m = bodyText.match(p);
        if (m) {
          if (m[3]) size = `${m[1]}x${m[2]}x${m[3]}`;
          else if (m[2]) size = `${m[1]}x${m[2]}`;
          else size = `⌀${m[1]}`;
          break;
        }
      }

      // Цвет/материал
      let color = null;
      const colorPatterns = [
        /(?:цвет|обивка|покрытие|colour|color)[:\s]+([^\n,\.;]{3,60})/i,
        /(?:материал|ткань|корпус|material)[:\s]+([^\n,\.;]{3,60})/i,
        /(?:велюр|бархат|кожа|рогожка|шенилл|флок|текстиль|букле|металл|дерево|пластик|white|black|grey|beige)[^\n,\.;]{0,50}/i,
      ];
      for (const p of colorPatterns) {
        const m = bodyText.match(p);
        if (m) { color = (m[1] || m[0]).trim().slice(0, 80); break; }
      }

      // Фото
      let image_url =
        document.querySelector('meta[property="og:image"]')?.content ||
        document.querySelector('meta[name="og:image"]')?.content ||
        null;

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
