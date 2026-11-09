// График смен (D31) и выход владелицы в смену (D32).
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
    { staff_id: 's_mira', client_id: 'c1', point_id: 'p1', telegram_id: '888', name: 'Мира', role: 'florist', shift_rate: 4000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [{ item_id: 'rose', client_id: 'c1', name: 'Роза', category: 'flowers', sale_price: 1000, last_cost: 500, min_stock: 5, status: 'active' }]);
  let n = 0;
  const op = () => 'op-sch-' + String(++n).padStart(7, '0');
  const call = (tg, body) => MiniApi.dispatch(store, tg, body, NOW).data;
  const post = (tg, kind, payload) => MiniApi.dispatch(store, tg, { action: 'post', kind, op_id: op(), payload }, NOW);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  Posting.post(store, owner, { op_id: op(), kind: 'stock_start', payload: { lines: [{ item_id: 'rose', qty: 500 }] } });
  return { store, call, post };
}

// ---------- график ----------

test('график смен: владелица ставит день, все видят; вторая запись дня заменяет первую, история остаётся', () => {
  const { call, post, store } = shop();
  post(1, 'schedule_set', { date: '2026-11-12', staff_ids: ['s_anna', 's_mira'], note: 'приём товара' });
  const seen = call(777, { action: 'schedule', month: '2026-11' });
  assert.deepEqual(seen.entries.map((e) => [e.date, e.name, e.me]), [['2026-11-12', 'Анна', true], ['2026-11-12', 'Мира', false]]);
  assert.equal(seen.can_edit, false);
  assert.deepEqual(seen.people, [], 'список людей для правки — только владелице');
  assert.equal(call(1, { action: 'schedule', month: '2026-11' }).can_edit, true);
  post(1, 'schedule_set', { date: '2026-11-12', staff_ids: ['s_mira'] });
  assert.deepEqual(call(777, { action: 'schedule', month: '2026-11' }).entries.map((e) => e.name), ['Мира']);
  assert.equal(store.tables.schedule.filter((e) => e.status === 'replaced').length, 2, 'прежние записи не удаляются');
  post(1, 'schedule_set', { date: '2026-11-12', staff_ids: [] });
  assert.equal(call(777, { action: 'schedule', month: '2026-11' }).entries.length, 0, 'день можно очистить');
  assert.equal(call(777, { action: 'schedule', month: 'мусор' }).month, '2026-11');
});

test('график: правила ввода и права; график никого не ограничивает', () => {
  const { call, post } = shop();
  assert.throws(() => post(777, 'schedule_set', { date: '2026-11-12', staff_ids: ['s_anna'] }), { code: 'FORBIDDEN' });
  assert.throws(() => post(1, 'schedule_set', { date: '2026-13-01', staff_ids: [] }), { code: 'BAD_INPUT' });
  assert.throws(() => post(1, 'schedule_set', { date: '2030-01-01', staff_ids: [] }), { code: 'BAD_INPUT' });
  assert.throws(() => post(1, 'schedule_set', { date: '2026-11-12', staff_ids: ['s_anna', 's_mira', 's_owner'] }), { code: 'BAD_INPUT' });
  assert.throws(() => post(1, 'schedule_set', { date: '2026-11-12', staff_ids: ['s_anna', 's_anna'] }), { code: 'BAD_INPUT' });
  assert.throws(() => post(1, 'schedule_set', { date: '2026-11-12', staff_ids: ['нет такого'] }), { code: 'UNKNOWN_STAFF' });
  post(1, 'schedule_set', { date: '2026-11-08', staff_ids: ['s_mira'] }); // сегодня назначена Мира…
  assert.ok(post(777, 'open_shift', { florist_ids: [''], open_cash: 0 }), '…а смену может открыть Анна: календарь не ограничивает');
  assert.ok(call(777, { action: 'bootstrap' }).shift.on_shift);
});

test('ближайшая смена на главной: своя, с напарником; чужие дни не показываются', () => {
  const { call, post } = shop();
  post(1, 'schedule_set', { date: '2026-11-10', staff_ids: ['s_mira'] });
  post(1, 'schedule_set', { date: '2026-11-14', staff_ids: ['s_anna', 's_mira'] });
  assert.deepEqual(call(777, { action: 'bootstrap' }).next_shift, { date: '2026-11-14', with: ['Мира'] });
  assert.equal(call(1, { action: 'bootstrap' }).next_shift, null);
});

// ---------- владелица в смене ----------

test('расчёт: владелица без процента не уменьшает процент напарника; оба с процентом делят пополам', () => {
  const C = global.Calc;
  const solo = C.payroll(10000, [{ staff_id: 'a', shift_rate: 5000, pct_bp: 300 }, { staff_id: 'o', shift_rate: 0, pct_bp: 0 }]);
  assert.deepEqual([solo.each.a.pct, solo.each.o.total, solo.total], [300, 0, 5300]);
  const both = C.payroll(10000, [{ staff_id: 'a', shift_rate: 5000, pct_bp: 300 }, { staff_id: 'm', shift_rate: 4000, pct_bp: 300 }]);
  assert.deepEqual([both.each.a.pct, both.each.m.pct], [150, 150]);
  const paidOwner = C.payroll(10000, [{ staff_id: 'a', shift_rate: 5000, pct_bp: 300 }, { staff_id: 'o', shift_rate: 1000, pct_bp: 200 }]);
  assert.deepEqual([paidOwner.each.a.pct, paidOwner.each.o.pct], [150, 100]);
});

test('владелица не выходит в смену, пока сама не включит; после включения продаёт, открывает и закрывает смену', () => {
  const { call, post, store } = shop();
  assert.equal(call(1, { action: 'bootstrap' }).open_info, null);
  assert.throws(() => post(1, 'open_shift', { florist_ids: [''], open_cash: 0 }), { code: 'FORBIDDEN' });
  assert.deepEqual(call(1, { action: 'bootstrap' }).owner_work, { works: false, shift_rate: 0, pct_bp: 0 });
  assert.throws(() => post(777, 'owner_work_set', { enabled: true, shift_rate: 0, pct_bp: 0 }), { code: 'FORBIDDEN' });
  assert.throws(() => post(1, 'owner_work_set', { enabled: true, shift_rate: 0, pct_bp: 10001 }), { code: 'BAD_INPUT' });
  post(1, 'owner_work_set', { enabled: true, shift_rate: 0, pct_bp: 0 }); // без оплаты
  const info = call(1, { action: 'bootstrap' }).open_info;
  assert.deepEqual(info.partners.map((p) => p.name).sort(), ['Анна', 'Мира']);
  assert.ok(call(777, { action: 'bootstrap' }).owner_work === null);
  post(1, 'open_shift', { florist_ids: ['', 's_anna'], open_cash: 0 });
  assert.deepEqual(store.tables.shift_staff.map((r) => r.staff_id).sort(), ['s_anna', 's_owner']);
  post(1, 'sale', { items: [{ item_id: 'rose', qty: 10 }], price: 10000, payments: [{ method: 'cash', amount: 10000 }] });
  post(777, 'sale', { items: [{ item_id: 'rose', qty: 2 }], price: 2000, payments: [{ method: 'cash', amount: 2000 }] });
  const rep = Ops.shiftReport(Ops.makeView(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW }), store.tables.shifts[0].shift_id);
  const byName = Object.fromEntries(rep.payroll.map((p) => [p.staff_id, p]));
  assert.equal(byName.s_anna.pct, 360, 'процент Анны не поделён с владелицей: 12 000 × 3%');
  assert.equal(byName.s_owner.total, 0);
  const text = Reports.shiftText(rep, { items: {}, staff: { s_anna: 'Анна', s_owner: 'Айгуль' } });
  assert.ok(text.includes('Анна') && !text.includes('Айгуль:'), 'строки без оплаты в отчёте нет');
  const v = call(1, { action: 'bootstrap' });
  assert.ok(v.shift.on_shift);
  const facts = Object.fromEntries(v.catalog.map((c) => [c.item_id, c.stock]));
  post(1, 'inventory', { facts });
  const prev = call(1, { action: 'close_preview', counted: 12000 });
  assert.equal(prev.payroll.length, 2);
  const closed = post(1, 'close_shift', { expenses_confirmed: true, counted: 12000 });
  assert.equal(closed.data.result.cash_diff, 12000 - 12000 - 0 + 0, 'касса сошлась (наличные 12 000 при размене 0)');
  assert.equal(store.tables.shifts[0].status, 'closed');
});

test('владелица с оплатой: ставка и процент считаются, процент делится пополам; выключение возвращает прежние права', () => {
  const { post, store, call } = shop();
  post(1, 'owner_work_set', { enabled: true, shift_rate: 3000, pct_bp: 300 });
  post(1, 'open_shift', { florist_ids: ['', 's_mira'], open_cash: 0 });
  post(888, 'sale', { items: [{ item_id: 'rose', qty: 10 }], price: 10000, payments: [{ method: 'cash', amount: 10000 }] });
  const view = Ops.makeView(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW });
  const rep = Ops.shiftReport(view, store.tables.shifts[0].shift_id);
  const by = Object.fromEntries(rep.payroll.map((p) => [p.staff_id, p]));
  assert.deepEqual([by.s_owner.rate, by.s_owner.pct, by.s_mira.pct], [3000, 150, 150]);
  assert.throws(() => post(1, 'owner_work_set', { enabled: false }), { code: 'SHIFT_OPEN' }, 'нельзя выключить режим, пока она в открытой смене');
  post(1, 'inventory', { facts: Object.fromEntries(call(1, { action: 'bootstrap' }).catalog.map((c) => [c.item_id, c.stock])) });
  post(1, 'close_shift', { expenses_confirmed: true, counted: 10000 });
  post(1, 'owner_work_set', { enabled: false });
  assert.throws(() => post(1, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: 1000, payments: [{ method: 'cash', amount: 1000 }] }), { code: 'FORBIDDEN' });
  assert.equal(call(1, { action: 'bootstrap' }).owner_work.works, false);
});
