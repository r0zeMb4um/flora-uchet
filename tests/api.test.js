// API Mini App: проверка подписи Telegram (initData) и ответы для экранов.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
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
