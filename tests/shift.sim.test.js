// Симуляция смены без Google: операции → план → проведение в хранилище в памяти.
// Эталонная смена №214 проводится целиком, как с телефона, и отчёт сверяется с docs/GOLDEN_TEST.md.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Posting = require('../apps-script/core/posting.js');
const Ops = require('../apps-script/core/ops.js');
const { memoryStore } = require('./helpers/memory-store.js');
const golden = require('./golden_shift.json');

const CLIENT = 'c1';
const POINT = 'p1';

// ---------- мир: справочники как после setup() ----------

function world() {
  const store = memoryStore();
  store.seed('clients', [{ client_id: CLIENT, name: 'Цветы у Айгуль', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('settings', [{ client_id: CLIENT, point_id: POINT, change_fund: golden.settings.change_fund, reminder_time: '22:00', cash_tolerance: 0, expense_items: 'Аренда' }]);
  store.seed('staff', [
    { staff_id: 's_owner', client_id: CLIENT, point_id: POINT, name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true },
    ...golden.staff.map((s) => ({ ...s, client_id: CLIENT, point_id: POINT, active: true })),
    { staff_id: 's_old', client_id: CLIENT, point_id: POINT, name: 'Уволена', role: 'florist', shift_rate: 5000, pct_bp: 300, active: false }
  ]);
  const cats = { rose_red_60: 'flowers', eucalyptus: 'greens', kraft: 'packaging', chrysanthemum: 'flowers', toy_bear: 'toys' };
  store.seed('catalog', golden.catalog.map((c) => ({ ...c, client_id: CLIENT, category: cats[c.item_id], unit: 'шт', status: 'active' })));
  // Чужой клиент с похожими данными — не должен быть виден.
  store.seed('staff', [{ staff_id: 's_alien', client_id: 'c2', point_id: 'p9', name: 'Чужая', role: 'florist', shift_rate: 1, pct_bp: 1, active: true }]);

  let seq = 0;
  let clock = Date.parse('2026-11-05T08:00:00+05:00');
  const nowIso = () => new Date((clock += 60000) + 5 * 3600000).toISOString().replace('Z', '+05:00').replace('.000', '');
  const ctx = (staff_id, role = 'florist') => ({ client_id: CLIENT, point_id: POINT, staff_id, role, now: nowIso() });
  const post = (who, kind, payload, opts = {}) => {
    const op_id = opts.op_id || 'op-' + String(++seq).padStart(6, '0');
    const role = who === 's_owner' ? 'owner' : 'florist';
    return { op_id, ...Posting.post(store, opts.ctx || ctx(who, role), { op_id, kind, payload }, opts.hooks) };
  };
  const view = () => Ops.makeView(store, ctx('s_owner', 'owner'));
  const customerId = (name) => store.tables.customers.find((c) => c.name === name).customer_id;
  /** Закрытие по порядку ТЗ: инвентаризация «всё верно» → закрытие. */
  const close = (who, payload) => {
    const v = Ops.makeView(store, ctx(who));
    const facts = Object.fromEntries(v.balance().map((b) => [b.item_id, b.qty]));
    post(who, 'inventory', { facts });
    return post(who, 'close_shift', { expenses_confirmed: true, ...payload });
  };
  return { store, post, view, customerId, ctx, close };
}

/** Старт магазина и «вчерашняя» смена, после которой в кассе остаётся 15 000 ₸ (как в эталоне). */
function startAndYesterday(w) {
  const start = { ...golden.start_stock, toy_bear: golden.start_stock.toy_bear + 1 };
  w.post('s_owner', 'stock_start', { lines: Object.entries(start).map(([item_id, qty]) => ({ item_id, qty })) });
  w.post('s_owner', 'debt_opening', { customer: { new_customer: { name: 'Ерлан', note: 'из тетради' } }, amount: 3000, since_date: '2026-10-20' });

  w.post('s_anna', 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  const y = w.post('s_anna', 'sale', { items: [{ item_id: 'toy_bear', qty: 1 }], price: 30000, payments: [{ method: 'cash', amount: 30000 }] });
  // ЗП Анны: 5 000 + 3% от 30 000 = 5 900; 30 000 − 5 900 − 9 100 = 15 000 на следующую смену.
  w.close('s_anna', { counted: 30000, close_withdrawal: 9100 });
  return { yesterdayReceipt: y.result.receipt_id };
}

/** Эталонная смена №214 — операции из tests/golden_shift.json. */
function goldenShift(w, yesterdayReceipt) {
  const p = (kind, payload) => w.post('s_anna', kind, payload);
  const open = p('open_shift', { florist_ids: golden.shift.florist_ids, open_cash: golden.shift.open_cash });
  const disc = (d) => (d.kind === 'pct' ? { kind: 'pct', value: d.value_bp } : d);
  for (const op of golden.operations) {
    switch (op.op) {
      case 'income':
        p('income', { lines: [{ item_id: op.item_id, qty: op.qty, cost_sum: op.cost_sum }], supplier: op.supplier });
        break;
      case 'sale':
      case 'bouquet':
        p(op.op, {
          items: op.items, price: op.price, discount: disc(op.discount), payments: op.payments,
          debt_customer: op.on_debt ? { new_customer: { name: op.on_debt.customer, note: op.on_debt.note } } : undefined
        });
        break;
      case 'preorder':
        p('preorder', {
          customer: { new_customer: { name: op.customer } }, pickup_date: op.pickup_date, price: op.price,
          discount: disc(op.discount), payments: op.payments.map(({ method, amount }) => ({ method, amount }))
        });
        break;
      case 'defect':
        p('defect', { lines: [{ item_id: op.item_id, qty: op.qty, reason: 'wilted' }] });
        break;
      case 'debt_repay':
        p('debt_repay', { customer_id: w.customerId(op.customer), method: op.method, amount: op.amount });
        break;
      case 'refund':
        p('refund', { receipt_id: yesterdayReceipt, mode: 'money', method: op.method, amount: op.amount });
        break;
      case 'cash_out':
        p('cash_out', { type: op.type, amount: op.amount, comment: op.comment });
        break;
      case 'inventory':
        p('inventory', { facts: op.facts });
        break;
      case 'count_cash':
      case 'withdrawal_close':
        break; // проводятся одной операцией закрытия ниже
      default:
        throw new Error('нет сценария для ' + op.op);
    }
  }
  const counted = golden.operations.find((o) => o.op === 'count_cash').counted;
  const withdrawal = golden.operations.find((o) => o.op === 'withdrawal_close').amount;
  p('close_shift', { counted, close_withdrawal: withdrawal, expenses_confirmed: true });
  return open.result.shift_id;
}

test('эталонная смена №214, проведённая операциями, даёт цифры docs/GOLDEN_TEST.md', () => {
  const w = world();
  const { yesterdayReceipt } = startAndYesterday(w);
  const shiftId = goldenShift(w, yesterdayReceipt);
  const exp = golden.expected;
  const r = Ops.shiftReport(w.view(), shiftId);

  assert.equal(r.revenue, exp.revenue);
  assert.equal(r.receipts_count, exp.receipts_count);
  assert.equal(r.avg_check, exp.avg_check);
  assert.equal(r.discounts, exp.discounts_total);
  assert.equal(r.sales_cash, exp.cash_from_receipts);
  assert.equal(r.sales_debt, exp.unpaid_debt);
  assert.equal(r.preorder_unpaid, exp.unpaid_preorder);
  assert.equal(r.card_total, exp.card_total_for_kaspi);
  assert.equal(r.prior_cash, 3000);
  assert.equal(r.refunds_cash, 2000);
  assert.equal(r.open_cash, 15000);
  assert.equal(r.open_diff, exp.open_diff);
  assert.equal(r.calc_cash, exp.calc_cash);
  assert.equal(r.counted_cash, 32498);
  assert.equal(r.cash_diff, exp.cash_diff);
  assert.equal(r.next_cash, exp.next_cash);
  for (const pr of r.payroll) {
    assert.equal(pr.pct, exp.pct_each[pr.staff_id]);
    assert.equal(pr.total, exp.payroll_each[pr.staff_id]);
    assert.equal(pr.paid, exp.payroll_each[pr.staff_id]);
    assert.equal(pr.unpaid, 0);
  }
  assert.equal(r.delivery, 2500);
  assert.equal(r.other, 4000);
  assert.equal(r.withdrawal, 10000);
  // Тождество отчёта: нал + безнал + в долг + к доплате = выручка.
  assert.equal(r.sales_cash + r.sales_card + r.sales_debt + r.preorder_unpaid, r.revenue);
  assert.deepEqual(r.income, [{ item_id: 'rose_red_60', qty: 50, cost_sum: 32500 }]);
  assert.deepEqual(r.defects, [{ item_id: 'rose_red_60', qty: -3, reason: 'wilted', cost: exp.defect_cost }]);
  assert.deepEqual(r.adjustments, [{ item_id: 'rose_red_60', qty: -1, cost: exp.inventory_adjust_cost }]);
  assert.deepEqual(r.below_min.map((b) => b.item_id), exp.below_min);

  const v = w.view();
  for (const [item, qty] of Object.entries(exp.stock_end)) assert.equal(v.stock(item), qty, 'остаток ' + item);
  assert.equal(v.debtOf(w.customerId('Айгуль')), exp.customer_debt['Айгуль']);
  assert.equal(v.debtOf(w.customerId('Ерлан')), exp.customer_debt['Ерлан']);
  assert.equal(v.item('rose_red_60').last_cost, 650);

  // Сверка остатков с журналом не находит расхождений.
  assert.deepEqual(Posting.reconcileStock(w.store, '2026-11-07T03:00:00+05:00'), []);
});

// ---------- защита от дублей и сбоев ----------

function openGolden(w) {
  startAndYesterday(w);
  w.post('s_anna', 'open_shift', { florist_ids: ['s_anna', 's_mira'], open_cash: 15000 });
}
const SALE = { items: [{ item_id: 'rose_red_60', qty: 5 }], price: 6000, discount: { kind: 'pct', value: 1000 }, payments: [{ method: 'card', amount: 5400 }] };
const snapshot = (store) => JSON.stringify(
  Object.fromEntries(Object.entries(store.tables).map(([k, rows]) => [k, rows.map((r) => {
    const { created_at, updated_at, posted_at, ...rest } = r; // время на повторе может отличаться
    return rest;
  })]))
);

test('повторное нажатие «Провести» с тем же op_id не создаёт дубль', () => {
  const w = world();
  openGolden(w);
  const first = w.post('s_anna', 'sale', SALE, { op_id: 'tap-1234-same' });
  const before = snapshot(w.store);
  const again = w.post('s_anna', 'sale', SALE, { op_id: 'tap-1234-same' });
  assert.equal(first.status, 'posted');
  assert.equal(again.status, 'already');
  assert.deepEqual(again.result, first.result);
  assert.equal(snapshot(w.store), before);
  assert.equal(w.view().stock('rose_red_60'), 35);
});

test('тот же op_id для другой операции — отказ', () => {
  const w = world();
  openGolden(w);
  w.post('s_anna', 'sale', SALE, { op_id: 'tap-xyz-00001' });
  assert.throws(() => w.post('s_anna', 'cash_out', { type: 'other', amount: 1 }, { op_id: 'tap-xyz-00001' }), { code: 'OP_ID_CONFLICT' });
});

test('сбой на любом шаге записи: повтор с тем же op_id дописывает ровно до того же итога', () => {
  const steps = ['logged', 'facts:receipts', 'facts:payments', 'facts:stock_moves', 'updates', 'stock'];
  const clean = world();
  openGolden(clean);
  clean.post('s_anna', 'sale', SALE, { op_id: 'tap-crash-0001' });
  const expected = snapshot(clean.store);

  for (const failAt of steps) {
    const w = world();
    openGolden(w);
    assert.throws(() => w.post('s_anna', 'sale', SALE, {
      op_id: 'tap-crash-0001', hooks: { step: (s) => { if (s === failAt) throw new Error('обрыв связи'); } }
    }), /обрыв связи/);
    assert.equal(w.store.find('ops_log', 'op_id', 'tap-crash-0001')[0].status, 'pending', failAt);
    // Пока не проведено — в отчётах операции нет.
    assert.equal(Ops.makeView(w.store, w.ctx('s_owner', 'owner')).rows('receipts').length, 1, failAt);
    const retry = w.post('s_anna', 'sale', SALE, { op_id: 'tap-crash-0001' });
    assert.equal(retry.status, 'posted', failAt);
    assert.equal(snapshot(w.store), expected, 'после сбоя на шаге ' + failAt);
  }
});

test('зависшая операция ночью становится failed: остатки и статусы возвращаются, повтор запрещён', () => {
  const w = world();
  openGolden(w);
  const r = w.post('s_anna', 'sale', { items: [{ item_id: 'chrysanthemum', qty: 2 }], price: 2000, payments: [{ method: 'cash', amount: 2000 }] });
  // Отмена обрывается после шага «updates»: статус чека уже «отменён», операция не проведена.
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: r.result.receipt_id, reason: 'ошибся' }, {
    op_id: 'tap-hang-0001', hooks: { step: (s) => { if (s === 'stock') throw new Error('таймаут'); } }
  }), /таймаут/);
  assert.equal(w.store.tables.receipts.find((x) => x.receipt_id === r.result.receipt_id).status, 'cancelled');

  const failed = Posting.failStale(w.store, '2026-11-08T03:00:00+05:00', 3600000);
  assert.deepEqual(failed, ['tap-hang-0001']);
  assert.equal(w.store.tables.receipts.find((x) => x.receipt_id === r.result.receipt_id).status, 'posted');
  assert.equal(w.view().stock('chrysanthemum'), 47);
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: r.result.receipt_id, reason: 'ошибся' }, { op_id: 'tap-hang-0001' }), { code: 'OP_FAILED' });
  assert.deepEqual(Posting.reconcileStock(w.store, '2026-11-08T03:00:00+05:00'), []);
});

test('сверка остатков находит и исправляет ручную порчу stock_balance', () => {
  const w = world();
  openGolden(w);
  w.store.update('stock_balance', { item_id: 'kraft' }, { qty: 999 });
  const diffs = Posting.reconcileStock(w.store, '2026-11-08T03:00:00+05:00');
  assert.deepEqual(diffs, [{ client_id: CLIENT, point_id: POINT, item_id: 'kraft', was: 999, now: 61 }]);
});

// ---------- отказы ----------

test('отказы: склад, оплата, итого, смена, права, чужие и неверные данные', () => {
  const w = world();
  startAndYesterday(w);
  const sale = (extra) => ({ ...SALE, ...extra });
  assert.throws(() => w.post('s_anna', 'sale', SALE), { code: 'NO_OPEN_SHIFT' });
  assert.throws(() => w.post('s_anna', 'open_shift', { florist_ids: ['s_mira'], open_cash: 15000 }), { code: 'NOT_ON_SHIFT' });
  assert.throws(() => w.post('s_anna', 'open_shift', { florist_ids: ['s_anna', 's_old'], open_cash: 15000 }), { code: 'UNKNOWN_STAFF' });
  assert.throws(() => w.post('s_anna', 'open_shift', { florist_ids: ['s_anna', 's_alien'], open_cash: 15000 }), { code: 'UNKNOWN_STAFF' });
  assert.throws(() => w.post('s_anna', 'open_shift', { florist_ids: ['s_anna', 's_anna'], open_cash: 15000 }), { code: 'BAD_INPUT' });
  w.post('s_anna', 'open_shift', { florist_ids: ['s_anna'], open_cash: 15000 });
  assert.throws(() => w.post('s_anna', 'open_shift', { florist_ids: ['s_anna'], open_cash: 15000 }), { code: 'SHIFT_ALREADY_OPEN' });
  assert.throws(() => w.post('s_mira', 'sale', SALE), { code: 'NOT_ON_SHIFT' });

  assert.throws(() => w.post('s_anna', 'sale', sale({ items: [{ item_id: 'rose_red_60', qty: 41 }] })), { code: 'NOT_ENOUGH_STOCK' });
  assert.throws(() => w.post('s_anna', 'sale', sale({ items: [{ item_id: 'rose_red_60', qty: 30 }, { item_id: 'rose_red_60', qty: 11 }] })), { code: 'NOT_ENOUGH_STOCK' });
  assert.throws(() => w.post('s_anna', 'sale', sale({ payments: [{ method: 'card', amount: 5000 }] })), { code: 'BALANCE_MISMATCH' });
  assert.throws(() => w.post('s_anna', 'sale', sale({ payments: [{ method: 'kaspi', amount: 5400 }] })), { code: 'BAD_INPUT' });
  assert.throws(() => w.post('s_anna', 'sale', sale({ discount: { kind: 'amount', value: 6000 } })), { code: 'ZERO_TOTAL' });
  assert.throws(() => w.post('s_anna', 'sale', sale({ items: [{ item_id: 'nope', qty: 1 }] })), { code: 'UNKNOWN_ITEM' });
  assert.throws(() => w.post('s_anna', 'sale', sale({ debt_customer: { new_customer: { name: 'Кто-то' } } })), { code: 'BAD_INPUT' });
  assert.throws(() => w.post('s_anna', 'cash_out', { type: 'rent', amount: 4000 }), { code: 'BAD_INPUT' });
  assert.throws(() => w.post('s_anna', 'debt_opening', { customer: { new_customer: { name: 'X' } }, amount: 1, since_date: '2026-01-01' }), { code: 'FORBIDDEN' });
  assert.throws(() => w.post('s_anna', 'owner_expense', { month: '2026-11', item: 'Аренда', amount: 120000 }), { code: 'FORBIDDEN' });
  assert.throws(() => w.post('s_anna', 'close_shift', { counted: 15000, expenses_confirmed: true }), { code: 'INVENTORY_REQUIRED' });
  w.post('s_anna', 'inventory', { facts: { kraft: 61 } });
  assert.throws(() => w.post('s_anna', 'close_shift', { counted: 15000 }), { code: 'CONFIRM_EXPENSES' });
  assert.throws(() => w.post('s_anna', 'sale', SALE, { op_id: 'x' }), { code: 'BAD_OP_ID' });
  assert.throws(() => w.post('s_anna', 'teleport', {}), { code: 'UNKNOWN_OP' });

  // Ни один отказ ничего не записал.
  assert.equal(w.store.tables.ops_log.filter((o) => o.status !== 'posted').length, 0);
  assert.equal(w.view().stock('rose_red_60'), 40);
});

// ---------- возвраты, отмены, предзаказы, брони ----------

test('возврат денег не больше оплаченного; замена списывает товар; возврат по чеку в долг — отказ', () => {
  const w = world();
  openGolden(w);
  const r = w.post('s_anna', 'sale', SALE);
  w.post('s_anna', 'refund', { receipt_id: r.result.receipt_id, mode: 'money', method: 'card', amount: 3000 });
  assert.throws(() => w.post('s_anna', 'refund', { receipt_id: r.result.receipt_id, mode: 'money', method: 'card', amount: 2401 }), { code: 'REFUND_TOO_BIG' });
  w.post('s_anna', 'refund', { receipt_id: r.result.receipt_id, mode: 'money', method: 'card', amount: 2400 });
  w.post('s_anna', 'refund', { receipt_id: r.result.receipt_id, mode: 'replace', items: [{ item_id: 'rose_red_60', qty: 2 }] });
  assert.equal(w.view().stock('rose_red_60'), 33);
  const d = w.post('s_anna', 'sale', { items: [{ item_id: 'kraft', qty: 1 }], price: 300, payments: [], debt_customer: { new_customer: { name: 'Бек' } } });
  assert.throws(() => w.post('s_anna', 'refund', { receipt_id: d.result.receipt_id, mode: 'money', method: 'cash', amount: 1 }), { code: 'REFUND_TOO_BIG' });
});

test('отмена продажи: товар вернулся, долг снят, чек исключён из выручки и кассы', () => {
  const w = world();
  openGolden(w);
  const keep = w.post('s_anna', 'sale', SALE);
  const debt = w.post('s_anna', 'sale', {
    items: [{ item_id: 'toy_bear', qty: 1 }], price: 4500, payments: [{ method: 'cash', amount: 1000 }],
    debt_customer: { new_customer: { name: 'Айгуль' } }
  });
  assert.equal(w.view().debtOf(w.customerId('Айгуль')), 3500);
  w.post('s_anna', 'cancel', { receipt_id: debt.result.receipt_id, reason: 'передумала' });
  const v = w.view();
  assert.equal(v.stock('toy_bear'), 5);
  assert.equal(v.debtOf(w.customerId('Айгуль')), 0);
  const shift = v.openShift();
  const rep = Ops.shiftReport(v, shift.shift_id);
  assert.equal(rep.revenue, 5400);
  assert.equal(rep.cancelled_count, 1);
  assert.equal(rep.calc_cash, 15000); // 1 000 наличных по отменённому чеку отданы обратно
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: debt.result.receipt_id, reason: 'ещё раз' }), { code: 'UNKNOWN_RECEIPT' });
  w.post('s_anna', 'refund', { receipt_id: keep.result.receipt_id, mode: 'money', method: 'card', amount: 100 });
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: keep.result.receipt_id, reason: 'x' }), { code: 'HAS_REFUNDS' });
});

test('отменить можно только чек текущей смены', () => {
  const w = world();
  const { yesterdayReceipt } = startAndYesterday(w);
  w.post('s_anna', 'open_shift', { florist_ids: ['s_anna'], open_cash: 15000 });
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: yesterdayReceipt, reason: 'x' }), { code: 'NOT_THIS_SHIFT' });
});

test('бронь → предзаказ с авансом → сборка → выдача с остатком в долг (D5, D12)', () => {
  const w = world();
  openGolden(w);
  const res = w.post('s_anna', 'reserve', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-08', price: 25000 });
  const rep0 = Ops.shiftReport(w.view(), w.view().openShift().shift_id);
  assert.equal(rep0.revenue, 0); // бронь в выручку не входит
  assert.throws(() => w.post('s_anna', 'preorder', { reservation_id: res.result.reservation_id, payments: [] }), { code: 'NO_ADVANCE' });
  const pre = w.post('s_anna', 'preorder', { reservation_id: res.result.reservation_id, payments: [{ method: 'card', amount: 10000 }] });
  assert.equal(w.store.tables.reservations[0].status, 'converted');
  assert.throws(() => w.post('s_anna', 'preorder', { reservation_id: res.result.reservation_id, payments: [{ method: 'card', amount: 1 }] }), { code: 'BAD_RESERVATION' });
  const id = pre.result.receipt_id;
  assert.throws(() => w.post('s_anna', 'preorder_pickup', { receipt_id: id, payments: [{ method: 'cash', amount: 15000 }] }), { code: 'BAD_STATE' });
  w.post('s_anna', 'preorder_assemble', { receipt_id: id, items: [{ item_id: 'rose_red_60', qty: 20 }] });
  assert.equal(w.view().stock('rose_red_60'), 20);
  assert.throws(() => w.post('s_anna', 'preorder_pickup', { receipt_id: id, payments: [{ method: 'cash', amount: 10000 }] }), { code: 'BALANCE_MISMATCH' });
  w.post('s_anna', 'preorder_pickup', { receipt_id: id, payments: [{ method: 'cash', amount: 10000 }], to_debt: true });
  assert.equal(w.view().debtOf(w.customerId('Дана')), 5000);
  const rep = Ops.shiftReport(w.view(), w.view().openShift().shift_id);
  assert.equal(rep.revenue, 25000);
  assert.equal(rep.preorder_unpaid, 0);
  assert.equal(rep.sales_debt, 5000);
  assert.equal(rep.sales_cash + rep.sales_card + rep.sales_debt + rep.preorder_unpaid, rep.revenue);
  assert.equal(rep.calc_cash, 25000);
  assert.throws(() => w.post('s_anna', 'preorder_pickup', { receipt_id: id, payments: [] }), { code: 'BAD_STATE' });
});

test('доплата за предзаказ в следующей смене не входит в её выручку и процент', () => {
  const w = world();
  openGolden(w);
  const pre = w.post('s_anna', 'preorder', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-08', price: 25000, payments: [{ method: 'card', amount: 10000 }] });
  w.post('s_anna', 'preorder_assemble', { receipt_id: pre.result.receipt_id, items: [{ item_id: 'chrysanthemum', qty: 5 }] });
  w.close('s_anna', { counted: 15000, close_withdrawal: 0 });
  // ЗП: по 5 000 + round(25 000 × 3% / 2) = 5 375 каждой → 15 000 − 10 750 = 4 250 на следующую смену.
  const o = w.post('s_mira', 'open_shift', { florist_ids: ['s_mira'], open_cash: 4250 });
  assert.equal(o.result.open_diff, 0);
  w.post('s_mira', 'preorder_pickup', { receipt_id: pre.result.receipt_id, payments: [{ method: 'cash', amount: 15000 }] });
  const rep = Ops.shiftReport(w.view(), w.view().openShift().shift_id);
  assert.equal(rep.revenue, 0);
  assert.equal(rep.prior_cash, 15000);
  assert.equal(rep.payroll[0].pct, 0);
});

test('закрытие без денег на ЗП (D18) и передача смены', () => {
  const w = world();
  startAndYesterday(w);
  w.post('s_anna', 'open_shift', { florist_ids: ['s_anna', 's_mira'], open_cash: 15000 });
  w.post('s_anna', 'withdrawal', { amount: 15000 });
  const c = w.close('s_anna', { counted: 6000, close_withdrawal: 0 });
  assert.deepEqual(c.result.payroll_paid, { s_anna: 3000, s_mira: 3000 });
  assert.deepEqual(c.result.payroll_unpaid, { s_anna: 2000, s_mira: 2000 });
  assert.equal(c.result.next_cash, 0);
  assert.equal(c.result.cash_diff, 6000);
  // Следующая смена принимает 0 и выдаёт доплату из кассы.
  const o = w.post('s_mira', 'open_shift', { florist_ids: ['s_mira'], open_cash: 0 });
  assert.equal(o.result.open_diff, 0);
  w.post('s_mira', 'sale', { items: [{ item_id: 'kraft', qty: 1 }], price: 3000, payments: [{ method: 'cash', amount: 3000 }] });
  w.post('s_mira', 'pay_adjust', { staff_id: 's_anna', amount: 2000 });
  const rep = Ops.shiftReport(w.view(), w.view().openShift().shift_id);
  assert.equal(rep.calc_cash, 1000);
  assert.equal(rep.pay_adjust, 2000);
});

test('расхождение при приёме уведомляет владелицу; изъятие и отмена — тоже', () => {
  const w = world();
  startAndYesterday(w);
  const o = w.post('s_anna', 'open_shift', { florist_ids: ['s_anna'], open_cash: 14500 });
  assert.equal(o.result.open_diff, -500);
  assert.deepEqual(o.notify.map((n) => n.kind), ['open_diff']);
  assert.deepEqual(w.post('s_anna', 'withdrawal', { amount: 1000 }).notify.map((n) => n.kind), ['withdrawal']);
});

test('новая позиция от флориста: похожие названия, статус «на проверке», уведомление', () => {
  const w = world();
  openGolden(w);
  assert.throws(() => w.post('s_anna', 'new_item', { category: 'flowers', name: 'Роза белая 60 см', sale_price: 1200 }), (e) => {
    assert.equal(e.code, 'SIMILAR_ITEMS');
    assert.deepEqual(e.details.map((d) => d.item_id), ['rose_red_60']);
    return true;
  });
  const r = w.post('s_anna', 'new_item', { category: 'flowers', name: 'Роза белая 60 см', sale_price: 1200, confirm_new: true });
  assert.equal(w.view().item(r.result.item_id).status, 'review');
  assert.deepEqual(r.notify.map((n) => n.kind), ['new_item']);
  w.post('s_anna', 'income', { lines: [{ item_id: r.result.item_id, qty: 10, cost_sum: 6005 }], supplier: 'Флора-опт' });
  assert.equal(w.view().item(r.result.item_id).last_cost, 601); // 600,5 → 601
  w.post('s_anna', 'sale', { items: [{ item_id: r.result.item_id, qty: 1 }], price: 1200, payments: [{ method: 'cash', amount: 1200 }] });
});

test('расходы месяца владелицы не попадают в кассу смены (D11)', () => {
  const w = world();
  openGolden(w);
  w.post('s_owner', 'owner_expense', { month: '2026-11', item: 'Аренда', amount: 120000 });
  assert.equal(Ops.shiftReport(w.view(), w.view().openShift().shift_id).calc_cash, 15000);
  assert.equal(w.store.tables.owner_expenses.length, 1);
});

// ---------- найдено при аудите ----------

test('отчёт закрытой смены не меняется задним числом, когда предзаказ доплатили позже', () => {
  const w = world();
  openGolden(w);
  const pre = w.post('s_anna', 'preorder', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-08', price: 25000, payments: [{ method: 'card', amount: 10000 }] });
  const shiftId = w.view().openShift().shift_id;
  w.post('s_anna', 'preorder_assemble', { receipt_id: pre.result.receipt_id, items: [{ item_id: 'kraft', qty: 1 }] });
  w.close('s_anna', { counted: 15000, close_withdrawal: 0 });
  const before = Ops.shiftReport(w.view(), shiftId);
  w.post('s_mira', 'open_shift', { florist_ids: ['s_mira'], open_cash: 4250 });
  w.post('s_mira', 'preorder_pickup', { receipt_id: pre.result.receipt_id, payments: [], to_debt: true });
  assert.deepEqual(Ops.shiftReport(w.view(), shiftId), before);
  assert.equal(before.preorder_unpaid, 15000);
});

test('отмену предзаказа делает только владелица; чек с заменой отменить нельзя', () => {
  const w = world();
  openGolden(w);
  const pre = w.post('s_anna', 'preorder', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-08', price: 5000, payments: [{ method: 'cash', amount: 1000 }] });
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: pre.result.receipt_id, reason: 'x' }), { code: 'FORBIDDEN' });
  const r = w.post('s_anna', 'sale', SALE);
  w.post('s_anna', 'refund', { receipt_id: r.result.receipt_id, mode: 'replace', items: [{ item_id: 'rose_red_60', qty: 1 }] });
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: r.result.receipt_id, reason: 'x' }), { code: 'HAS_REFUNDS' });
});

test('один и тот же покупатель не задваивается по имени', () => {
  const w = world();
  openGolden(w);
  const debt = (cust) => w.post('s_anna', 'sale', { items: [{ item_id: 'kraft', qty: 1 }], price: 300, payments: [], debt_customer: cust });
  debt({ new_customer: { name: 'Айгуль', note: 'соседний магазин' } });
  assert.throws(() => debt({ new_customer: { name: 'айгуль' } }), (e) => e.code === 'SIMILAR_CUSTOMERS' && e.details.length === 1);
  debt({ customer_id: w.customerId('Айгуль') });
  assert.equal(w.view().debtOf(w.customerId('Айгуль')), 600);
  debt({ new_customer: { name: 'Айгуль', note: 'другая, с рынка', confirm_new: true } });
  assert.equal(w.store.tables.customers.filter((c) => c.name === 'Айгуль').length, 2);
});

test('отключённый флорист теряет доступ сразу, даже посреди смены', () => {
  const w = world();
  openGolden(w);
  w.store.update('staff', { staff_id: 's_mira' }, { active: false });
  assert.throws(() => w.post('s_mira', 'sale', SALE), { code: 'FORBIDDEN' });
  w.post('s_anna', 'sale', SALE);
});

test('скрытую позицию нельзя продать и принять, но можно списать и пересчитать', () => {
  const w = world();
  openGolden(w);
  w.store.update('catalog', { item_id: 'kraft' }, { status: 'hidden' });
  assert.throws(() => w.post('s_anna', 'sale', { items: [{ item_id: 'kraft', qty: 1 }], price: 300, payments: [{ method: 'cash', amount: 300 }] }), { code: 'UNKNOWN_ITEM' });
  assert.throws(() => w.post('s_anna', 'income', { lines: [{ item_id: 'kraft', qty: 1, cost_sum: 100 }], supplier: 'x' }), { code: 'UNKNOWN_ITEM' });
  w.post('s_anna', 'defect', { lines: [{ item_id: 'kraft', qty: 1, reason: 'broken' }] });
  w.post('s_anna', 'inventory', { facts: { kraft: 50 } });
  assert.equal(w.view().stock('kraft'), 50);
});

test('чек в долг, который уже частично погасили, отменить нельзя — только возврат', () => {
  const w = world();
  openGolden(w);
  const d = w.post('s_anna', 'sale', { items: [{ item_id: 'toy_bear', qty: 1 }], price: 4500, payments: [], debt_customer: { new_customer: { name: 'Бек' } } });
  w.post('s_anna', 'debt_repay', { customer_id: w.customerId('Бек'), method: 'cash', amount: 1000 });
  assert.throws(() => w.post('s_anna', 'cancel', { receipt_id: d.result.receipt_id, reason: 'вернул' }), { code: 'DEBT_REPAID' });
  assert.equal(w.view().debtOf(w.customerId('Бек')), 3500);
});

// ---------- текст отчёта смены владелице (шаблон ТЗ) ----------

test('отчёт смены №214 текстом: все цифры эталона на месте, нулевые строки скрыты', () => {
  const Reports = require('../apps-script/bot/reports.js');
  const w = world();
  const { yesterdayReceipt } = startAndYesterday(w);
  const shiftId = goldenShift(w, yesterdayReceipt);
  const v = w.view();
  const names = { items: {}, staff: {} };
  v.rows('catalog').forEach((c) => { names.items[c.item_id] = c.name; });
  v.rows('staff').forEach((s) => { names.staff[s.staff_id] = s.name; });
  const t = Reports.shiftText(Ops.shiftReport(v, shiftId), names).replace(/ /g, ' ');
  for (const line of [
    'ВЫРУЧКА: 69 900 ₸</b> (чеков: 5)',
    'нал 23 000 ₸ · безнал 27 400 ₸ · в долг 4 500 ₸ · предзаказы к доплате 15 000 ₸',
    'скидки 600 ₸',
    'ПОСТУПИЛО ПО ПРОШЛЫМ ДОЛГАМ И ЗАКАЗАМ: нал 3 000 ₸',
    'ВОЗВРАТЫ: нал 2 000 ₸',
    'на начало 15 000 ₸ → расчёт 32 500 ₸ → пересчёт 32 498 ₸',
    'РАСХОЖДЕНИЕ: −2 ₸ (недостача)',
    'остаток на следующую смену (после ЗП и изъятия): 10 400 ₸',
    'БЕЗНАЛ ДЛЯ СВЕРКИ С KASPI: 27 400 ₸',
    'Анна: ставка 5 000 ₸ + % 1 049 ₸ = 6 049 ₸',
    'Мира: ставка 5 000 ₸ + % 1 049 ₸ = 6 049 ₸',
    'РАСХОДЫ: доставка 2 500 ₸ · прочее 4 000 ₸',
    'ИЗЪЯТИЕ: 10 000 ₸',
    'приход: Роза красная 60 см +50 (32 500 ₸)',
    'брак: Роза красная 60 см −3 (1 950 ₸ по закупке)',
    'инвентаризация: Роза красная 60 см −1 (650 ₸)',
    'ниже минимума: Эвкалипт — 12 / 20'
  ]) assert.ok(t.includes(line), 'нет строки: ' + line + '\n---\n' + t);
  assert.ok(!t.includes('отменено'), 'нулевые строки не показываются');
  assert.ok(!t.includes('— <b>к доплате'), 'ЗП выдана полностью');
  assert.ok(!/аренда за|аренда:/i.test(t), 'аренды в смене нет (D11)');
});

// ---------- часть 3–4 этапа D ----------

test('стоимость брака фиксируется при списании: новый приход по другой цене отчёт не меняет (D25)', () => {
  const w = world();
  openGolden(w);
  w.post('s_anna', 'defect', { lines: [{ item_id: 'rose_red_60', qty: 2, reason: 'broken' }] });
  w.post('s_anna', 'income', { lines: [{ item_id: 'rose_red_60', qty: 10, cost_sum: 9000 }], supplier: 'Опт' });
  assert.equal(w.view().item('rose_red_60').last_cost, 900);
  const r = Ops.shiftReport(w.view(), w.view().openShift().shift_id);
  assert.deepEqual(r.defects, [{ item_id: 'rose_red_60', qty: -2, reason: 'broken', cost: 1300 }]);
});

test('отмена предзаказа владелицей: аванс вернуть или оставить, букет на склад, выдать уже нельзя (D24)', () => {
  const w = world();
  openGolden(w);
  const pre = w.post('s_anna', 'preorder', { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-08', price: 20000, payments: [{ method: 'cash', amount: 5000 }] });
  const id = pre.result.receipt_id;
  w.post('s_anna', 'preorder_assemble', { receipt_id: id, items: [{ item_id: 'chrysanthemum', qty: 10 }] });
  assert.throws(() => w.post('s_anna', 'preorder_cancel', { receipt_id: id, reason: 'x' }), { code: 'FORBIDDEN' });
  assert.throws(() => w.post('s_owner', 'preorder_cancel', { receipt_id: id, reason: 'клиент отказался', refund: { method: 'cash', amount: 5001 } }), { code: 'REFUND_TOO_BIG' });
  w.post('s_owner', 'preorder_cancel', { receipt_id: id, reason: 'клиент отказался', refund: { method: 'cash', amount: 5000 }, return_stock: true });
  const v = w.view();
  assert.equal(v.stock('chrysanthemum'), 49);
  const rep = Ops.shiftReport(v, v.openShift().shift_id);
  assert.equal(rep.revenue, 20000, 'выручка дня оформления не меняется');
  assert.equal(rep.calc_cash, 15000, 'аванс 5 000 вернули из кассы');
  assert.throws(() => w.post('s_anna', 'preorder_pickup', { receipt_id: id, payments: [] }), { code: 'BAD_STATE' });
  assert.throws(() => w.post('s_owner', 'preorder_cancel', { receipt_id: id, reason: 'ещё раз' }), { code: 'UNKNOWN_RECEIPT' });
  // Аванс оставлен магазину, без шага возврата.
  const p2 = w.post('s_anna', 'preorder', { customer: { customer_id: w.customerId('Дана') }, pickup_date: '2026-11-09', price: 3000, payments: [{ method: 'card', amount: 1000 }] });
  w.post('s_owner', 'preorder_cancel', { receipt_id: p2.result.receipt_id, reason: 'не пришла' });
  assert.equal(Ops.shiftReport(w.view(), w.view().openShift().shift_id).card_total, 1000);
});

test('обезличивание: имя стёрто, долг и отчёты сохранены, из списков исчез; сотрудник теряет доступ', () => {
  const w = world();
  openGolden(w);
  w.post('s_anna', 'sale', { items: [{ item_id: 'kraft', qty: 1 }], price: 3000, payments: [], debt_customer: { new_customer: { name: 'Айгуль', note: 'сосед' } } });
  const id = w.customerId('Айгуль');
  assert.throws(() => w.post('s_anna', 'anonymize', { customer_id: id }), { code: 'FORBIDDEN' });
  w.post('s_owner', 'anonymize', { customer_id: id });
  const c = w.store.tables.customers.find((x) => x.customer_id === id);
  assert.deepEqual([c.name, c.note, c.anonymized], ['Обезличен', '', true]);
  assert.equal(w.view().debtOf(id), 3000, 'долг остаётся');
  assert.equal(Ops.shiftReport(w.view(), w.view().openShift().shift_id).sales_debt, 3000);
  assert.throws(() => w.post('s_anna', 'sale', { items: [{ item_id: 'kraft', qty: 1 }], price: 300, payments: [], debt_customer: { customer_id: id } }), { code: 'UNKNOWN_CUSTOMER' });
  w.post('s_owner', 'anonymize', { staff_id: 's_mira' });
  const m = w.store.tables.staff.find((x) => x.staff_id === 's_mira');
  assert.deepEqual([m.name, m.telegram_id, m.active], ['Сотрудник (обезличен)', '', false]);
});

// ---------- этап E: исправление записи в закрытой смене (D26) ----------

test('исправление: чек в закрытой смене снят, выручка и % пересчитаны, наличные факты не тронуты, «переплачено»', () => {
  const Reports = require('../apps-script/bot/reports.js');
  const w = world();
  const { yesterdayReceipt } = startAndYesterday(w);
  const shiftId = goldenShift(w, yesterdayReceipt);
  const before = Ops.shiftReport(w.view(), shiftId);
  // Чек №4 (мишка в долг Айгуль, 4 500) провели по ошибке.
  const r4 = w.store.tables.receipts.find((r) => r.shift_id === shiftId && r.receipt_no === 4);
  assert.throws(() => w.post('s_anna', 'correction', { receipt_id: r4.receipt_id, reason: 'ошибка' }), { code: 'FORBIDDEN' });
  const res = w.post('s_owner', 'correction', { receipt_id: r4.receipt_id, reason: 'проведён по ошибке' });
  assert.deepEqual(res.notify.map((n) => n.kind), ['shift_report']);
  const after = Ops.shiftReport(w.view(), shiftId);
  assert.equal(after.revenue, 65400);
  assert.equal(after.corrected, 1);
  assert.equal(after.calc_cash, before.calc_cash, 'наличные факты не меняются');
  assert.equal(after.cash_diff, before.cash_diff);
  assert.equal(after.next_cash, before.next_cash);
  // % каждой: round(65 400 × 3% / 2) = 981; выдано 1 049 → переплачено 68.
  assert.deepEqual(after.payroll.map((p) => [p.pct, p.paid, p.unpaid]), [[981, 6049, -68], [981, 6049, -68]]);
  assert.equal(w.view().debtOf(w.customerId('Айгуль')), 0);
  assert.equal(w.view().stock('toy_bear'), 5);
  const v = w.view();
  const names = { items: {}, staff: {} };
  v.rows('staff').forEach((s) => { names.staff[s.staff_id] = s.name; });
  const t = Reports.shiftText(after, names).replace(/ /g, ' ');
  assert.ok(t.includes('<b>ИСПРАВЛЕНО</b> (1)'));
  assert.ok(t.includes('Анна: ставка 5 000 ₸ + % 981 ₸ = 5 981 ₸ — <b>переплачено 68 ₸</b>'));
  assert.throws(() => w.post('s_owner', 'correction', { receipt_id: r4.receipt_id, reason: 'ещё раз' }), { code: 'UNKNOWN_RECEIPT' });
});

test('исправление в открытой смене не делается — для этого «Отменить продажу»', () => {
  const w = world();
  openGolden(w);
  const r = w.post('s_anna', 'sale', SALE);
  assert.throws(() => w.post('s_owner', 'correction', { receipt_id: r.result.receipt_id, reason: 'x' }), { code: 'SHIFT_OPEN' });
});

// ---------- сводка за период, остатки, должники ----------

test('сводка за период по двум сменам (вчера + №214): цифры, посчитанные вручную', () => {
  const Summary = require('../apps-script/core/summary.js');
  const Reports = require('../apps-script/bot/reports.js');
  const w = world();
  const { yesterdayReceipt } = startAndYesterday(w);
  goldenShift(w, yesterdayReceipt);
  const v = w.view();
  const dates = v.rows('shifts').map((s) => s.shift_date).sort();
  const s = Summary.period(v, dates[0], dates[dates.length - 1]);
  assert.equal(s.shifts, 2);
  assert.equal(s.revenue, 30000 + 69900);
  assert.equal(s.receipts, 6);
  assert.equal(s.avg_check, 16650);
  assert.equal(s.cash, 30000 + 23000 + 3000 - 2000);
  assert.equal(s.card, 27400);
  assert.deepEqual(s.by_supplier, { 'Флора-опт': 32500 });
  assert.equal(s.payroll, 5900 + 12098);
  assert.deepEqual(s.payroll_by.map((p) => [p.staff_id, p.shifts, p.rate, p.pct]), [['s_anna', 2, 10000, 900 + 1049], ['s_mira', 1, 5000, 1049]]);
  // Прибыль = 99 900 − 2 000 возврат − 32 500 закупки − 17 998 ЗП − 2 500 доставка − 4 000 прочее.
  assert.equal(s.profit, 40902);
  assert.deepEqual(s.losses, { defects: 1950, replaces: 0, shortage: 650, cash_diff: -2 });
  assert.deepEqual(s.discounts_by, { s_anna: 600 });
  assert.equal(s.withdrawal, 9100 + 10000);
  assert.equal(s.stock_value_end, 74 * 650 + 12 * 300 + 60 * 100 + 40 * 450 + 4 * 2500);
  assert.deepEqual(s.not_received, { debts: 4500, debts_old: 0, preorders: 15000 });

  // Расходы владелицы за месяц периода уменьшают прибыль, касса не меняется.
  w.post('s_owner', 'owner_expense', { month: dates[0].slice(0, 7), item: 'Аренда', amount: 40000 });
  assert.equal(Summary.period(w.view(), dates[0], dates[1] || dates[0]).profit, 902);

  const t = Reports.periodText(Summary.period(w.view(), dates[0], dates[0]), { staff: { s_anna: 'Анна', s_mira: 'Мира' } }).replace(/ /g, ' ');
  for (const line of ['Выручка <b>99 900 ₸</b> (смен 2, чеков 6, средний чек 16 650 ₸)', 'Закупки 32 500 ₸ (Флора-опт 32 500 ₸)',
    'Анна: смен 2, ставка 10 000 ₸, % 1 949 ₸', 'Аренда 40 000 ₸', '<b>ПРИБЫЛЬ 902 ₸</b>', 'предзаказы к доплате 15 000 ₸']) {
    assert.ok(t.includes(line), 'нет строки: ' + line + '\n' + t);
  }
  assert.throws(() => Summary.period(v, '2026-11-10', '2026-11-01'), { code: 'BAD_INPUT' });
});

test('остатки и должники для владелицы', () => {
  const Summary = require('../apps-script/core/summary.js');
  const Reports = require('../apps-script/bot/reports.js');
  const w = world();
  const { yesterdayReceipt } = startAndYesterday(w);
  goldenShift(w, yesterdayReceipt);
  const v = w.view();
  const st = Summary.stock(v);
  assert.deepEqual(st.below.map((i) => [i.name, i.qty, i.min]), [['Эвкалипт', 12, 20]]);
  const t = Reports.stockText(st, '2026-11-06T22:00:00+05:00').replace(/ /g, ' ');
  assert.ok(t.includes('НИЖЕ МИНИМУМА:</b>\n  Эвкалипт — 12 / 20'));
  assert.ok(t.includes('<b>ЦВЕТЫ:</b>\n  Роза красная 60 см — 74\n  Хризантема кустовая — 40'));
  const d = Summary.debtors(v);
  assert.deepEqual(d.map((x) => [x.name, x.note, x.debt]), [['Айгуль', 'соседний магазин', 4500]]);
  assert.ok(Reports.debtorsText(d).replace(/ /g, ' ').includes('Итого долгов: 4 500 ₸'));
  assert.equal(Reports.debtorsText([]), 'Должников нет.');
});

test('продажа из очереди, оформленная в другой смене, не проводится (SHIFT_CHANGED), в своей — проводится', () => {
  const w = world();
  openGolden(w);
  const no = w.view().openShift().shift_no;
  const sale = { items: [{ item_id: 'kraft', qty: 1 }], price: 300, payments: [{ method: 'cash', amount: 300 }] };
  assert.throws(() => w.post('s_anna', 'sale', { ...sale, shift_no: no - 1 }), { code: 'SHIFT_CHANGED' });
  assert.throws(() => w.post('s_anna', 'bouquet', { ...sale, shift_no: no + 1 }), { code: 'SHIFT_CHANGED' });
  assert.equal(w.view().stock('kraft'), 61, 'отказ ничего не записал');
  w.post('s_anna', 'sale', { ...sale, shift_no: no });
  assert.equal(w.view().stock('kraft'), 60);
  w.post('s_anna', 'sale', sale); // старые клиенты без номера смены продолжают работать
});
