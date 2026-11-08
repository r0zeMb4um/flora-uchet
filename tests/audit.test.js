// Находки полного аудита: пределы чисел, формулы в выгрузке, журнал операций без лишних килобайт.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
global.Summary = require('../apps-script/core/summary.js');
global.Reports = require('../apps-script/bot/reports.js');
const { memoryStore } = require('./helpers/memory-store.js');

const NOW = '2026-11-08T10:00:00+05:00';

function shop() {
  const store = memoryStore();
  store.seed('clients', [{ client_id: 'c1', name: 'Цветы', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: '=СУММ(1;1)', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [{ item_id: 'rose', client_id: 'c1', name: '+Роза', category: 'flowers', sale_price: 1200, last_cost: 650, min_stock: 20, status: 'active' }]);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  const anna = { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW };
  let n = 0;
  const post = (ctx, kind, payload) => Posting.post(store, ctx, { op_id: 'op-aud-' + String(++n).padStart(7, '0'), kind, payload });
  post(owner, 'stock_start', { lines: [{ item_id: 'rose', qty: 100 }] });
  post(anna, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  return { store, owner, anna, post };
}

test('числа с опечаткой в 12 цифр отклоняются, а не ломают закрытие смены', () => {
  const { anna, post } = shop();
  const huge = 123456789012;
  assert.throws(() => post(anna, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: huge, payments: [{ method: 'cash', amount: huge }] }), { code: 'BAD_INPUT' });
  assert.throws(() => post(anna, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1200, discount: { kind: 'amount', value: huge }, payments: [{ method: 'cash', amount: 1 }] }), { code: 'BAD_INPUT' });
  assert.throws(() => post(anna, 'cash_out', { type: 'other', amount: huge }), { code: 'BAD_INPUT' });
  assert.throws(() => post(anna, 'income', { lines: [{ item_id: 'rose', qty: huge, cost_sum: 1 }], supplier: 'x' }), { code: 'BAD_INPUT' });
  post(anna, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 999999999, payments: [{ method: 'cash', amount: 999999999 }] }); // предел включительно
});

test('выгрузка: текст, похожий на формулу (= + - @), не становится формулой', () => {
  const { anna, post, store, owner } = shop();
  post(anna, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 200 }], debt_customer: { new_customer: { name: '=HYPERLINK("http://x")', note: '@cmd', confirm_new: true } } });
  const tables = Summary.exportTables(Ops.makeView(store, owner), '2026-11-01', '2026-11-30');
  const all = tables.flatMap((t) => t.rows.flat()).filter((c) => typeof c === 'string');
  assert.ok(all.every((c) => !/^[=+\-@]/.test(c)), 'ячейка начинается с формульного знака: ' + all.find((c) => /^[=+\-@]/.test(c)));
  assert.ok(all.includes("'=HYPERLINK(\"http://x\")"));
  assert.ok(all.includes("'+Роза"));
  assert.equal(Summary.safeCell(5), 5, 'числа не трогаем');
  assert.equal(Summary.safeCell('Анна'), 'Анна');
  assert.ok(Summary.toCsv(tables.find((t) => t.name === 'Остатки').rows).includes("'+Роза"));
});

test('журнал операций: у проведённой операции план очищен, у зависшей — сохранён для дописывания', () => {
  const { store, anna, post } = shop();
  post(anna, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 1200 }] });
  const done = store.rows('ops_log').filter((o) => o.status === 'posted' && o.kind === 'sale');
  assert.equal(done.length, 1);
  assert.equal(done[0].plan_json, '');
  assert.ok(done[0].result_json.includes('total'));
  assert.throws(() => Posting.post(store, anna, { op_id: 'op-crash-0000001', kind: 'sale', payload: { items: [{ item_id: 'rose', qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 1200 }] } },
    { step: (name) => { if (name === 'facts:receipts') throw new Error('обрыв'); } }));
  const pending = store.rows('ops_log').find((o) => o.op_id === 'op-crash-0000001');
  assert.equal(pending.status, 'pending');
  assert.ok(pending.plan_json.length > 50);
  const again = Posting.post(store, anna, { op_id: 'op-crash-0000001', kind: 'sale', payload: {} });
  assert.equal(again.status, 'posted');
  assert.equal(store.rows('ops_log').find((o) => o.op_id === 'op-crash-0000001').plan_json, '');
});

test('дата выдачи: настоящая дата календаря, не в прошлом, не дальше чем через год', () => {
  const { anna, post } = shop();
  const pre = (date) => post(anna, 'preorder', { customer: { new_customer: { name: 'Д' + date, confirm_new: true } }, pickup_date: date, price: 3000, payments: [{ method: 'cash', amount: 1000 }] });
  assert.throws(() => pre('2026-13-45'), { code: 'BAD_INPUT' });
  assert.throws(() => pre('2026-02-31'), { code: 'BAD_INPUT' });
  assert.throws(() => pre('2020-01-01'), { code: 'BAD_INPUT' });
  assert.throws(() => pre('2099-01-01'), { code: 'BAD_INPUT' });
  assert.ok(pre('2026-11-08')); // сегодня
  assert.ok(pre('2027-11-08')); // ровно через год
  assert.throws(() => post(anna, 'reserve', { customer: { new_customer: { name: 'Б' } }, pickup_date: '2020-01-01', price: 1000 }), { code: 'BAD_INPUT' });
});
