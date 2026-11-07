// Случайная проверка ядра: десятки тысяч случайных сумм сравниваются с точным расчётом через BigInt
// (целые числа без ограничения размера) и с бухгалтерскими тождествами.
// Генератор с фиксированным зерном — при падении результат воспроизводится.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../apps-script/core/calc.js');

const RUNS = 20000;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(214);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];

/** Эталон округления «0,5 вверх» на BigInt: q = a / b, остаток r; вверх, если 2r ≥ b. */
function exactRound(a, b) {
  const A = BigInt(a);
  const B = BigInt(b);
  const q = A / B;
  const r = A % B;
  return Number(2n * r >= B ? q + 1n : q);
}

test('округление совпадает с точным расчётом на BigInt', () => {
  for (let i = 0; i < RUNS; i++) {
    const b = int(1, 1_000_000);
    const a = rand() < 0.3 ? b * int(0, 1000) + Math.floor(b / 2) : int(0, 2_000_000_000_000);
    assert.equal(Calc.roundDiv(a, b), exactRound(a, b), `a=${a} b=${b}`);
  }
});

test('процент флориста = точное round(выручка × % / (10 000 × N))', () => {
  for (let i = 0; i < RUNS; i++) {
    const revenue = int(0, 50_000_000);
    const pct = int(0, 10000);
    const n = pick([1, 2]);
    assert.equal(Calc.floristPct(revenue, pct, n), exactRound(revenue * pct, 10000 * n), `${revenue} ${pct} ${n}`);
  }
});

test('чек: итого + скидка = цена, скидка в границах, итого > 0', () => {
  for (let i = 0; i < RUNS; i++) {
    const price = int(1, 5_000_000);
    const kind = pick(['none', 'amount', 'pct']);
    const disc = kind === 'none' ? { kind } : kind === 'amount' ? { kind, value: int(0, price) } : { kind, value: int(0, 10000) };
    let r;
    try {
      r = Calc.receiptTotal(price, disc);
    } catch (e) {
      assert.equal(e.code, 'ZERO_TOTAL'); // единственная допустимая причина — скидка съела всю цену
      continue;
    }
    assert.equal(r.total + r.discount_amount, price);
    assert.ok(r.total > 0 && r.discount_amount >= 0);
    if (kind === 'pct') assert.equal(r.discount_amount, exactRound(price * disc.value, 10000));
  }
});

test('касса и безнал: каждый тенге учтён ровно один раз', () => {
  const kinds = ['sale', 'advance', 'topup', 'debt_repay', 'refund'];
  const opTypes = ['delivery', 'other', 'withdrawal_day', 'rate', 'pct', 'pay_adjust', 'withdrawal_close'];
  for (let i = 0; i < 3000; i++) {
    const open = int(0, 100000);
    const payments = Array.from({ length: int(0, 30) }, () => ({ kind: pick(kinds), method: pick(['cash', 'card']), amount: int(1, 200000) }));
    const ops = Array.from({ length: int(0, 8) }, () => ({ type: pick(opTypes), amount: int(1, 50000) }));
    const sumWhere = (f) => payments.filter(f).reduce((s, p) => s + p.amount, 0);
    const cashIn = sumWhere((p) => p.method === 'cash' && p.kind !== 'refund');
    const cashBack = sumWhere((p) => p.method === 'cash' && p.kind === 'refund');
    const cardIn = sumWhere((p) => p.method === 'card' && p.kind !== 'refund');
    const cardBack = sumWhere((p) => p.method === 'card' && p.kind === 'refund');
    const before = ops.filter((o) => ['delivery', 'other', 'withdrawal_day'].includes(o.type)).reduce((s, o) => s + o.amount, 0);
    assert.equal(Calc.cashCalc(open, payments, ops), open + cashIn - cashBack - before);
    assert.equal(Calc.cardTotal(payments), cardIn - cardBack);
  }
});

test('закрытие смены: пересчёт = ЗП + изъятие + остаток на следующую смену', () => {
  for (let i = 0; i < RUNS; i++) {
    const counted = int(0, 1_000_000);
    const pay = int(0, counted);
    const withdrawal = int(0, counted - pay);
    const calc = int(-100000, 1_000_000);
    const fund = int(0, 20000);
    const r = Calc.closeShift({ counted, calc_cash: calc, payroll_total: pay, change_fund: fund, close_withdrawal: withdrawal });
    assert.equal(r.next_cash + pay + withdrawal, counted);
    assert.equal(r.cash_diff, counted - calc);
    assert.ok(r.next_cash >= 0 && r.can_take_above_change_fund >= 0);
  }
});

test('склад: остаток = сумма движений; инвентаризация приводит ровно к факту', () => {
  const items = ['a', 'b', 'c', 'd'];
  for (let i = 0; i < 3000; i++) {
    const moves = Array.from({ length: int(0, 40) }, () => ({ item_id: pick(items), qty: int(-50, 100) }));
    const bal = Calc.stockBalance(moves);
    for (const id of items) {
      assert.equal(bal[id] || 0, moves.filter((m) => m.item_id === id).reduce((s, m) => s + m.qty, 0));
    }
    const facts = Object.fromEntries(items.map((id) => [id, int(0, 300)]));
    const adj = Calc.inventoryAdjust(bal, facts);
    const after = Calc.stockBalance(moves.concat(Object.entries(adj).map(([item_id, qty]) => ({ item_id, qty }))));
    for (const id of items) assert.equal(after[id] || 0, facts[id]);
  }
});

test('зарплата двух флористов: сумма процентов отличается от процента «на одного» не больше чем на 1 ₸', () => {
  for (let i = 0; i < RUNS; i++) {
    const revenue = int(0, 10_000_000);
    const pct = int(0, 1000);
    const p = Calc.payroll(revenue, [
      { staff_id: 'a', shift_rate: 0, pct_bp: pct },
      { staff_id: 'b', shift_rate: 0, pct_bp: pct }
    ]);
    const whole = Calc.floristPct(revenue, pct, 1);
    assert.ok(Math.abs(p.total - whole) <= 1, `${revenue} ${pct}: ${p.total} vs ${whole}`);
  }
});
