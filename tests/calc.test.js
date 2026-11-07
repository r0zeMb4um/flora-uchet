// Тесты ядра расчётов: эталонная смена из docs/GOLDEN_TEST.md + крайние случаи.
// Запуск: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Calc = require('../apps-script/core/calc.js');
const golden = require(path.join(__dirname, 'golden_shift.json'));

// ---------- Эталонная смена: раскладываем операции JSON на чеки, платежи, движения ----------

function buildShift(g) {
  const receipts = [];
  const payments = [];
  const cashOps = [];
  const moves = [];
  const debtMoves = [];
  const unpaidPreorders = [];
  let counted = null;
  let closeWithdrawal = 0;
  let inventoryFacts = null;

  for (const [id, qty] of Object.entries(g.start_stock)) moves.push({ type: 'start', item_id: id, qty });
  for (const [name, amount] of Object.entries(g.prior_debts)) debtMoves.push({ type: 'opening', customer_id: name, amount });

  for (const op of g.operations) {
    switch (op.op) {
      case 'sale':
      case 'bouquet':
      case 'preorder': {
        const r = Calc.receiptTotal(op.price, discountOf(op.discount));
        const paid = op.payments.reduce((s, p) => s + p.amount, 0);
        const debt = op.on_debt ? r.total - paid : 0;
        const unpaid = op.op === 'preorder' ? r.total - paid : 0;
        Calc.checkReceiptBalance(r.total, op.payments, debt, unpaid);
        receipts.push({ receipt: op.receipt, ...r, status: 'posted' });
        for (const p of op.payments) {
          payments.push({ kind: p.kind || 'sale', method: p.method, amount: p.amount, receipt: op.receipt });
        }
        if (debt) debtMoves.push({ type: 'sale', customer_id: op.on_debt.customer, amount: debt });
        if (unpaid) unpaidPreorders.push(unpaid);
        for (const it of op.items) moves.push({ type: 'sale', item_id: it.item_id, qty: -it.qty });
        break;
      }
      case 'income':
        moves.push({ type: 'income', item_id: op.item_id, qty: op.qty, cost_sum: op.cost_sum });
        break;
      case 'defect':
        moves.push({ type: 'defect', item_id: op.item_id, qty: -op.qty });
        break;
      case 'debt_repay':
        payments.push({ kind: 'debt_repay', method: op.method, amount: op.amount });
        debtMoves.push({ type: 'repay', customer_id: op.customer, amount: -op.amount });
        break;
      case 'refund':
        payments.push({ kind: 'refund', method: op.method, amount: op.amount });
        break;
      case 'cash_out':
        cashOps.push({ type: op.type, amount: op.amount });
        break;
      case 'inventory':
        inventoryFacts = op.facts;
        break;
      case 'count_cash':
        counted = op.counted;
        break;
      case 'withdrawal_close':
        closeWithdrawal = op.amount;
        break;
      default:
        throw new Error('Неизвестная операция в эталоне: ' + op.op);
    }
  }
  return { receipts, payments, cashOps, moves, debtMoves, unpaidPreorders, counted, closeWithdrawal, inventoryFacts };
}

function discountOf(d) {
  if (!d || d.kind === 'none') return { kind: 'none' };
  if (d.kind === 'pct') return { kind: 'pct', value: d.value_bp };
  return { kind: 'amount', value: d.value };
}

test('эталонная смена №214: все цифры совпадают с docs/GOLDEN_TEST.md', async (t) => {
  const g = golden;
  const exp = g.expected;
  const s = buildShift(g);
  const shiftStaff = g.shift.florist_ids.map((id) => g.staff.find((x) => x.staff_id === id));

  const rev = Calc.shiftRevenue(s.receipts);
  await t.test('выручка, чеки, средний чек, скидки', () => {
    assert.equal(rev.revenue, exp.revenue);
    assert.equal(rev.receipts_count, exp.receipts_count);
    assert.equal(rev.avg_check, exp.avg_check);
    assert.equal(rev.discounts_total, exp.discounts_total);
    assert.deepEqual(s.receipts.map((r) => r.total), exp.receipt_totals);
  });

  await t.test('наличные и безнал по чекам, долг и остаток предзаказа', () => {
    const cashFromReceipts = s.payments
      .filter((p) => p.receipt && p.method === 'cash')
      .reduce((a, p) => a + p.amount, 0);
    assert.equal(cashFromReceipts, exp.cash_from_receipts);
    assert.equal(Calc.cardTotal(s.payments), exp.card_total_for_kaspi);
    const debtFromReceipts = s.debtMoves.filter((m) => m.type === 'sale').reduce((a, m) => a + m.amount, 0);
    assert.equal(debtFromReceipts, exp.unpaid_debt);
    assert.equal(s.unpaidPreorders.reduce((a, x) => a + x, 0), exp.unpaid_preorder);
  });

  const pay = Calc.payroll(rev.revenue, shiftStaff);
  await t.test('процент и зарплата каждой', () => {
    for (const id of g.shift.florist_ids) {
      assert.equal(pay.each[id].pct, exp.pct_each[id], 'процент ' + id);
      assert.equal(pay.each[id].total, exp.payroll_each[id], 'ЗП ' + id);
    }
    assert.equal(pay.total, exp.payroll_total);
  });

  const calcCash = Calc.cashCalc(g.shift.open_cash, s.payments, s.cashOps);
  await t.test('касса: приём, расчёт, расхождение, остаток на следующую смену', () => {
    assert.equal(Calc.openDiff(g.shift.open_cash, g.shift.prev_next_cash), exp.open_diff);
    assert.equal(calcCash, exp.calc_cash);
    const close = Calc.closeShift({
      counted: s.counted,
      calc_cash: calcCash,
      payroll_total: pay.total,
      change_fund: g.settings.change_fund,
      close_withdrawal: s.closeWithdrawal
    });
    assert.equal(close.cash_diff, exp.cash_diff);
    assert.equal(close.can_take_above_change_fund, exp.can_take_above_change_fund);
    assert.equal(close.next_cash, exp.next_cash);
  });

  await t.test('склад: остаток до и после инвентаризации, брак, ниже минимума', () => {
    const before = Calc.stockBalance(s.moves);
    assert.equal(before.rose_red_60, exp.rose_red_calc_before_inventory);

    const adj = Calc.inventoryAdjust(before, s.inventoryFacts);
    assert.deepEqual(adj, exp.inventory_adjust);

    const roseCost = Calc.unitCost(32500, 50);
    assert.equal(roseCost, 650);
    assert.equal(Calc.lossCost(adj.rose_red_60, roseCost), exp.inventory_adjust_cost);
    assert.equal(Calc.lossCost(-3, roseCost), exp.defect_cost);

    const after = Calc.stockBalance(
      s.moves.concat(Object.entries(adj).map(([item_id, qty]) => ({ type: 'adjust', item_id, qty })))
    );
    assert.deepEqual(after, exp.stock_end);
    assert.deepEqual(Calc.belowMin(after, g.catalog), exp.below_min);
  });

  await t.test('долги покупателей', () => {
    assert.deepEqual(Calc.customerDebts(s.debtMoves), exp.customer_debt);
  });
});

// ---------- Округление ----------

test('округление: ровно 0,5 — вверх, меньше — вниз', () => {
  assert.equal(Calc.roundDiv(20970000, 20000), 1049); // 1 048,5 → 1 049 (пример из ТЗ)
  assert.equal(Calc.roundDiv(10485, 10), 1049); // 1 048,5
  assert.equal(Calc.roundDiv(10484, 10), 1048); // 1 048,4
  assert.equal(Calc.roundDiv(10486, 10), 1049); // 1 048,6
  assert.equal(Calc.roundDiv(1, 2), 1); // 0,5 → 1
  assert.equal(Calc.roundDiv(1, 3), 0); // 0,33 → 0
  assert.equal(Calc.roundDiv(0, 7), 0);
});

test('округление: отказ на дробях, отрицательных и нулевом делителе', () => {
  assert.throws(() => Calc.roundDiv(1.5, 2), { code: 'NOT_INTEGER' });
  assert.throws(() => Calc.roundDiv(-1, 2), { code: 'NEGATIVE' });
  assert.throws(() => Calc.roundDiv(1, 0), { code: 'NOT_POSITIVE' });
});

test('процент флориста: деление пополам и процент одной формулой', () => {
  // Порядок важен: выручка 33 → сначала половина 16,5 → 17, потом 3% = 0,51 → 1 (неверно);
  // одной формулой 33 × 3% / 2 = 0,495 → 0 (верно).
  assert.equal(Calc.floristPct(33, 300, 2), 0);
  assert.equal(Calc.floristPct(69900, 300, 2), 1049);
  assert.equal(Calc.floristPct(69900, 300, 1), 2097); // 2 097 ровно
  assert.equal(Calc.floristPct(69900, 250, 1), 1748); // 2,5%: 1 747,5 → 1 748
  assert.throws(() => Calc.floristPct(1000, 300, 3), { code: 'BAD_FLORISTS_COUNT' });
  assert.throws(() => Calc.floristPct(1000, 300, 0), { code: 'BAD_FLORISTS_COUNT' });
});

test('зарплата: один флорист получает процент со всей выручки', () => {
  const p = Calc.payroll(69900, [{ staff_id: 's_anna', shift_rate: 5000, pct_bp: 300 }]);
  assert.deepEqual(p.each.s_anna, { rate: 5000, pct: 2097, total: 7097 });
  assert.equal(p.total, 7097);
});

test('зарплата: разные проценты у двух флористов', () => {
  const p = Calc.payroll(100000, [
    { staff_id: 'a', shift_rate: 5000, pct_bp: 300 },
    { staff_id: 'b', shift_rate: 4000, pct_bp: 200 }
  ]);
  assert.equal(p.each.a.pct, 1500);
  assert.equal(p.each.b.pct, 1000);
  assert.equal(p.total, 11500);
});

// ---------- Чек ----------

test('скидка: в тенге и в процентах, с округлением', () => {
  assert.equal(Calc.discountAmount(6000, { kind: 'pct', value: 1000 }), 600);
  assert.equal(Calc.discountAmount(1005, { kind: 'pct', value: 1000 }), 101); // 100,5 → 101
  assert.equal(Calc.discountAmount(1004, { kind: 'pct', value: 1000 }), 100); // 100,4 → 100
  assert.equal(Calc.discountAmount(6000, { kind: 'amount', value: 500 }), 500);
  assert.equal(Calc.discountAmount(6000, { kind: 'none' }), 0);
  assert.equal(Calc.discountAmount(6000), 0);
});

test('скидка не больше цены и не больше 100%', () => {
  assert.throws(() => Calc.discountAmount(6000, { kind: 'amount', value: 6001 }), { code: 'DISCOUNT_TOO_BIG' });
  assert.throws(() => Calc.discountAmount(6000, { kind: 'pct', value: 10001 }), { code: 'DISCOUNT_TOO_BIG' });
  assert.throws(() => Calc.discountAmount(6000, { kind: 'amount', value: -1 }), { code: 'NEGATIVE' });
  assert.throws(() => Calc.discountAmount(6000, { kind: 'free' }), { code: 'BAD_DISCOUNT' });
});

test('чек на 0 ₸ запрещён (скидка = цене, 100%) — решение D6', () => {
  assert.throws(() => Calc.receiptTotal(6000, { kind: 'amount', value: 6000 }), { code: 'ZERO_TOTAL' });
  assert.throws(() => Calc.receiptTotal(6000, { kind: 'pct', value: 10000 }), { code: 'ZERO_TOTAL' });
  assert.deepEqual(Calc.receiptTotal(6000, { kind: 'amount', value: 5999 }), { price: 6000, discount_amount: 5999, total: 1 });
});

test('цена должна быть целой и больше нуля', () => {
  assert.throws(() => Calc.receiptTotal(0), { code: 'NOT_POSITIVE' });
  assert.throws(() => Calc.receiptTotal(1200.5), { code: 'NOT_INTEGER' });
  assert.throws(() => Calc.receiptTotal('1200'), { code: 'NOT_INTEGER' });
});

test('проверка чека: оплаты + долг + остаток предзаказа = итого', () => {
  assert.equal(Calc.checkReceiptBalance(20000, [{ method: 'cash', amount: 8000 }, { method: 'card', amount: 12000 }], 0, 0), true);
  assert.equal(Calc.checkReceiptBalance(25000, [{ method: 'card', amount: 10000 }], 0, 15000), true);
  assert.equal(Calc.checkReceiptBalance(4500, [], 4500, 0), true);
  assert.throws(() => Calc.checkReceiptBalance(20000, [{ method: 'cash', amount: 8000 }], 0, 0), { code: 'BALANCE_MISMATCH' });
  assert.throws(() => Calc.checkReceiptBalance(20000, [{ method: 'cash', amount: 0 }], 20000, 0), { code: 'NOT_POSITIVE' });
});

test('выручка: отменённые чеки не учитываются', () => {
  const r = Calc.shiftRevenue([
    { total: 15000, discount_amount: 0, status: 'posted' },
    { total: 5400, discount_amount: 600, status: 'cancelled' },
    { total: 3000, discount_amount: 0, status: 'posted' }
  ]);
  assert.equal(r.revenue, 18000);
  assert.equal(r.receipts_count, 2);
  assert.equal(r.discounts_total, 0);
  assert.equal(r.cancelled_count, 1);
  assert.equal(r.avg_check, 9000);
});

test('выручка пустой смены', () => {
  assert.deepEqual(Calc.shiftRevenue([]), { revenue: 0, receipts_count: 0, avg_check: 0, discounts_total: 0, cancelled_count: 0 });
});

// ---------- Касса ----------

test('касса: зарплата, доплата и изъятие при закрытии в расчёт не входят', () => {
  const calc = Calc.cashCalc(10000, [{ kind: 'sale', method: 'cash', amount: 5000 }], [
    { type: 'delivery', amount: 1000 },
    { type: 'withdrawal_day', amount: 2000 },
    { type: 'rate', amount: 5000 },
    { type: 'pct', amount: 150 },
    { type: 'pay_adjust', amount: 300 },
    { type: 'withdrawal_close', amount: 4000 }
  ]);
  assert.equal(calc, 12000);
});

test('касса: безнал не попадает в наличные, возвраты по способу оплаты', () => {
  const payments = [
    { kind: 'sale', method: 'card', amount: 7000 },
    { kind: 'topup', method: 'cash', amount: 3000 },
    { kind: 'refund', method: 'card', amount: 1000 },
    { kind: 'refund', method: 'cash', amount: 500 }
  ];
  assert.equal(Calc.cashCalc(0, payments, []), 2500);
  assert.equal(Calc.cardTotal(payments), 6000);
});

test('касса: аренды в смене нет — тип rent отклоняется (решение D11)', () => {
  assert.throws(() => Calc.cashCalc(0, [], [{ type: 'rent', amount: 4000 }]), { code: 'BAD_CASH_OP' });
});

test('касса: расхождение при приёме смены', () => {
  assert.equal(Calc.openDiff(14500, 15000), -500);
  assert.equal(Calc.openDiff(15000, 15000), 0);
});

test('закрытие: излишек, подсказка не уходит в минус, нельзя забрать больше, чем есть', () => {
  const ok = Calc.closeShift({ counted: 20100, calc_cash: 20000, payroll_total: 12000, change_fund: 5000, close_withdrawal: 0 });
  assert.equal(ok.cash_diff, 100);
  assert.equal(ok.can_take_above_change_fund, 3100);
  assert.equal(ok.next_cash, 8100);

  const low = Calc.closeShift({ counted: 14000, calc_cash: 14000, payroll_total: 12000, change_fund: 5000 });
  assert.equal(low.can_take_above_change_fund, 0);
  assert.equal(low.next_cash, 2000);

  assert.throws(
    () => Calc.closeShift({ counted: 14000, calc_cash: 14000, payroll_total: 12000, change_fund: 5000, close_withdrawal: 2001 }),
    { code: 'WITHDRAWAL_TOO_BIG' }
  );
  assert.throws(
    () => Calc.closeShift({ counted: 10000, calc_cash: 10000, payroll_total: 12000, change_fund: 5000 }),
    { code: 'NOT_ENOUGH_FOR_PAYROLL' }
  );
});

// ---------- Склад ----------

test('склад: нельзя продать больше остатка', () => {
  const bal = { rose: 3, kraft: 10 };
  assert.equal(Calc.checkStock(bal, { rose: 3, kraft: 1 }), true);
  assert.throws(() => Calc.checkStock(bal, { rose: 4 }), (e) => {
    assert.equal(e.code, 'NOT_ENOUGH_STOCK');
    assert.deepEqual(e.details, [{ item_id: 'rose', need: 4, have: 3 }]);
    return true;
  });
  assert.throws(() => Calc.checkStock(bal, { tulip: 1 }), { code: 'NOT_ENOUGH_STOCK' });
});

test('склад: закупочная цена с округлением', () => {
  assert.equal(Calc.unitCost(32500, 50), 650);
  assert.equal(Calc.unitCost(1000, 3), 333); // 333,33
  assert.equal(Calc.unitCost(1001, 2), 501); // 500,5 → 501
  assert.throws(() => Calc.unitCost(1000, 0), { code: 'NOT_POSITIVE' });
});

test('склад: инвентаризация без расхождений не даёт корректировок', () => {
  assert.deepEqual(Calc.inventoryAdjust({ rose: 75, kraft: 60 }, { rose: 75, kraft: 61 }), { kraft: 1 });
  assert.deepEqual(Calc.inventoryAdjust({ rose: 75 }, { rose: 75 }), {});
});

// ---------- Долги ----------

test('долги: стартовый + в долг − погашения; погашение не больше долга', () => {
  const debts = Calc.customerDebts([
    { customer_id: 'Ерлан', amount: 3000 },
    { customer_id: 'Ерлан', amount: 2000 },
    { customer_id: 'Ерлан', amount: -1500 }
  ]);
  assert.equal(debts['Ерлан'], 3500);
  assert.equal(Calc.checkRepay(3500, 3500), true);
  assert.throws(() => Calc.checkRepay(3500, 3501), { code: 'REPAY_TOO_BIG' });
});

test('возврат не больше оплаченного по чеку (решение D13)', () => {
  assert.equal(Calc.checkRefund(5400, 0, 5400), true);
  assert.equal(Calc.checkRefund(5400, 3000, 2400), true);
  assert.throws(() => Calc.checkRefund(5400, 3000, 2401), { code: 'REFUND_TOO_BIG' });
  assert.throws(() => Calc.checkRefund(0, 0, 1), { code: 'REFUND_TOO_BIG' }); // чек целиком в долг
});

// ---------- Месяц ----------

test('прибыль месяца: постоянные расходы владелицы вычитаются, изъятия — нет', () => {
  assert.equal(
    Calc.monthProfit({
      revenue: 1000000, refunds: 10000, purchases: 450000, payroll: 180000,
      delivery: 20000, other: 15000, owner_expenses: 120000
    }),
    205000
  );
});

// ---------- Точность на больших суммах ----------

test('большие суммы считаются без потери точности', () => {
  // Выручка 50 млн ₸ за смену × 3% / 2
  assert.equal(Calc.floristPct(50000000, 300, 2), 750000);
  assert.throws(() => Calc.roundDiv(Number.MAX_SAFE_INTEGER, 1), { code: 'NOT_INTEGER' });
});

// ---------- Найдено при проверке качества ядра ----------

test('зарплата: пустая смена, три флориста и дубль флориста — отказ', () => {
  assert.throws(() => Calc.payroll(1000, []), { code: 'BAD_FLORISTS_COUNT' });
  const f = { staff_id: 'a', shift_rate: 5000, pct_bp: 300 };
  assert.throws(() => Calc.payroll(1000, [f, { ...f, staff_id: 'b' }, { ...f, staff_id: 'c' }]), { code: 'BAD_FLORISTS_COUNT' });
  assert.throws(() => Calc.payroll(1000, [f, f]), { code: 'DUPLICATE_STAFF' });
});

test('процент флориста больше 100% — отказ', () => {
  assert.equal(Calc.floristPct(1000, 10000, 1), 1000);
  assert.throws(() => Calc.floristPct(1000, 10001, 1), { code: 'PCT_TOO_BIG' });
});

test('неизвестный способ оплаты не теряется молча, а даёт отказ', () => {
  const bad = [{ kind: 'sale', method: 'kaspi', amount: 5000 }];
  assert.throws(() => Calc.cashCalc(0, bad, []), { code: 'BAD_PAYMENT_METHOD' });
  assert.throws(() => Calc.cardTotal(bad), { code: 'BAD_PAYMENT_METHOD' });
});

test('стоимость потерь не выходит за пределы точности', () => {
  assert.throws(() => Calc.lossCost(9e15, 10), { code: 'NOT_INTEGER' });
});

// ---------- Вторая, глубокая проверка ----------

test('дробные слагаемые не прячутся в сумме (0,5 + 0,5 = 1)', () => {
  assert.throws(() => Calc.shiftRevenue([
    { total: 100, discount_amount: 0.5 }, { total: 100, discount_amount: 0.5 }
  ]), { code: 'NOT_INTEGER' });
});

test('платёж с неизвестным видом ловится в любой функции, даже если он другим способом оплаты', () => {
  const p = [{ kind: 'gift', method: 'card', amount: 100 }];
  assert.throws(() => Calc.cashCalc(0, p, []), { code: 'BAD_PAYMENT_KIND' });
  assert.throws(() => Calc.cardTotal([{ kind: 'gift', method: 'cash', amount: 100 }]), { code: 'BAD_PAYMENT_KIND' });
});

test('проверка чека отклоняет неизвестный способ оплаты', () => {
  assert.throws(() => Calc.checkReceiptBalance(100, [{ method: 'kaspi', amount: 100 }], 0, 0), { code: 'BAD_PAYMENT_METHOD' });
});

test('движение товара и долг без позиции / покупателя — отказ', () => {
  assert.throws(() => Calc.stockBalance([{ qty: 5 }]), { code: 'BAD_ITEM' });
  assert.throws(() => Calc.customerDebts([{ amount: 5 }]), { code: 'BAD_CUSTOMER' });
});
