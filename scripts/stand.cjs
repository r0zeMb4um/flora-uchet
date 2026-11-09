// Локальный стенд для проверки интерфейса без телефона и без Google (ничего не отправляет наружу).
// Настоящая логика кассы (ядро + API) работает в памяти, страница получает подставной Telegram.
//   node scripts/stand.cjs            — насыщенные данные (каталог, смены, чеки, предзаказы, график)
//   node scripts/stand.cjs --clean    — чистый магазин: только владелица и два флориста (Анна, Мира)
// Открыть: http://localhost:8766/?as=1 (владелица), ?as=777 (Анна), ?as=778 (Мира). Данные живут, пока работает стенд.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const CLEAN = process.argv.includes('--clean');
global.Calc = require(path.join(ROOT, 'apps-script/core/calc.js'));
global.Ops = require(path.join(ROOT, 'apps-script/core/ops.js'));
global.Posting = require(path.join(ROOT, 'apps-script/core/posting.js'));
global.Summary = require(path.join(ROOT, 'apps-script/core/summary.js'));
global.Reports = require(path.join(ROOT, 'apps-script/bot/reports.js'));
const MiniApi = require(path.join(ROOT, 'apps-script/api/miniapp.js'));
const { memoryStore } = require(path.join(ROOT, 'tests/helpers/memory-store.js'));

let NOW = '2026-11-09T10:00:00+05:00';
const store = memoryStore();
store.seed('clients', [{ client_id: 'c1', name: 'Цветы у Айгуль', timezone: 'Asia/Almaty', admin_finance_access: true }]);
store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000, reminder_time: '22:00', cash_tolerance: 0, expense_items: 'Аренда,Интернет,Налоги' }]);
store.seed('staff', [
  { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
  { staff_id: 's_mira', client_id: 'c1', point_id: 'p1', telegram_id: '778', name: 'Мира', role: 'florist', shift_rate: 4000, pct_bp: 200, active: true },
  { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
]);

let n = 0;
const seedLog = [];
const op = () => 'op-seed-' + String(++n).padStart(7, '0');
const post = (tg, kind, payload) => {
  try { return MiniApi.dispatch(store, tg, { action: 'post', kind, op_id: op(), payload }, NOW).data.result; }
  catch (e) { seedLog.push('SEED-FAIL ' + kind + ': ' + (e.code || '') + ' ' + e.message); return null; }
};
const call = (tg, body) => MiniApi.dispatch(store, tg, body, NOW).data;

if (!CLEAN) {
// каталог
post(1, 'catalog_import', { groups: [
  { category: 'flowers', lines: [{ name: 'Роза красная 60', sale_price: 1200, qty: 50, cost: 650, min_stock: 20 }, { name: 'Хризантема', sale_price: 900, qty: 30, cost: 400, min_stock: 10 }, { name: 'Тюльпан', sale_price: 500, qty: 5, cost: 250, min_stock: 10 }] },
  { category: 'greens', lines: [{ name: 'Эвкалипт', sale_price: 400, qty: 40, cost: 200 }] },
  { category: 'packaging', lines: [{ name: 'Крафт', sale_price: 300, qty: 100, cost: 100 }] },
  { category: 'toys', lines: [{ name: 'Мишка', sale_price: 8000, qty: 3, cost: 4500 }] }
] });
const cat = call(1, { action: 'owner_catalog' });
const id = (name) => cat.find((c) => c.name === name).item_id;
post(1, 'catalog_import', { category: 'baskets', lines: [{ name: 'Корзина', sale_price: 5000 }] });
post(1, 'catalog_edit', { item_id: id('Эвкалипт'), status: 'hidden' });
post(1, 'owner_expense', { month: '2026-11', comment: 'ноябрь', lines: [{ item: 'Аренда', amount: 150000 }, { item: 'Интернет', amount: 8000 }] });
post(1, 'schedule_set', { date: '2026-11-10', staff_ids: ['s_anna'], note: '' });
post(1, 'schedule_set', { date: '2026-11-11', staff_ids: ['s_mira', 's_anna'], note: 'праздник' });
post(1, 'staff_add', { name: 'Новая Флорист', shift_rate: 3000, pct_bp: 100 });

// «вчерашняя» смена Анны и её закрытие
NOW = '2026-11-08T09:00:00+05:00';
post(777, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
post(777, 'sale', { items: [{ item_id: id('Роза красная 60'), qty: 5 }], price: 6000, payments: [{ method: 'cash', amount: 6000 }] });
post(777, 'sale', { items: [{ item_id: id('Мишка'), qty: 1 }], price: 8000, payments: [{ method: 'card', amount: 8000 }] });
const facts = {};
Ops.makeView(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW }).balance().forEach((b) => { facts[b.item_id] = b.qty; });
post(777, 'inventory', { facts });
post(777, 'close_shift', { counted: 6000, close_withdrawal: 0, expenses_confirmed: true });

// сегодняшняя смена Анны + Миры
NOW = '2026-11-09T10:00:00+05:00';
post(777, 'open_shift', { florist_ids: ['s_anna', 's_mira'], open_cash: 6000 });
const r1 = post(777, 'sale', { items: [{ item_id: id('Роза красная 60'), qty: 3 }, { item_id: id('Крафт'), qty: 1 }], price: 3900, payments: [{ method: 'cash', amount: 3900 }] });
post(777, 'sale', { items: [{ item_id: id('Хризантема'), qty: 2 }], price: 1800, payments: [{ method: 'cash', amount: 1000 }, { method: 'card', amount: 800 }] });
post(778, 'sale', { items: [{ item_id: id('Тюльпан'), qty: 2 }], price: 1000, discount: { kind: 'pct', value: 1000 }, payments: [{ method: 'card', amount: 900 }] });
post(777, 'sale', { items: [{ item_id: id('Роза красная 60'), qty: 2 }], price: 2400, payments: [{ method: 'cash', amount: 400 }], debt_customer: { new_customer: { name: 'Ерлан', note: 'сосед' } } });
post(777, 'bouquet', { items: [{ item_id: id('Роза красная 60'), qty: 5 }, { item_id: id('Хризантема'), qty: 3 }], price: 9000, payments: [{ method: 'card', amount: 9000 }] });
post(777, 'income', { lines: [{ item_id: id('Тюльпан'), qty: 20, cost_sum: 5000 }], supplier: 'Оптовик' });
post(777, 'defect', { lines: [{ item_id: id('Хризантема'), qty: 1, reason: 'wilted' }] });
post(777, 'cash_out', { type: 'delivery', amount: 1500, comment: 'такси' });
if (r1) post(777, 'refund', { receipt_id: r1.receipt_id, mode: 'money', method: 'cash', amount: 300 });
const res = post(777, 'reserve', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-12', price: 15000 });
post(777, 'reserve', { customer: { new_customer: { name: 'Гульмира' } }, pickup_date: '2026-11-13', price: 7000 });
if (res) {
  const pre = post(777, 'preorder', { reservation_id: res.reservation_id, payments: [{ method: 'card', amount: 5000 }] });
  if (pre) post(777, 'preorder_assemble', { receipt_id: pre.receipt_id, items: [{ item_id: id('Роза красная 60'), qty: 10 }] });
}
post(777, 'template_save', { name: 'Нежность', items: [{ item_id: id('Роза красная 60'), qty: 5 }, { item_id: id('Хризантема'), qty: 3 }], price: 9000 });

}
console.log(seedLog.length ? seedLog.join('\n') : 'seed OK');

const FAKE = (tid) => `<script>
(function () {
  var noop = function () {};
  var btn = { setText: noop, show: noop, hide: noop, enable: noop, disable: noop, onClick: function (f) { window.__mainFn = f; }, offClick: noop, showProgress: noop, hideProgress: noop, setParams: noop };
  var back = { show: noop, hide: noop, onClick: noop, offClick: noop };
  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function (e) { window.__errors.push('promise: ' + (e.reason && e.reason.message || e.reason)); });
  window.Telegram = { WebApp: { initData: 'tg:${tid}', initDataUnsafe: { user: { id: ${tid} } }, ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop,
    MainButton: btn, BackButton: back, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
    showConfirm: function (t, cb) { cb(true); }, openTelegramLink: noop, onEvent: noop, offEvent: noop, colorScheme: 'dark', themeParams: {} } };
  window.FLORA_API_URL = '/api';
})();
</script>`;

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let out;
      try {
        const data = JSON.parse(body);
        const tid = Number(String(data.initData).replace('tg:', ''));
        out = { ok: true, data: MiniApi.dispatch(store, tid, data, NOW).data };
      } catch (err) {
        out = { ok: false, error: { code: err.code || 'SERVER', message: err.message, details: err.details || null } };
        if (!err.code) console.log('SERVER ERROR', err.stack);
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out));
    });
    return;
  }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    let html = fs.readFileSync(path.join(ROOT, 'miniapp/index.html'), 'utf8');
    html = html.replace(/<script src="https:\/\/telegram\.org[^>]*><\/script>/, FAKE(u.searchParams.get('as') || '1')).replace('<script src="js/config.js"></script>', '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(html);
    return;
  }
  const f = path.join(ROOT, 'miniapp', u.pathname);
  if (!f.startsWith(path.join(ROOT, 'miniapp')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end('no'); return; }
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  let data = fs.readFileSync(f);
  if (u.pathname === '/js/app.js') {
    // только в стенде: открываем экраны для обхода
    data = data.toString('utf8').replace(/\n  load\(\);\n\}\)\(\);\s*$/, '\n  window.__t = { openScreen: openScreen, SCREENS: SCREENS, state: state, render: render, ownerUI: ownerUI };\n  load();\n})();\n');
  }
  res.end(data);
}).listen(8766, () => console.log('стенд №2 на http://localhost:8766'));
