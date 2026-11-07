// Сценарии кнопок чата: расход, «Владелица забрала», погашение долга, отмена продажи, передача смены.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Posting = require('../apps-script/core/posting.js');
const Ops = require('../apps-script/core/ops.js');
const ChatFlows = require('../apps-script/bot/flows.js');
const { memoryStore } = require('./helpers/memory-store.js');

const NOW = '2026-11-08T10:00:00+05:00';

function shop() {
  const store = memoryStore();
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_mira', client_id: 'c1', point_id: 'p1', name: 'Мира', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', name: 'Владелица', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [{ item_id: 'bear', client_id: 'c1', name: 'Мишка', category: 'toys', sale_price: 4500, last_cost: 2500, min_stock: 1, status: 'active' }]);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  const anna = { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW, tg: '777' };
  Posting.post(store, owner, { op_id: 'start-00001', kind: 'stock_start', payload: { lines: [{ item_id: 'bear', qty: 5 }] } });
  Posting.post(store, owner, { op_id: 'debt-000001', kind: 'debt_opening', payload: { customer: { new_customer: { name: 'Ерлан', note: 'сосед' } }, amount: 3000, since_date: '2026-10-01' } });
  Posting.post(store, anna, { op_id: 'open-000001', kind: 'open_shift', payload: { florist_ids: ['s_anna'], open_cash: 15000 } });
  return { store, anna };
}

/** Имитация чата: что бот отправил и состояние сценария. */
function chat(store, ctx) {
  let st = null;
  let upd = 1000;
  const sent = [];
  const notified = [];
  const deps = {
    store, miniAppUrl: 'https://example.test/kassa/',
    send: (text, rows) => { sent.push({ text, rows: rows || [] }); },
    state: { get: () => (st ? JSON.parse(JSON.stringify(st)) : null), set: (v) => { st = JSON.parse(JSON.stringify(v)); }, clear: () => { st = null; } },
    notify: (list) => notified.push(...list)
  };
  const say = (text) => ChatFlows.handle(ctx, { text, data: '', update_id: ++upd }, deps);
  const press = (data) => ChatFlows.handle(ctx, { text: '', data, update_id: ++upd }, deps);
  const last = () => sent[sent.length - 1];
  const buttons = () => last().rows.flat().map((b) => b.callback_data || b.web_app && b.web_app.url);
  return { say, press, last, buttons, sent, notified, state: () => st };
}
const view = (store) => Ops.makeView(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW });
const cashOf = (store) => Ops.shiftReport(view(store), view(store).openShift().shift_id).calc_cash;

test('расход: тип → сумма → комментарий → «Проверьте» → проведено; до подтверждения ничего не пишется', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Расход');
  assert.deepEqual(c.buttons(), ['f:t:delivery', 'f:t:other', 'f:x']);
  c.press('f:t:delivery');
  c.say('две с половиной');
  assert.match(c.last().text, /цифрами/);
  c.say('2 500');
  c.say('Курьер до ТЦ');
  assert.match(c.last().text, /Проверьте и подтвердите/);
  assert.match(c.last().text, /Доставка из кассы: <b>2 500 ₸<\/b>/);
  assert.equal(cashOf(store), 15000, 'до подтверждения касса не изменилась');
  c.press('f:ok');
  assert.match(c.last().text, /^✅ Проведено/);
  assert.equal(cashOf(store), 12500);
  // Повторное нажатие «Провести» — ничего.
  c.press('f:ok');
  assert.match(c.last().text, /уже не действует/);
  assert.equal(cashOf(store), 12500);
  assert.equal(store.tables.cash_ops.length, 1);
});

test('расход без комментария и отмена сценария на любом шаге', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Расход'); c.press('f:t:other'); c.say('700'); c.press('f:nc'); c.press('f:ok');
  assert.equal(cashOf(store), 14300);
  c.say('Расход'); c.press('f:t:other'); c.say('900'); c.press('f:x');
  assert.match(c.last().text, /Отменено/);
  c.press('f:ok');
  assert.equal(cashOf(store), 14300);
  c.say('Владелица забрала'); c.say('Отмена');
  assert.equal(c.state(), null);
});

test('владелица забрала: уведомление владелице, касса уменьшилась', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Владелица забрала'); c.say('10000');
  assert.match(c.last().text, /Владелица забрала из кассы: <b>10 000 ₸/);
  c.press('f:ok');
  assert.equal(cashOf(store), 5000);
  assert.deepEqual(c.notified.map((n) => n.kind), ['withdrawal']);
});

test('погашение долга: выбор должника, «весь долг» или сумма, способ; больше долга — нельзя', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Погашение долга');
  const erlan = view(store).rows('customers')[0].customer_id;
  assert.deepEqual(c.buttons(), ['f:c:' + erlan, 'f:x']);
  assert.match(c.last().rows[0][0].text, /Ерлан \(сосед\) — 3 000 ₸/);
  c.press('f:c:' + erlan);
  c.say('3500');
  assert.match(c.last().text, /больше долга/);
  c.say('1000');
  c.press('f:m:card');
  assert.match(c.last().text, /Останется долг: 2 000/);
  c.press('f:ok');
  assert.equal(view(store).debtOf(erlan), 2000);
  assert.equal(cashOf(store), 15000, 'безнал не попадает в наличные');
  c.say('Погашение долга'); c.press('f:c:' + erlan); c.press('f:all'); c.press('f:m:cash'); c.press('f:ok');
  assert.equal(view(store).debtOf(erlan), 0);
  assert.equal(cashOf(store), 17000);
  c.say('Погашение долга');
  assert.match(c.last().text, /Должников нет/);
});

test('отмена продажи: только чеки этой смены, причина, товар вернулся, владелице сообщение', () => {
  const { store, anna } = shop();
  const sale = Posting.post(store, anna, { op_id: 'sale-000001', kind: 'sale', payload: { items: [{ item_id: 'bear', qty: 1 }], price: 4500, payments: [{ method: 'cash', amount: 4500 }] } });
  const c = chat(store, anna);
  c.say('Отменить продажу');
  assert.deepEqual(c.buttons(), ['f:r:' + sale.result.receipt_id, 'f:x']);
  assert.match(c.last().rows[0][0].text, /^№1 · 4 500 ₸/);
  c.press('f:r:' + sale.result.receipt_id);
  c.say('Покупатель передумал');
  assert.match(c.last().text, /Товар вернётся на склад/);
  c.press('f:ok');
  assert.equal(view(store).stock('bear'), 5);
  assert.equal(cashOf(store), 15000);
  assert.deepEqual(c.notified.map((n) => n.kind), ['cancel']);
  c.say('Отменить продажу');
  assert.match(c.last().text, /нет чеков/);
});

test('передача смены ведёт в закрытие в кассе; без смены и не своей смены — понятный отказ', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Передать смену');
  assert.deepEqual(c.buttons(), ['https://example.test/kassa/#close']);
  const mira = chat(store, { ...anna, staff_id: 's_mira', tg: '888' });
  mira.say('Расход');
  assert.match(mira.last().text, /не работаете в открытой смене/);
  const owner = chat(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW, tg: '1' });
  owner.say('Владелица забрала');
  assert.match(owner.last().text, /для флориста/);
});

test('старые кнопки другого сценария не срабатывают', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Расход');
  c.say('Владелица забрала'); // начат новый сценарий — старые кнопки не действуют
  c.press('f:t:delivery');
  assert.match(c.last().text, /уже не действует/);
  assert.equal(store.tables.cash_ops, undefined);
});
