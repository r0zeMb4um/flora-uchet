// Суточные смены (D42): «закрыть и открыть следующую», накопление зарплаты до конца серии, выдача накопленного.
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

const NOW = '2026-11-12T09:00:00+05:00';

function shop() {
  const store = memoryStore();
  store.seed('clients', [{ client_id: 'c1', name: 'Цветы', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_mira', client_id: 'c1', point_id: 'p1', telegram_id: '778', name: 'Мира', role: 'florist', shift_rate: 4000, pct_bp: 200, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [{ item_id: 'rose', client_id: 'c1', name: 'Роза', category: 'flowers', sale_price: 1000, last_cost: 0, min_stock: 0, status: 'active' }]);
  let n = 0;
  const op = () => 'op-cnt-' + String(++n).padStart(8, '0');
  const call = (tg, body) => MiniApi.dispatch(store, tg, body, NOW).data;
  const post = (tg, kind, payload, opId) => MiniApi.dispatch(store, tg, { action: 'post', kind, op_id: opId || op(), payload }, NOW);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  Posting.post(store, owner, { op_id: op(), kind: 'stock_start', payload: { lines: [{ item_id: 'rose', qty: 500 }] } });
  const view = () => Ops.makeView(store, owner);
  const shifts = () => store.tables.shifts;
  const cashOps = (type) => store.tables.cash_ops.filter((o) => o.type === type);
  const sell = (tg, amount) => post(tg, 'sale', { items: [{ item_id: 'rose', qty: 1 }], price: amount, payments: [{ method: 'cash', amount }] });
  return { store, call, post, view, shifts, cashOps, sell };
}

test('закрыть и открыть следующую: те же люди, без инвентаризации и пересчёта; деньги переходят, ЗП копится', () => {
  const { post, shifts, cashOps, sell, call, view } = shop();
  post(777, 'open_shift', { florist_ids: [''], open_cash: 10000 }); // первая смена магазина
  sell(777, 10000); // процент 3%: 300, ЗП смены = 5000 + 300
  const r = post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true, close_withdrawal: 0 });
  assert.equal(r.data.status, 'posted');
  assert.equal(r.data.result.counted_skipped, true);
  assert.equal(r.data.result.pay_deferred, true);
  assert.equal(r.data.result.next_cash, 20000, 'расчёт кассы 10 000 + 10 000, зарплату не выдавали');
  assert.deepEqual(r.data.result.payroll_paid, { s_anna: 0 });
  assert.equal(r.data.result.next_shift.shift_no, 2);
  assert.equal(cashOps('rate').length + cashOps('pct').length, 0, 'из кассы ничего не выдано');
  const [s1, s2] = shifts();
  assert.equal(s1.status, 'closed');
  assert.equal(s1.payroll_total, 5300);
  assert.equal(s1.payroll_unpaid, 5300);
  assert.equal(s1.counted_skipped, true);
  assert.equal(s2.status, 'open');
  assert.equal(s2.open_cash, 20000);
  assert.equal(s2.open_diff, 0, 'расхождения при открытии нет');
  assert.equal(s2.florist_ids, 's_anna');
  const boot = call(777, { action: 'bootstrap' });
  assert.equal(boot.shift.shift_no, 2, 'флорист сразу в новой смене');
  assert.equal(boot.shift.my_owed, 5300, 'накоплено к выдаче');
  assert.deepEqual(boot.shift.florist_ids, ['s_anna']);
  assert.equal(view().shiftStaff(s2.shift_id).length, 1);
});

test('продолжение только теми же людьми; без продолжения инвентаризация обязательна, как раньше', () => {
  const { post } = shop();
  post(777, 'open_shift', { florist_ids: ['s_anna', 's_mira'], open_cash: 5000 });
  assert.throws(() => post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true }), { code: 'NOT_SAME_STAFF' });
  assert.throws(() => post(777, 'close_shift', { continue_with: ['s_anna', 's_mira', 's_owner'], expenses_confirmed: true }), { code: 'NOT_SAME_STAFF' });
  assert.throws(() => post(777, 'close_shift', { counted: 5000, expenses_confirmed: true }), { code: 'INVENTORY_REQUIRED' });
  assert.throws(() => post(777, 'close_shift', { continue_with: ['s_anna', 's_mira'] }), { code: 'CONFIRM_EXPENSES' });
  post(777, 'close_shift', { continue_with: ['s_mira', 's_anna'], expenses_confirmed: true }); // порядок не важен
});

test('серия из трёх суток: ЗП копится, при окончании серии выдаётся всё накопленное, остаток кассы сходится', () => {
  const { post, shifts, cashOps, sell, call, view } = shop();
  post(777, 'open_shift', { florist_ids: [''], open_cash: 10000 });
  sell(777, 10000); // 5300
  post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true });
  sell(777, 20000); // 5000 + 600 = 5600
  post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true, counted: 40000 }); // пересчёт по желанию: расчёт 10000+10000+20000 = 40000
  assert.equal(shifts()[1].counted_skipped, false);
  assert.equal(shifts()[1].cash_diff, 0);
  assert.equal(shifts()[2].open_cash, 40000);
  sell(777, 10000); // 5300
  // конец серии: инвентаризация и пересчёт; накоплено 5300 + 5600, своя смена 5300
  const facts = Object.fromEntries(view().balance().map((b) => [b.item_id, b.qty]));
  post(777, 'inventory', { facts });
  const pv = call(777, { action: 'close_preview', counted: 50000, close_withdrawal: 0 });
  assert.deepEqual(pv.payroll, [{ name: 'Анна', due: 5300, carried: 10900, paid: 16200, unpaid: 0 }]);
  const r = post(777, 'close_shift', { counted: 50000, expenses_confirmed: true, close_withdrawal: 10000 });
  assert.equal(r.data.result.next_cash, 50000 - 16200 - 10000);
  assert.equal(r.data.result.next_shift, null, 'серия закончена: новая смена не открывается');
  assert.equal(cashOps('rate').reduce((a, o) => a + o.amount, 0), 5000);
  assert.equal(cashOps('pct').reduce((a, o) => a + o.amount, 0), 300);
  assert.equal(cashOps('pay_carry').reduce((a, o) => a + o.amount, 0), 10900, 'накопленное за две прошлые смены');
  assert.equal(shifts()[2].payroll_unpaid, 0);
  assert.equal(call(777, { action: 'bootstrap' }).shift, null);
  // дальше долга по ЗП нет
  assert.equal(Ops.salaryOwed(view(), 's_anna'), 0);
});

test('забрать накопленное по необходимости: не больше накопленного, остаток выдаётся при закрытии серии', () => {
  const { post, shifts, cashOps, sell, call, view } = shop();
  post(777, 'open_shift', { florist_ids: [''], open_cash: 10000 });
  sell(777, 10000); // 5300
  post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true });
  assert.throws(() => post(777, 'pay_adjust', { staff_id: 's_anna', amount: 5301 }), { code: 'PAY_ADJUST_TOO_BIG' });
  const take = post(777, 'pay_adjust', { staff_id: 's_anna', amount: 2000, comment: 'нужны деньги' });
  assert.deepEqual(take.data.notify, undefined === take.data.notify ? undefined : take.data.notify);
  assert.equal(call(777, { action: 'bootstrap' }).shift.my_owed, 3300);
  assert.equal(shifts()[1].status, 'open');
  const facts = Object.fromEntries(view().balance().map((b) => [b.item_id, b.qty]));
  post(777, 'inventory', { facts });
  // касса: 10000 + 10000 (первые сутки) − 2000 (взяла) = 18000; в конце серии ещё свои 5000 (продаж нет → процент 0)
  const pv = call(777, { action: 'close_preview', counted: 18000, close_withdrawal: 0 });
  assert.equal(pv.payroll[0].due, 5000);
  assert.equal(pv.payroll[0].carried, 3300);
  assert.equal(pv.payroll[0].paid, 8300);
  post(777, 'close_shift', { counted: 18000, expenses_confirmed: true });
  assert.equal(cashOps('pay_carry').reduce((a, o) => a + o.amount, 0), 3300);
  assert.equal(Ops.salaryOwed(view(), 's_anna'), 0);
});

test('обычное закрытие (без продолжения) не трогает недовыплаты из-за нехватки наличных (D18): доплата только отдельно', () => {
  const { post, cashOps, view } = shop();
  post(777, 'open_shift', { florist_ids: [''], open_cash: 1000 });
  const facts = Object.fromEntries(view().balance().map((b) => [b.item_id, b.qty]));
  post(777, 'inventory', { facts });
  const r = post(777, 'close_shift', { counted: 1000, expenses_confirmed: true }); // ЗП 5000, в кассе только 1000
  assert.equal(r.data.result.payroll_unpaid.s_anna, 4000);
  assert.equal(cashOps('pay_carry').length, 0);
  post(777, 'open_shift', { florist_ids: [''], open_cash: 0 });
  const facts2 = Object.fromEntries(view().balance().map((b) => [b.item_id, b.qty]));
  post(777, 'inventory', { facts: facts2 });
  const r2 = post(777, 'close_shift', { counted: 5000, expenses_confirmed: true });
  assert.equal(r2.data.result.payroll_carried.s_anna, 0, 'недовыплата прошлой смены сама не подтягивается');
});

test('повтор закрытия с продолжением по тому же op_id: уже проведено, второй смены не появляется', () => {
  const { post, shifts } = shop();
  post(777, 'open_shift', { florist_ids: [''], open_cash: 0 });
  const first = post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true }, 'op-same-close-0001');
  const again = post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true }, 'op-same-close-0001');
  assert.equal(first.data.status, 'posted');
  assert.equal(again.data.status, 'already');
  assert.equal(shifts().length, 2);
});

test('отчёт владелице: суточная смена помечена, накопленное видно строкой', () => {
  const { post, sell, view } = shop();
  post(777, 'open_shift', { florist_ids: [''], open_cash: 10000 });
  sell(777, 10000);
  post(777, 'close_shift', { continue_with: ['s_anna'], expenses_confirmed: true });
  const id1 = view().rows('shifts')[0].shift_id;
  const t1 = Reports.shiftText(Ops.shiftReport(view(), id1), { items: {}, staff: { s_anna: 'Анна' } }).replace(/ /g, ' ');
  assert.ok(t1.includes('пересчёт не делали'), t1);
  assert.ok(t1.includes('копится до конца серии'), t1);
  const facts = Object.fromEntries(view().balance().map((b) => [b.item_id, b.qty]));
  post(777, 'inventory', { facts });
  post(777, 'close_shift', { counted: 20000, expenses_confirmed: true });
  const id2 = view().rows('shifts')[1].shift_id;
  const t2 = Reports.shiftText(Ops.shiftReport(view(), id2), { items: {}, staff: { s_anna: 'Анна' } }).replace(/ /g, ' ');
  assert.ok(t2.includes('выдано накопленное 5 300 ₸'), t2);
});
