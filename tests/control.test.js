// D28: сборка предзаказа не дороже заказа, лимит доплаты ЗП, уведомления владелице, блок «Контроль» в отчёте смены.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
global.Reports = require('../apps-script/bot/reports.js');
const { memoryStore } = require('./helpers/memory-store.js');

const NOW = '2026-11-08T10:00:00+05:00';
const nbsp = (s) => s.replace(/ /g, " ");

function shop() {
  const store = memoryStore();
  store.seed('clients', [{ client_id: 'c1', name: 'Цветы', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [
    { item_id: 'rose', client_id: 'c1', name: 'Роза', category: 'flowers', sale_price: 1200, last_cost: 650, min_stock: 20, status: 'active' }
  ]);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  const anna = { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW };
  let n = 0;
  const post = (ctx, kind, payload) => Posting.post(store, ctx, { op_id: 'op-ctl-' + String(++n).padStart(7, '0'), kind, payload });
  post(owner, 'stock_start', { lines: [{ item_id: 'rose', qty: 200 }] });
  post(anna, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  const view = (ctx) => Ops.makeView(store, ctx || owner);
  const report = () => Ops.shiftReport(view(), view().openShift().shift_id);
  return { store, owner, anna, post, view, report };
}

const cash = (qty, price, extra) => Object.assign({ items: [{ item_id: 'rose', qty }], price, payments: [{ method: 'cash', amount: price }] }, extra || {});
const preorder = (price) => ({ customer: { new_customer: { name: 'Дана', confirm_new: true } }, pickup_date: '2026-11-09', price, payments: [{ method: 'cash', amount: 1000 }] });

test('предзаказ: состав по каталожным ценам не дороже цены заказа; ровно в цену — можно', () => {
  const { anna, post, store } = shop();
  post(anna, 'preorder', preorder(3000));
  const id = store.tables.receipts.find((r) => r.type === 'preorder').receipt_id;
  assert.throws(() => post(anna, 'preorder_assemble', { receipt_id: id, items: [{ item_id: 'rose', qty: 40 }] }),
    (e) => e.code === 'ASSEMBLY_TOO_EXPENSIVE' && nbsp(e.message).startsWith('Состав на 48 000 ₸, заказ на 3 000 ₸'));
  assert.equal(store.tables.receipts.find((r) => r.receipt_id === id).assembly_status, 'waiting', 'отказ ничего не записал');
  assert.equal(Ops.makeView(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW }).stock('rose'), 200);
  post(anna, 'preorder_assemble', { receipt_id: id, items: [{ item_id: 'rose', qty: 2 }] }); // 2 400 ≤ 3 000
});

test('предзаказ: сборка ровно на сумму заказа проходит (2 500 ₸ = 2 500)', () => {
  const { anna, post, store } = shop();
  store.update('catalog', { item_id: 'rose' }, { sale_price: 500 });
  post(anna, 'preorder', preorder(2500));
  const id = store.tables.receipts.find((r) => r.type === 'preorder').receipt_id;
  post(anna, 'preorder_assemble', { receipt_id: id, items: [{ item_id: 'rose', qty: 5 }] });
  assert.equal(store.tables.receipts.find((r) => r.receipt_id === id).assembly_status, 'assembled');
});

test('доплата ЗП: нечего доплачивать → отказ; после неполной выдачи — не больше долга; уведомление владелице', () => {
  const { anna, post, view } = shop();
  assert.throws(() => post(anna, 'pay_adjust', { staff_id: 's_anna', amount: 100000 }), { code: 'PAY_ADJUST_TOO_BIG' });
  post(anna, 'sale', cash(10, 12000));
  const v = view(anna);
  const facts = Object.fromEntries(v.balance().map((b) => [b.item_id, b.qty]));
  post(anna, 'inventory', { facts });
  // В кассе 12 000, размен 5 000 остаётся, ЗП 5 000 + 3% = 5 360 — выдано полностью. Чтобы был долг, пересчитали «меньше».
  const closed = post(anna, 'close_shift', { expenses_confirmed: true, counted: 2000 });
  const unpaid = Object.values(closed.result.payroll_unpaid).reduce((a, b) => a + b, 0);
  assert.ok(unpaid > 0, 'есть ЗП к доплате');
  post(anna, 'open_shift', { florist_ids: ['s_anna'], open_cash: 50000 });
  assert.throws(() => post(anna, 'pay_adjust', { staff_id: 's_anna', amount: unpaid + 1 }), { code: 'PAY_ADJUST_TOO_BIG' });
  const ok = post(anna, 'pay_adjust', { staff_id: 's_anna', amount: unpaid, comment: 'доплата' });
  assert.ok(ok);
  assert.throws(() => post(anna, 'pay_adjust', { staff_id: 's_anna', amount: 1 }), { code: 'PAY_ADJUST_TOO_BIG' }, 'второй раз — уже нечего');
  assert.ok(ok.notify.some((n) => n.kind === 'pay_adjust' && n.amount === unpaid && n.name === 'Анна'));
});

test('уведомления владелице: возврат денег — всегда, брак — от 5 000 ₸ по закупке', () => {
  const { anna, post } = shop();
  const sale = post(anna, 'sale', cash(2, 2400));
  const refund = post(anna, 'refund', { receipt_id: sale.result.receipt_id, mode: 'money', amount: 400, method: 'cash' });
  assert.ok(refund.notify.some((n) => n.kind === 'refund' && n.amount === 400));
  const small = post(anna, 'defect', { lines: [{ item_id: 'rose', qty: 5, reason: 'wilted' }] }); // 5 × 650 = 3 250
  assert.ok(!small.notify.some((n) => n.kind === 'defect'));
  const big = post(anna, 'defect', { lines: [{ item_id: 'rose', qty: 10, reason: 'wilted' }] }); // 6 500
  assert.ok(big.notify.some((n) => n.kind === 'defect' && n.cost === 6500 && n.qty === 10));
});

test('контроль смены: чисто → «замечаний нет»; цена ниже каталога, скидка, возврат, брак, расход, долг — видны', () => {
  const { anna, post, report } = shop();
  post(anna, 'sale', cash(10, 12000)); // по каталогу, без скидки
  assert.equal(report().control.clean, true);
  assert.ok(Reports.shiftText(report(), { items: {}, staff: {} }).includes('замечаний нет'));

  post(anna, 'sale', cash(10, 100)); // цена ниже каталога
  post(anna, 'sale', { items: [{ item_id: 'rose', qty: 10 }], price: 12000, discount: { kind: 'pct', value: 9900 }, payments: [{ method: 'cash', amount: 120 }] });
  const rc = post(anna, 'sale', cash(1, 1200));
  post(anna, 'refund', { receipt_id: rc.result.receipt_id, mode: 'money', amount: 300, method: 'cash' });
  post(anna, 'defect', { lines: [{ item_id: 'rose', qty: 3, reason: 'wilted' }] });
  post(anna, 'cash_out', { type: 'delivery', amount: 700, comment: 'курьер' });
  post(anna, 'sale', { items: [{ item_id: 'rose', qty: 2 }], price: 2400, payments: [{ method: 'cash', amount: 400 }], debt_customer: { new_customer: { name: 'Иванов', confirm_new: true } } });

  const c = report().control;
  assert.equal(c.clean, false);
  const kinds = c.items.map((i) => i.kind);
  for (const k of ['below_catalog', 'discount', 'refund', 'defect', 'expense', 'debt']) assert.ok(kinds.includes(k), 'нет пункта: ' + k);
  const text = nbsp(Reports.shiftText(report(), { items: {}, staff: {} }));
  assert.ok(text.includes('КОНТРОЛЬ'));
  assert.ok(text.includes('цена 100 ₸ при каталоге 12 000 ₸'));
  assert.ok(text.includes('скидка 99%'));
  assert.ok(text.includes('Возврат 300 ₸'));
  assert.ok(text.includes('Брак: 3 шт на 1 950 ₸'));
  assert.ok(text.includes('курьер'));
  assert.ok(text.includes('В долг: 2 000 ₸ — Иванов'));
});
