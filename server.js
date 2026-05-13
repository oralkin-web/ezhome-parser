const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_EMAIL = 'oralkin@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function sendEmail(subject, html) {
  await sendEmailTo(ADMIN_EMAIL, subject, html);
}

async function sendEmailTo(to, subject, html) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ezhome <feedback@ezhome.design>',
        to,
        subject,
        html
      })
    });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      site TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      client TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      slug TEXT UNIQUE NOT NULL,
      comment TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      room TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT DEFAULT '',
      img TEXT DEFAULT '',
      size TEXT DEFAULT '',
      price NUMERIC DEFAULT 0,
      qty INTEGER DEFAULT 1,
      cmt TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS comment TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS logo TEXT DEFAULT ''`);
  console.log('DB initialized');
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'ezhome-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

const adminAuth = async (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  // Проверяем email из базы — не из сессии, чтобы старые сессии тоже работали
  try {
    const r = await pool.query('SELECT email FROM users WHERE id=$1', [req.session.userId]);
    if (!r.rows.length || r.rows[0].email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch(e) {
    res.status(500).json({ error: 'Server error' });
  }
};

// AUTH
const INVITE_TOKEN = process.env.INVITE_TOKEN || 'ezhome-beta-2024';
const MAX_USERS = 15;

// Проверка инвайт-токена
app.get('/invite/:token', (req, res) => {
  if (req.params.token !== INVITE_TOKEN) return res.status(404).send('<h1>Ссылка недействительна</h1>');
  res.sendFile(require('path').join(__dirname, '../public/index.html'));
});

app.post('/api/register', async (req, res) => {
  const { email, password, name, invite } = req.body;
  if (invite !== INVITE_TOKEN) return res.status(403).json({ error: 'Неверная ссылка для регистрации' });
  if (!email || !password || !name) return res.status(400).json({ error: 'Все поля обязательны' });
  const count = await pool.query('SELECT COUNT(*) FROM users');
  if (parseInt(count.rows[0].count) >= MAX_USERS) return res.status(403).json({ error: 'Достигнут лимит участников' });
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length) return res.status(400).json({ error: 'Email уже зарегистрирован' });
  const hash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  await pool.query('INSERT INTO users (id, email, password, name) VALUES ($1, $2, $3, $4)', [id, email.toLowerCase(), hash, name]);
  req.session.userId = id;
  req.session.userEmail = email.toLowerCase();
  res.json({ ok: true });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query('SELECT * FROM users WHERE email = $1', [email?.toLowerCase()]);
  const user = result.rows[0];
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Неверный email или пароль' });
  req.session.userId = user.id;
  req.session.userEmail = user.email;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', auth, async (req, res) => {
  const r = await pool.query('SELECT id, email, name, phone, site, logo FROM users WHERE id = $1', [req.session.userId]);
  const user = r.rows[0];
  user.isAdmin = user.email === ADMIN_EMAIL;
  res.json(user);
});

app.put('/api/me', auth, async (req, res) => {
  const { name, phone, site, logo } = req.body;
  await pool.query('UPDATE users SET name=$1, phone=$2, site=$3, logo=$4 WHERE id=$5', [name, phone, site, logo||'', req.session.userId]);
  res.json({ ok: true });
});

// FEEDBACK
app.post('/api/feedback', auth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Текст обязателен' });
  const id = uuidv4();
  await pool.query('INSERT INTO feedback (id, user_id, text) VALUES ($1, $2, $3)', [id, req.session.userId, text.trim()]);
  const userR = await pool.query('SELECT name, email FROM users WHERE id=$1', [req.session.userId]);
  const user = userR.rows[0];
  const date = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  await sendEmail(
    `Новый отзыв от ${user.name}`,
    `<p><b>${user.name}</b> (${user.email})</p><p>${date}</p><hr><p style="font-size:16px">${text.trim().replace(/\n/g, '<br>')}</p>`
  );
  res.json({ ok: true });
});


app.get('/api/feedback/mine', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, text, created_at FROM feedback WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
    [req.session.userId]
  );
  res.json(r.rows);
});

app.get('/api/feedback', adminAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT f.*, u.name as user_name, u.email as user_email
    FROM feedback f JOIN users u ON u.id = f.user_id
    ORDER BY f.created_at DESC
  `);
  res.json(r.rows);
});



// ADMIN PAGE
app.get('/admin', adminAuth, (req, res) => {
  res.sendFile(require('path').join(__dirname, '../public/admin.html'));
});

app.get('/api/admin/invite-url', adminAuth, (req, res) => {
  const base = process.env.APP_URL || 'https://app.ezhome.design';
  res.json({ url: base + '/invite/' + INVITE_TOKEN });
});

// ADMIN — список пользователей и сброс пароля
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT u.id, u.email, u.name, u.created_at,
           COUNT(f.id)::int as feedback_count
    FROM users u
    LEFT JOIN feedback f ON f.user_id = u.id
    WHERE u.email != $1
    GROUP BY u.id
    ORDER BY u.created_at ASC
  `, [ADMIN_EMAIL]);
  res.json(r.rows);
});

app.post('/api/admin/reset-password', adminAuth, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId обязателен' });
  const r = await pool.query('SELECT email, name FROM users WHERE id=$1', [userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
  const user = r.rows[0];
  // Генерируем временный пароль
  const tmpPass = Math.random().toString(36).slice(2, 10);
  const hash = bcrypt.hashSync(tmpPass, 10);
  await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, userId]);
  // Отправляем пользователю
  await sendEmailTo(user.email, 'Новый пароль — ezhome.design',
    `<p>Привет, ${user.name}!</p><p>Твой временный пароль: <b style="font-size:18px">${tmpPass}</b></p><p>Войди на <a href="https://app.ezhome.design">app.ezhome.design</a> и смени пароль в настройках.</p>`
  );
  res.json({ ok: true, tmpPass });
});




app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  // Не даём удалить самого себя
  const r = await pool.query('SELECT email FROM users WHERE id=$1', [id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  if (r.rows[0].email === ADMIN_EMAIL) return res.status(403).json({ error: 'Нельзя удалить администратора' });
  await pool.query('DELETE FROM feedback WHERE user_id=$1', [id]);
  await pool.query('DELETE FROM items WHERE project_id IN (SELECT id FROM projects WHERE user_id=$1)', [id]);
  await pool.query('DELETE FROM projects WHERE user_id=$1', [id]);
  await pool.query('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
});

// PROJECTS
app.get('/api/projects', auth, async (req, res) => {
  const r = await pool.query(`
    SELECT p.*, COUNT(i.id) as item_count, COALESCE(SUM(i.price * i.qty), 0) as total
    FROM projects p LEFT JOIN items i ON i.project_id = p.id
    WHERE p.user_id = $1
    GROUP BY p.id ORDER BY p.updated_at DESC
  `, [req.session.userId]);
  res.json(r.rows);
});

app.post('/api/projects', auth, async (req, res) => {
  const { name, client } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const id = uuidv4(), slug = uuidv4().slice(0, 8);
  await pool.query('INSERT INTO projects (id, user_id, name, client, slug) VALUES ($1, $2, $3, $4, $5)', [id, req.session.userId, name, client || '', slug]);
  res.json({ id, slug });
});

app.put('/api/projects/:id', auth, async (req, res) => {
  const { name, client, status } = req.body;
  const r = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  await pool.query('UPDATE projects SET name=$1, client=$2, status=$3, updated_at=NOW() WHERE id=$4', [name, client, status, req.params.id]);
  res.json({ ok: true });
});

app.put('/api/projects/:id/comment', auth, async (req, res) => {
  const { comment } = req.body;
  const r = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  await pool.query('UPDATE projects SET comment=$1, updated_at=NOW() WHERE id=$2', [comment || '', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  await pool.query('DELETE FROM items WHERE project_id=$1', [req.params.id]);
  await pool.query('DELETE FROM projects WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/projects/:id/duplicate', auth, async (req, res) => {
  const r = await pool.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  const p = r.rows[0];
  const newId = uuidv4(), newSlug = uuidv4().slice(0, 8);
  await pool.query('INSERT INTO projects (id, user_id, name, client, slug, status, comment) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [newId, req.session.userId, 'Копия — ' + p.name, p.client, newSlug, 'active', p.comment || '']);
  const items = await pool.query('SELECT * FROM items WHERE project_id=$1', [p.id]);
  for (const it of items.rows) {
    await pool.query('INSERT INTO items (id, project_id, room, name, url, img, size, price, qty, cmt, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [uuidv4(), newId, it.room, it.name, it.url, it.img, it.size, it.price, it.qty, it.cmt, it.sort_order]);
  }
  res.json({ id: newId, slug: newSlug });
});

// ITEMS
app.get('/api/projects/:id/items', auth, async (req, res) => {
  const r = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  const items = await pool.query('SELECT * FROM items WHERE project_id=$1 ORDER BY sort_order, room, id', [req.params.id]);
  res.json(items.rows);
});

app.post('/api/projects/:id/items', auth, async (req, res) => {
  const r = await pool.query('SELECT id FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });
  const { room, name, url, img, size, price, qty, cmt } = req.body;
  if (!name) return res.status(400).json({ error: 'Название обязательно' });
  const id = uuidv4();
  const maxOrder = await pool.query('SELECT MAX(sort_order) as m FROM items WHERE project_id=$1', [req.params.id]);
  const order = (maxOrder.rows[0].m || 0) + 1;
  await pool.query('INSERT INTO items (id, project_id, room, name, url, img, size, price, qty, cmt, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, req.params.id, room, name, url||'', img||'', size||'', price||0, qty||1, cmt||'', order]);
  await pool.query('UPDATE projects SET updated_at=NOW() WHERE id=$1', [req.params.id]);
  res.json({ id });
});

app.put('/api/items/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT i.id, p.user_id FROM items i JOIN projects p ON p.id=i.project_id WHERE i.id=$1', [req.params.id]);
  if (!r.rows.length || r.rows[0].user_id !== req.session.userId) return res.status(404).json({ error: 'Не найдено' });
  const { room, name, url, img, size, price, qty, cmt } = req.body;
  await pool.query('UPDATE items SET room=$1, name=$2, url=$3, img=$4, size=$5, price=$6, qty=$7, cmt=$8 WHERE id=$9',
    [room, name, url||'', img||'', size||'', price||0, qty||1, cmt||'', req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/items/:id', auth, async (req, res) => {
  const r = await pool.query('SELECT i.id, p.user_id FROM items i JOIN projects p ON p.id=i.project_id WHERE i.id=$1', [req.params.id]);
  if (!r.rows.length || r.rows[0].user_id !== req.session.userId) return res.status(404).json({ error: 'Не найдено' });
  await pool.query('DELETE FROM items WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// PUBLIC CLIENT PAGE
app.get('/p/:slug', async (req, res) => {
  const r = await pool.query(`
    SELECT p.*, u.name as designer_name, u.phone as designer_phone, u.email as designer_email, u.site as designer_site, u.logo as designer_logo
    FROM projects p JOIN users u ON u.id=p.user_id WHERE p.slug=$1
  `, [req.params.slug]);
  if (!r.rows.length) return res.status(404).send('<h1>Страница не найдена</h1>');
  const project = r.rows[0];
  const items = await pool.query('SELECT * FROM items WHERE project_id=$1 ORDER BY sort_order, room, id', [project.id]);
  res.send(buildClientPage(project, items.rows));
});

function buildClientPage(project, items) {
  const ROOM_ORDER = ["Гостиная","Кухня","Спальня","Прихожая","Детская","Ванная","Кабинет","Свет"];
  const grp = {};
  items.forEach(i => { (grp[i.room] = grp[i.room] || []).push(i); });
  const rooms = [...ROOM_ORDER, ...Object.keys(grp).filter(r => !ROOM_ORDER.includes(r))].filter(r => grp[r]);
  const grand = items.reduce((s, i) => s + Number(i.price) * i.qty, 0);
  const roomTot = {};
  rooms.forEach(r => { roomTot[r] = grp[r].reduce((s, i) => s + Number(i.price) * i.qty, 0); });
  const date = new Date().toLocaleDateString('ru-RU');
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const fmt = n => Number(n).toLocaleString('ru-RU') + '\u202f₽';
  const projectTitle = project.client || project.name;
  const comment = project.comment || '';

  const summaryCards = rooms.map(r => roomTot[r] ? `
    <div style="flex:1;background:#fff;padding:12px 16px;min-width:90px">
      <div style="font-size:9px;color:#8e8e93">${esc(r)}</div>
      <div style="font-size:15px;font-weight:400;color:#000;margin-top:3px;font-variant-numeric:tabular-nums">${fmt(roomTot[r])}</div>
    </div>` : '').join('');

  const sections = rooms.map(room => {
    const cards = grp[room].map(it => {
      const sum = Number(it.price) * it.qty;
      const imgBlock = it.img
        ? `<div style="height:160px;background:#f0ede9;overflow:hidden;border-radius:4px 4px 0 0;display:flex;align-items:center;justify-content:center"><img src="${esc(it.img)}" style="width:100%;height:100%;object-fit:contain" onerror="this.parentNode.innerHTML='<div style=height:160px;display:flex;align-items:center;justify-content:center;font-size:28px;color:#C8C1BE>&#9633;</div>'"></div>`
        : `<div style="height:160px;background:#f0ede9;border-radius:4px 4px 0 0;display:flex;align-items:center;justify-content:center;font-size:28px;color:#C8C1BE">&#9633;</div>`;
      const nameEl = it.url
        ? `<a href="${esc(it.url)}" target="_blank" style="color:#000;font-size:13px;font-weight:400;text-decoration:none;line-height:1.4">${esc(it.name)}</a>`
        : `<div style="color:#000;font-size:13px;font-weight:400;line-height:1.4">${esc(it.name)}</div>`;
      return `<div style="background:#fff;border:1px solid #ddd5d0;border-radius:4px;overflow:hidden;display:flex;flex-direction:column">
        ${it.url ? `<a href="${esc(it.url)}" target="_blank" style="display:block;text-decoration:none">${imgBlock}</a>` : imgBlock}
        <div style="padding:12px 14px;flex:1;display:flex;flex-direction:column;gap:4px">
          ${nameEl}
          ${it.size ? `<div style="color:#8e8e93;font-size:11px">${esc(it.size)}</div>` : ''}
          ${it.cmt ? `<div style="color:#8e8e93;font-size:11px;font-style:italic">${esc(it.cmt)}</div>` : ''}
          <div style="margin-top:auto;padding-top:10px;border-top:1px solid #f0ede9;display:flex;justify-content:space-between;align-items:baseline">
            <div style="font-size:11px;color:#8e8e93;font-weight:300">${it.qty} шт × ${it.price ? Number(it.price).toLocaleString('ru-RU') + ' ₽' : '—'}</div>
            <div style="font-size:14px;font-weight:500;color:#000;font-variant-numeric:tabular-nums">${it.price ? fmt(sum) : '—'}</div>
          </div>
        </div>
      </div>`;
    }).join('');
    return `<section style="margin-bottom:40px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;padding-bottom:8px;border-bottom:0.5px solid #000;margin-bottom:14px">
        <h2 style="font-size:20px;font-weight:500;color:#000">${esc(room)}</h2>
        ${roomTot[room] ? `<div style="font-size:12px;color:#8e8e93">${fmt(roomTot[room])}</div>` : ''}
      </div>
      <div class="cards-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">${cards}</div>
    </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(projectTitle)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fdfcfb;color:#000;font-weight:300;font-size:14px;line-height:1.6}
@media print{
  .no-print{display:none!important}
  .cards-grid{grid-template-columns:repeat(2,1fr)!important}
  header{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  .sum-row{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
  @page{margin:12mm;size:auto;marks:none}
}
@media(max-width:600px){
  .hdr-inner{flex-direction:column!important;align-items:flex-start!important;gap:12px!important}
  .hdr-right{width:100%!important;display:flex!important;justify-content:space-between!important;align-items:flex-end!important}
}
</style>
</head><body>
<header style="background:#7B2237">
  <div class="hdr-inner" style="max-width:1100px;margin:0 auto;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;gap:20px">
    <div style="display:flex;align-items:center;gap:14px">
      ${project.designer_logo
        ? `<img src="${project.designer_logo}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;border:1px solid rgba(255,255,255,0.2);flex-shrink:0" alt="logo">`
        : `<div style="width:40px;height:40px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:500;color:rgba(255,255,255,0.8);flex-shrink:0">ez</div>`}
      <div>
        <div style="font-size:14px;font-weight:500;color:#fff">${esc(project.designer_name)}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:2px">Дизайнер интерьеров</div>
      </div>
    </div>
    <div class="hdr-right" style="display:flex;align-items:center;gap:14px">
      <div style="text-align:right">
        <div style="font-size:16px;font-weight:500;color:#fff">${esc(projectTitle)}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);margin-top:2px">${date}</div>
      </div>
      <button onclick="doPrint()" class="no-print" style="background:none;color:#fff;border:1px solid rgba(255,255,255,0.55);border-radius:3px;padding:7px 14px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap">↓ PDF</button>
    </div>
  </div>
</header>
<div style="max-width:1100px;margin:0 auto;padding:28px 24px 64px">
  <div class="sum-row" style="display:flex;gap:1px;background:#ddd5d0;border:1px solid #ddd5d0;border-radius:4px;overflow:hidden;margin-bottom:36px;flex-wrap:wrap">
    ${summaryCards}
    <div style="background:#7B2237;padding:12px 16px;min-width:90px;flex:0 0 auto">
      <div style="font-size:9px;color:rgba(255,255,255,0.4)">Итого</div>
      <div style="font-size:15px;font-weight:400;color:#fff;margin-top:3px;font-variant-numeric:tabular-nums">${fmt(grand)}</div>
    </div>
  </div>
  ${sections}
  ${comment ? `<div style="margin-bottom:20px;font-size:12px;color:#8e8e93">${esc(comment)}</div>` : ''}
  <footer style="padding-top:20px;border-top:1px solid #ddd5d0">
    <div style="font-size:11px;color:#8e8e93;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      ${project.designer_phone ? `<span>${esc(project.designer_phone)}</span>` : ''}
      ${project.designer_phone && project.designer_email ? `<span>·</span>` : ''}
      ${project.designer_email ? `<span>${esc(project.designer_email)}</span>` : ''}
      ${project.designer_site ? `<span>·</span><a href="https://${esc(project.designer_site)}" target="_blank" style="color:#778D7F;text-decoration:none">${esc(project.designer_site)}</a>` : ''}
    </div>
  </footer>
</div>
<script>
function doPrint(){
  var t=document.title;
  document.title='${esc(project.name).replace(/'/g,"\\'")} Комплектация';
  var h=document.body.scrollHeight;
  var style=document.createElement('style');
  style.id='print-size-fix';
  style.textContent='@page{size:794px '+h+'px;margin:24px}';
  document.head.appendChild(style);
  window.print();
  setTimeout(function(){
    document.title=t;
    var el=document.getElementById('print-size-fix');
    if(el)el.remove();
  },1000);
}
if(new URLSearchParams(window.location.search).get('print')==='1'){
  window.addEventListener('load',function(){setTimeout(doPrint,800)});
}
</script>
</body></html>`;
}

// SPA fallback — всё кроме /api, /p/:slug, /admin, /invite/:token отдаём index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/p/') || req.path.startsWith('/admin') || req.path.startsWith('/invite/')) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`ezhome-spec running on port ${PORT}`));
}).catch(err => {
  console.error('DB init error:', err);
  process.exit(1);
});
