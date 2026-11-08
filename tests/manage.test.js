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
