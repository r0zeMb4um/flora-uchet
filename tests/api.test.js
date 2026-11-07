// API Mini App: проверка подписи Telegram (initData) и ответы для экранов.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
global.Summary = require('../apps-script/core/summary.js');
global.Reports = require('../apps-script/bot/reports.js');
const Auth = require('../apps-script/api/auth.js');
const MiniApi = require('../apps-script/api/miniapp.js');
const { memoryStore } = require('./helpers/memory-store.js');

const TOKEN = '123456:TEST-token-not-real';
const raw = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
const hex = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');

/** initData, как его подписывает Telegram. */
function signedInitData(fields, token = TOKEN) {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = raw('WebAppData', token);
  const hash = hex(secret, dcs);
  return new URLSearchParams({ ...fields, hash }).toString();
}
const NOW = 1_800_000_000;
const user = JSON.stringify({ id: 777, first_name: 'Анна', username: 'anna_flowers' });
const verify = (s, now = NOW, token = TOKEN) => Auth.verify(s, token, now, raw, hex);

test('initData: верная подпись принимается, кириллица и спецсимволы не мешают', () => {
  const s = signedInitData({ user, auth_date: String(NOW - 60), query_id: 'AAE&x=1', signature: 'abc' });
  const r = verify(s);
  assert.equal(r.user.id, 777);
  assert.equal(r.user.first_name, 'Анна');
});

test('initData: подделка, чужой токен, устаревший вход, пустые данные — отказ', () => {
  const good = signedInitData({ user, auth_date: String(NOW - 60) });
  const forged = good.replace(encodeURIComponent('"id":777'), encodeURIComponent('"id":778'));
  assert.notEqual(forged, good);
  assert.throws(() => verify(forged), { code: 'AUTH' });
  assert.throws(() => verify(good, NOW, '999:other-bot'), { code: 'AUTH' });
  assert.throws(() => verify(signedInitData({ user, auth_date: String(NOW - 12 * 3600 - 1) })), { code: 'AUTH' });
  assert.equal(verify(signedInitData({ user, auth_date: String(NOW - 12 * 3600) })).user.id, 777);
  assert.throws(() => verify(''), { code: 'AUTH' });
  assert.throws(() => verify(signedInitData({ auth_date: String(NOW) })), { code: 'AUTH' });
});

// ---------- dispatch ----------

function shop() {
  const store = memoryStore();
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Владелица', role: 'owner', shift_rate: 0, pct_bp: 0, active: true },
    { staff_id: 's_gone', client_id: 'c1', point_id: 'p1', telegram_id: '555', name: 'Ушла', role: 'florist', shift_rate: 1, pct_bp: 1, active: false }
  ]);
  store.seed('catalog', [
    { item_id: 'rose', client_id: 'c1', name: 'Роза', category: 'flowers', sale_price: 1200, last_cost: 650, min_stock: 20, status: 'active' },
    { item_id: 'old', client_id: 'c1', name: 'Скрытая', category: 'flowers', sale_price: 1, last_cost: 1, min_stock: 0, status: 'hidden' }
  ]);
  const now = '2026-11-07T10:00:00+05:00';
  Posting.post(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now }, { op_id: 'start-0001', kind: 'stock_start', payload: { lines: [{ item_id: 'rose', qty: 40 }] } });
  Posting.post(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now }, { op_id: 'open-00001', kind: 'open_shift', payload: { florist_ids: ['s_anna'], open_cash: 15000 } });
  return { store, now };
}

test('bootstrap: смена, мой заработок и каталог с остатками; расчётной кассы в ответе нет', () => {
  const { store, now } = shop();
  const { data } = MiniApi.dispatch(store, 777, { action: 'bootstrap' }, now);
  assert.equal(data.me.name, 'Анна');
  assert.equal(data.shift.shift_no, 1);
  assert.deepEqual(data.shift.my_pay, { rate: 5000, pct: 0, total: 5000 });
  assert.deepEqual(data.catalog.map((c) => [c.item_id, c.stock]), [['rose', 40]]);
  const text = JSON.stringify(data);
  for (const secret of ['calc_cash', 'open_cash', 'counted', 'next_cash', '15000']) {
    assert.ok(!text.includes(secret), 'в ответе флористу не должно быть: ' + secret);
  }
});

test('post: продажа проводится, повтор с тем же op_id — «уже проведено», остаток и заработок обновлены', () => {
  const { store, now } = shop();
  const body = {
    action: 'post', kind: 'sale', op_id: '6f1c2a40-0000-4000-8000-000000000001',
    payload: { items: [{ item_id: 'rose', qty: 5 }], price: 6000, discount: { kind: 'pct', value: 1000 }, payments: [{ method: 'card', amount: 5400 }] }
  };
  const a = MiniApi.dispatch(store, 777, body, now);
  assert.equal(a.data.status, 'posted');
  assert.equal(a.data.result.total, 5400);
  assert.equal(a.data.state.catalog[0].stock, 35);
  assert.equal(a.data.state.shift.revenue, 5400);
  assert.equal(a.data.state.shift.my_pay.pct, 162);
  const b = MiniApi.dispatch(store, 777, body, now);
  assert.equal(b.data.status, 'already');
  assert.equal(b.data.state.catalog[0].stock, 35);
});

test('доступ: незнакомый, отключённый, владелица в кассе, чужая операция — отказ', () => {
  const { store, now } = shop();
  assert.throws(() => MiniApi.dispatch(store, 999, { action: 'bootstrap' }, now), { code: 'FORBIDDEN' });
  assert.throws(() => MiniApi.dispatch(store, 555, { action: 'bootstrap' }, now), { code: 'FORBIDDEN' });
  assert.throws(() => MiniApi.dispatch(store, 1, { action: 'post', kind: 'sale', op_id: 'x'.repeat(10), payload: {} }, now), { code: 'FORBIDDEN' });
  assert.throws(() => MiniApi.dispatch(store, 777, { action: 'post', kind: 'debt_opening', op_id: 'x'.repeat(10), payload: {} }, now), { code: 'FORBIDDEN' });
  assert.throws(() => MiniApi.dispatch(store, 777, { action: 'drop_tables' }, now), { code: 'BAD_ACTION' });
});

test('клиент и точка берутся из таблицы, а не из запроса', () => {
  const { store, now } = shop();
  const body = {
    action: 'post', kind: 'sale', op_id: '6f1c2a40-0000-4000-8000-000000000002', client_id: 'c2', point_id: 'p9',
    payload: { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 1200 }], client_id: 'c2' }
  };
  MiniApi.dispatch(store, 777, body, now);
  const r = store.tables.receipts[0];
  assert.equal(r.client_id, 'c1');
  assert.equal(r.point_id, 'p1');
});

test('формулы в Mini App — тот же файл, что на сервере (иначе «Итого» на телефоне и в отчёте разойдутся)', () => {
  const fs = require('node:fs');
  const a = fs.readFileSync(require.resolve('../apps-script/core/calc.js'), 'utf8');
  const b = fs.readFileSync(require.resolve('../miniapp/js/calc.js'), 'utf8');
  assert.equal(b, a, 'скопируйте apps-script/core/calc.js в miniapp/js/calc.js (это делает npm run deploy)');
});

test('закрытие через кассу: инвентаризация → пересчёт вслепую → предпросмотр → закрытие', () => {
  const { store, now } = shop();
  const post = (kind, payload, op) => MiniApi.dispatch(store, 777, { action: 'post', kind, op_id: op, payload }, now);
  post('sale', { items: [{ item_id: 'rose', qty: 5 }], price: 6000, payments: [{ method: 'cash', amount: 6000 }] }, 'op-sale-000001');
  post('cash_out', { type: 'delivery', amount: 500 }, 'op-cash-000001');

  // До инвентаризации закрыть нельзя, предпросмотр тоже.
  assert.throws(() => MiniApi.dispatch(store, 777, { action: 'close_preview', counted: 20500 }, now), { code: 'INVENTORY_REQUIRED' });
  const st = MiniApi.dispatch(store, 777, { action: 'bootstrap' }, now).data;
  assert.equal(st.shift.inventory_done, false);
  assert.deepEqual(st.shift.expenses, { delivery: 500, other: 0, withdrawal: 0, pay_adjust: 0 });
  post('inventory', { facts: { rose: 35 } }, 'op-inv-0000001');
  assert.equal(MiniApi.dispatch(store, 777, { action: 'bootstrap' }, now).data.shift.inventory_done, true);

  // Пересчёт: 20 450 при расчёте 15 000 + 6 000 − 500 = 20 500 → недостача 50.
  const pv = MiniApi.dispatch(store, 777, { action: 'close_preview', counted: 20450 }, now).data;
  assert.equal(pv.cash_diff, -50);
  assert.deepEqual(pv.payroll, [{ name: 'Анна', due: 5180, paid: 5180, unpaid: 0 }]);
  assert.equal(pv.can_take_above_change_fund, 20450 - 5180 - 5000);
  assert.equal(pv.max_withdrawal, 20450 - 5180);
  assert.equal(store.tables.shifts[0].status, 'open', 'предпросмотр ничего не пишет');
  assert.ok(!('calc_cash' in pv), 'расчётная сумма напрямую не отдаётся');

  const done = post('close_shift', { counted: 20450, close_withdrawal: 10000, expenses_confirmed: true }, 'op-close-00001');
  assert.equal(done.data.result.next_cash, 20450 - 5180 - 10000);
  assert.equal(done.data.state.shift, null);
  assert.deepEqual(done.notify.map((n) => n.kind), ['shift_report']);
  // Повтор нажатия «Закрыть» — уже проведено, второй раз не закрывается.
  assert.equal(post('close_shift', { counted: 20450, close_withdrawal: 10000, expenses_confirmed: true }, 'op-close-00001').data.status, 'already');
});

test('касса: долг, предзаказы, брони, приход с новой позицией, брак, возврат по недавнему чеку', () => {
  const { store, now } = shop();
  let n = 0;
  const post = (kind, payload) => MiniApi.dispatch(store, 777, { action: 'post', kind, op_id: 'op-part3-' + String(++n).padStart(4, '0'), payload }, now);
  post('sale', { items: [{ item_id: 'rose', qty: 2 }], price: 2400, payments: [{ method: 'cash', amount: 400 }], debt_customer: { new_customer: { name: 'Айгуль', note: 'сосед' } } });
  post('preorder', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-09', price: 10000, payments: [{ method: 'card', amount: 3000 }] });
  post('reserve', { customer: { new_customer: { name: 'Бек' } }, pickup_date: '2026-11-10', price: 5000 });
  const st = MiniApi.dispatch(store, 777, { action: 'bootstrap' }, now).data;
  assert.deepEqual(st.customers.map((c) => [c.name, c.debt]), [['Айгуль', 2000], ['Бек', 0], ['Дана', 0]]);
  assert.deepEqual(st.preorders.map((p) => [p.customer, p.total, p.paid, p.unpaid, p.assembly_status]), [['Дана', 10000, 3000, 7000, 'waiting']]);
  assert.deepEqual(st.reservations.map((r) => [r.customer, r.total]), [['Бек', 5000]]);

  assert.throws(() => post('new_item', { category: 'flowers', name: 'Роза белая', sale_price: 1300 }), { code: 'SIMILAR_ITEMS' });
  const item = post('new_item', { category: 'flowers', name: 'Роза белая', sale_price: 1300, confirm_new: true }).data.result.item_id;
  post('income', { lines: [{ item_id: item, qty: 20, cost_sum: 14000 }, { item_id: 'rose', qty: 10, cost_sum: 6500 }], supplier: 'Флора-опт' });
  post('defect', { lines: [{ item_id: item, qty: 1, reason: 'broken' }] });
  const after = MiniApi.dispatch(store, 777, { action: 'bootstrap' }, now).data.catalog;
  assert.deepEqual(after.map((c) => [c.item_id === item ? 'new' : c.item_id, c.stock, c.review]), [['rose', 48, false], ['new', 19, true]]);

  const recent = MiniApi.dispatch(store, 777, { action: 'receipts' }, now).data;
  const debtSale = recent.find((r) => r.total === 2400);
  assert.equal(debtSale.refundable, 400, 'вернуть можно только реально оплаченное');
  post('refund', { receipt_id: debtSale.receipt_id, mode: 'money', method: 'cash', amount: 400 });
  assert.equal(MiniApi.dispatch(store, 777, { action: 'receipts' }, now).data.find((r) => r.total === 2400).refundable, 0);
});

// ---------- экраны владелицы ----------

test('владелица в кассе: сегодня (с расчётом кассы), история, смена с чеками, исправление, сводка, должники, обезличивание', () => {
  const { store, now } = shop();
  let n = 0;
  const anna = (kind, payload) => MiniApi.dispatch(store, 777, { action: 'post', kind, op_id: 'op-own-' + String(++n).padStart(5, '0'), payload }, now);
  const owner = (body) => MiniApi.dispatch(store, 1, body, now);
  anna('sale', { items: [{ item_id: 'rose', qty: 5 }], price: 6000, payments: [{ method: 'cash', amount: 6000 }] });
  anna('sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [], debt_customer: { new_customer: { name: 'Айгуль' } } });

  const today = owner({ action: 'owner_today' }).data;
  assert.equal(today.shift.revenue, 7200);
  assert.equal(today.shift.calc_cash, 21000, 'владелице расчёт кассы виден');
  assert.ok(Array.isArray(today.below_min));

  anna('inventory', { facts: { rose: 34 } });
  anna('close_shift', { counted: 21000, expenses_confirmed: true });
  const list = owner({ action: 'owner_shifts' }).data;
  assert.deepEqual(list.map((s) => [s.shift_no, s.status, s.revenue, s.receipts, s.cash_diff]), [[1, 'closed', 7200, 2, 0]]);
  const detail = owner({ action: 'owner_shift', shift_id: list[0].shift_id }).data;
  assert.deepEqual(detail.receipts.map((r) => [r.receipt_no, r.total, r.cash, r.debt]), [[1, 6000, 6000, 0], [2, 1200, 0, 1200]]);
  assert.match(detail.text, /ВЫРУЧКА: 7 200/);

  // Исправление: второй чек снят — выручка 6 000, долг Айгуль 0, отмечено «исправлено».
  const fix = owner({ action: 'post', kind: 'correction', op_id: 'op-fix-000001', payload: { receipt_id: detail.receipts[1].receipt_id, reason: 'ошибка' } });
  assert.deepEqual(fix.notify.map((x) => x.kind), ['shift_report']);
  const after = owner({ action: 'owner_shifts' }).data[0];
  assert.deepEqual([after.revenue, after.corrected], [6000, true]);

  const period = owner({ action: 'owner_period', from: '2026-11-01', to: '2026-11-07' }).data;
  assert.equal(period.summary.revenue, 6000);
  assert.equal(period.days.length, 7);
  assert.equal(period.days.find((d) => d.date === '2026-11-07').revenue, 6000);

  const cust = owner({ action: 'owner_customers' }).data;
  assert.deepEqual(cust.map((c) => [c.name, c.debt]), [['Айгуль', 0]]);
  owner({ action: 'post', kind: 'anonymize', op_id: 'op-anon-00001', payload: { customer_id: cust[0].customer_id } });
  assert.deepEqual(owner({ action: 'owner_customers' }).data, []);
});

test('флорист не может открыть разделы владелицы и её операции; владелица — операции флориста', () => {
  const { store, now } = shop();
  for (const action of ['owner_today', 'owner_shifts', 'owner_period', 'owner_customers']) {
    assert.throws(() => MiniApi.dispatch(store, 777, { action }, now), { code: 'FORBIDDEN' }, action);
  }
  assert.throws(() => MiniApi.dispatch(store, 777, { action: 'post', kind: 'correction', op_id: 'x'.repeat(10), payload: {} }, now), { code: 'FORBIDDEN' });
  assert.throws(() => MiniApi.dispatch(store, 1, { action: 'post', kind: 'sale', op_id: 'y'.repeat(10), payload: {} }, now), { code: 'FORBIDDEN' });
  assert.throws(() => MiniApi.dispatch(store, 1, { action: 'owner_period', from: 'вчера', to: 'сегодня' }, now), { code: 'BAD_INPUT' });
});
