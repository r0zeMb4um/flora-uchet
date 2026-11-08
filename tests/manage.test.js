// «Управление» владелицы: каталог в кассе (D29). Права, цены, скрытие, новая позиция.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
global.Summary = require('../apps-script/core/summary.js');
global.Reports = require('../apps-script/bot/reports.js');
const MiniApi = require('../apps-script/api/miniapp.js');
const { memoryStore } = require('./helpers/memory-store.js');

const NOW = '2026-11-08T10:00:00+05:00';

function shop() {
  const store = memoryStore();
  store.seed('clients', [{ client_id: 'c1', name: 'Цветы', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [
    { item_id: 'rose', client_id: 'c1', name: 'Роза', category: 'flowers', sale_price: 1200, last_cost: 650, min_stock: 20, status: 'active' },
    { item_id: 'old', client_id: 'c1', name: 'Гипсофила', category: 'greens', sale_price: 300, last_cost: 150, min_stock: 0, status: 'hidden' }
  ]);
  let n = 0;
  const op = () => 'op-mng-' + String(++n).padStart(7, '0');
  const call = (tg, body) => MiniApi.dispatch(store, tg, body, NOW).data;
  const post = (tg, kind, payload) => MiniApi.dispatch(store, tg, { action: 'post', kind, op_id: op(), payload }, NOW);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  const seedPost = (ctx, kind, payload) => Posting.post(store, ctx, { op_id: op(), kind, payload });
  return { store, call, post, owner, seedPost };
}

test('владелица видит весь каталог, включая скрытые; флористу этот раздел закрыт', () => {
  const { call } = shop();
  const list = call(1, { action: 'owner_catalog' });
  assert.deepEqual(list.map((x) => [x.name, x.status, x.price]).sort(), [['Гипсофила', 'hidden', 300], ['Роза', 'active', 1200]]);
  assert.throws(() => call(777, { action: 'owner_catalog' }), { code: 'FORBIDDEN' });
});

test('смена цены и минимума: действует на новые продажи, прежние чеки не меняются', () => {
  const { call, post, store, owner, seedPost } = shop();
  seedPost(owner, 'stock_start', { lines: [{ item_id: 'rose', qty: 50 }] });
  seedPost({ client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW }, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  post(777, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 1200 }] });
  post(1, 'catalog_edit', { item_id: 'rose', sale_price: 1500, min_stock: 30 });
  const rose = call(1, { action: 'owner_catalog' }).find((x) => x.item_id === 'rose');
  assert.equal(rose.price, 1500);
  assert.equal(rose.min, 30);
  assert.equal(store.tables.receipts[0].price, 1200, 'старый чек не изменился');
  assert.throws(() => post(777, 'catalog_edit', { item_id: 'rose', sale_price: 1 }), { code: 'FORBIDDEN' }, 'флорист цену каталога менять не может');
});

test('скрытая позиция пропадает из кассы флориста и возвращается обратно', () => {
  const { call, post } = shop();
  post(1, 'catalog_edit', { item_id: 'rose', status: 'hidden' });
  assert.ok(!call(777, { action: 'bootstrap' }).catalog.some((c) => c.item_id === 'rose'));
  post(1, 'catalog_edit', { item_id: 'rose', status: 'active' });
  assert.ok(call(777, { action: 'bootstrap' }).catalog.some((c) => c.item_id === 'rose'));
});

test('новая позиция владелицы: сразу активна, похожие — предупреждение, пустое имя и нулевая цена — отказ', () => {
  const { call, post } = shop();
  assert.throws(() => post(1, 'new_item', { name: 'Роза белая', category: 'flowers', sale_price: 1100 }), { code: 'SIMILAR_ITEMS' });
  const res = post(1, 'new_item', { name: 'Роза белая', category: 'flowers', sale_price: 1100, confirm_new: true });
  const item = call(1, { action: 'owner_catalog' }).find((x) => x.name === 'Роза белая');
  assert.equal(item.status, 'active');
  assert.equal(item.price, 1100);
  assert.ok(res.data.result.item_id);
  assert.throws(() => post(1, 'new_item', { name: 'Пион', category: 'flowers', sale_price: 0 }));
  assert.throws(() => post(1, 'new_item', { name: '  ', category: 'flowers', sale_price: 500 }));
});

// ---------- этап 2: сотрудники, расходы, настройки ----------

test('сотрудники: список, добавление со ссылкой-приглашением (токен делает сервер), доступ закрыт флористу', () => {
  const { call, post } = shop();
  assert.deepEqual(call(1, { action: 'owner_team' }).map((s) => [s.name, s.role, s.joined]), [['Айгуль', 'owner', true], ['Анна', 'florist', true]]);
  assert.throws(() => call(777, { action: 'owner_team' }), { code: 'FORBIDDEN' });
  const res = post(1, 'staff_add', { name: 'Мира', shift_rate: 5000, pct_bp: 250, invite_token: 'short' }); // присланный токен игнорируется
  const link = res.data.result.invite_link;
  assert.match(link, /^https:\/\/t\.me\/flora_uchet_bot\?start=[0-9a-f]{32}$/);
  const mira = call(1, { action: 'owner_team' }).find((s) => s.name === 'Мира');
  assert.equal(mira.joined, false);
  assert.equal(mira.invited, true);
  assert.equal(mira.pct_bp, 250);
  const again = post(1, 'staff_invite', { staff_id: mira.staff_id });
  assert.notEqual(again.data.result.invite_link, link, 'новая ссылка заменяет прежнюю');
  assert.throws(() => post(777, 'staff_add', { name: 'Х', shift_rate: 1, pct_bp: 1 }), { code: 'FORBIDDEN' });
});

test('правка флориста: ставка и процент — для будущих смен; открытая смена не меняется; процент > 100 — отказ', () => {
  const { call, post, store, seedPost } = shop();
  seedPost({ client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW }, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  post(1, 'staff_edit', { staff_id: 's_anna', shift_rate: 6000, pct_bp: 400, name: 'Анна К.' });
  const anna = call(1, { action: 'owner_team' }).find((s) => s.staff_id === 's_anna');
  assert.deepEqual([anna.name, anna.shift_rate, anna.pct_bp], ['Анна К.', 6000, 400]);
  const snap = store.tables.shift_staff.find((r) => r.staff_id === 's_anna');
  assert.deepEqual([snap.shift_rate, snap.pct_bp], [5000, 300], 'условия открытой смены записаны при открытии');
  assert.throws(() => post(1, 'staff_edit', { staff_id: 's_anna', pct_bp: 10001 }), { code: 'BAD_INPUT' });
  assert.throws(() => post(1, 'staff_edit', { staff_id: 's_anna' }), { code: 'BAD_INPUT' });
  assert.throws(() => post(777, 'staff_edit', { staff_id: 's_anna', shift_rate: 99999 }), { code: 'FORBIDDEN' });
});

test('отключение флориста: доступ пропадает сразу, возврат — обратно', () => {
  const { call, post } = shop();
  post(1, 'staff_set_active', { staff_id: 's_anna', active: false });
  assert.throws(() => call(777, { action: 'bootstrap' }), { code: 'FORBIDDEN' });
  post(1, 'staff_set_active', { staff_id: 's_anna', active: true });
  assert.ok(call(777, { action: 'bootstrap' }).catalog);
});

test('расходы месяца: список, итог, исправление минусом, неверный месяц → текущий; настройки точки', () => {
  const { call, post } = shop();
  post(1, 'owner_expense', { month: '2026-11', item: 'Аренда', amount: 150000, comment: 'ноябрь' });
  post(1, 'owner_expense', { month: '2026-11', item: 'Аренда', amount: -10000, comment: 'исправление' });
  post(1, 'owner_expense', { month: '2026-10', item: 'Налоги', amount: 20000 });
  const nov = call(1, { action: 'owner_expenses', month: '2026-11' });
  assert.equal(nov.total, 140000);
  assert.equal(nov.items.length, 2);
  assert.equal(call(1, { action: 'owner_expenses', month: '2026-10' }).total, 20000);
  assert.equal(call(1, { action: 'owner_expenses', month: 'мусор' }).month, '2026-11');
  assert.throws(() => post(1, 'owner_expense', { month: '2026-11', item: 'Х', amount: 0 }), { code: 'BAD_INPUT' });
  assert.throws(() => post(777, 'owner_expense', { month: '2026-11', item: 'Х', amount: 5 }), { code: 'FORBIDDEN' });
  post(1, 'settings_edit', { change_fund: 7000, reminder_time: '21:30', expense_items: 'Аренда, Налоги' });
  const st = call(1, { action: 'owner_settings' });
  assert.deepEqual([st.change_fund, st.reminder_time, st.expense_items], [7000, '21:30', 'Аренда;Налоги']);
  assert.throws(() => post(1, 'settings_edit', { reminder_time: '25:99' }), { code: 'BAD_INPUT' });
  assert.throws(() => call(777, { action: 'owner_settings' }), { code: 'FORBIDDEN' });
});

// ---------- этап 3: «Ещё» флориста — расход, изъятие, погашение долга, отмена продажи ----------

function openedShop() {
  const s = shop();
  s.seedPost(s.owner, 'stock_start', { lines: [{ item_id: 'rose', qty: 50 }] });
  s.seedPost({ client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW }, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  return s;
}

test('флорист из кассы: расход, изъятие (владелице уведомление) — проходят; владелица этих операций не делает', () => {
  const { post } = openedShop();
  assert.ok(post(777, 'cash_out', { type: 'delivery', amount: 700, comment: 'такси' }));
  const w = post(777, 'withdrawal', { amount: 5000 });
  assert.ok(w.notify.some((n) => n.kind === 'withdrawal' && n.amount === 5000));
  assert.throws(() => post(777, 'cash_out', { type: 'rent', amount: 100 }), { code: 'BAD_INPUT' }, 'аренды в смене нет (D11)');
  assert.throws(() => post(1, 'cash_out', { type: 'other', amount: 100 }), { code: 'FORBIDDEN' });
});

test('погашение долга флористом: не больше долга, касса и долг меняются', () => {
  const { call, post } = openedShop();
  post(777, 'sale', { items: [{ item_id: 'rose', qty: 2 }], price: 2400, payments: [{ method: 'cash', amount: 400 }], debt_customer: { new_customer: { name: 'Иванов', confirm_new: true } } });
  const ivan = call(777, { action: 'bootstrap' }).customers.find((c) => c.name === 'Иванов');
  assert.equal(ivan.debt, 2000);
  assert.throws(() => post(777, 'debt_repay', { customer_id: ivan.customer_id, method: 'cash', amount: 2001 }));
  post(777, 'debt_repay', { customer_id: ivan.customer_id, method: 'card', amount: 1500 });
  assert.equal(call(777, { action: 'bootstrap' }).customers.find((c) => c.name === 'Иванов').debt, 500);
});

test('отмена продажи флористом: в списке «можно отменить» только чек текущей смены без возвратов; товар возвращается', () => {
  const { call, post } = openedShop();
  const a = post(777, 'sale', { items: [{ item_id: 'rose', qty: 3 }], price: 3600, payments: [{ method: 'cash', amount: 3600 }] });
  const b = post(777, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 1200 }] });
  post(777, 'refund', { receipt_id: b.data.result.receipt_id, mode: 'money', amount: 200, method: 'cash' });
  const list = call(777, { action: 'receipts', days: 2 });
  assert.equal(list.find((r) => r.receipt_id === a.data.result.receipt_id).cancellable, true);
  assert.equal(list.find((r) => r.receipt_id === b.data.result.receipt_id).cancellable, false, 'после возврата отмена невозможна');
  assert.throws(() => post(777, 'cancel', { receipt_id: b.data.result.receipt_id, reason: 'ошибка' }), { code: 'HAS_REFUNDS' });
  const c = post(777, 'cancel', { receipt_id: a.data.result.receipt_id, reason: 'ошибся с позицией' });
  assert.ok(c.notify.some((n) => n.kind === 'cancel'));
  assert.equal(call(777, { action: 'bootstrap' }).catalog.find((x) => x.item_id === 'rose').stock, 49); // 50 − 1 (чек b)
  assert.throws(() => post(777, 'cancel', { receipt_id: a.data.result.receipt_id, reason: 'ещё раз' }), { code: 'UNKNOWN_RECEIPT' });
});

// ---------- этап 4: открытие смены и отмена предзаказа — в кассе ----------

test('открытие смены в кассе: открытая информация (остаток прошлой смены, напарники), своё место подставляет сервер, расхождение — владелице', () => {
  const { call, post, store } = shop();
  store.seed('staff', [{ staff_id: 's_mira', client_id: 'c1', point_id: 'p1', telegram_id: '888', name: 'Мира', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true }]);
  const info = call(777, { action: 'bootstrap' }).open_info;
  assert.deepEqual(info, { prev_cash: 0, partners: [{ staff_id: 's_mira', name: 'Мира' }] });
  assert.equal(call(1, { action: 'bootstrap' }).open_info, null, 'владелица смену не открывает');
  assert.throws(() => post(1, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 }), { code: 'FORBIDDEN' });
  const res = post(777, 'open_shift', { florist_ids: ['', 's_mira'], open_cash: 300 });
  assert.equal(res.data.result.shift_no, 1);
  assert.equal(res.data.result.open_diff, 300);
  assert.ok(res.notify.some((n) => n.kind === 'open_diff'));
  assert.deepEqual(store.tables.shift_staff.map((r) => r.staff_id).sort(), ['s_anna', 's_mira']);
  assert.equal(call(777, { action: 'bootstrap' }).open_info, null, 'смена открыта — подсказка не нужна');
  assert.throws(() => post(777, 'open_shift', { florist_ids: [''], open_cash: 0 }), { code: 'SHIFT_ALREADY_OPEN' });
});

test('предзаказ: владелица отменяет в кассе — аванс возвращается, собранный букет возвращается на склад; флорист не может', () => {
  const { call, post, store, owner, seedPost } = shop();
  seedPost(owner, 'stock_start', { lines: [{ item_id: 'rose', qty: 50 }] });
  post(777, 'open_shift', { florist_ids: [''], open_cash: 0 });
  const pre = post(777, 'preorder', { customer: { new_customer: { name: 'Дана', confirm_new: true } }, pickup_date: '2026-11-09', price: 6000, payments: [{ method: 'cash', amount: 2000 }] });
  const id = pre.data.result.receipt_id;
  post(777, 'preorder_assemble', { receipt_id: id, items: [{ item_id: 'rose', qty: 4 }] });
  assert.equal(call(777, { action: 'bootstrap' }).catalog.find((c) => c.item_id === 'rose').stock, 46);
  assert.throws(() => post(777, 'preorder_cancel', { receipt_id: id, reason: 'х' }), { code: 'FORBIDDEN' });
  const p = call(1, { action: 'bootstrap' }).preorders[0];
  assert.deepEqual([p.customer, p.paid, p.assembly_status], ['Дана', 2000, 'assembled']);
  post(1, 'preorder_cancel', { receipt_id: id, reason: 'клиент передумал', refund: { method: 'cash', amount: 2000 }, return_stock: true });
  assert.equal(call(777, { action: 'bootstrap' }).catalog.find((c) => c.item_id === 'rose').stock, 50);
  assert.equal(call(1, { action: 'bootstrap' }).preorders.length, 0);
  assert.equal(store.tables.receipts.find((r) => r.receipt_id === id).assembly_status, 'cancelled');
});
