// Случайные смены: тысячи случайных операций (верных и неверных), случайные обрывы связи и повторы.
// После каждого шага проверяются бухгалтерские правила, которые не могут нарушаться никогда.
// Любая ошибка без кода (сбой программы, а не отказ по правилу) — провал теста.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Posting = require('../apps-script/core/posting.js');
const Ops = require('../apps-script/core/ops.js');
const Calc = require('../apps-script/core/calc.js');
const { memoryStore } = require('./helpers/memory-store.js');

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

const BASE_ITEMS = ['rose', 'tulip', 'eucalyptus', 'kraft', 'bear'];
let ITEMS = BASE_ITEMS.slice();
const FLORISTS = ['s_a', 's_b', 's_c'];
const STEP_NAMES = ['logged', 'facts:receipts', 'facts:payments', 'facts:stock_moves', 'facts:debt_moves', 'facts:cash_ops', 'updates', 'stock'];

function setup() {
  const store = memoryStore();
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', name: 'Владелица', role: 'owner', shift_rate: 0, pct_bp: 0, active: true },
    { staff_id: 's_a', client_id: 'c1', point_id: 'p1', name: 'А', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_b', client_id: 'c1', point_id: 'p1', name: 'Б', role: 'florist', shift_rate: 4000, pct_bp: 250, active: true },
    { staff_id: 's_c', client_id: 'c1', point_id: 'p1', name: 'В', role: 'florist', shift_rate: 6000, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', BASE_ITEMS.map((id, i) => ({
    item_id: id, client_id: 'c1', name: 'Позиция ' + id, category: 'flowers', unit: 'шт',
    sale_price: 500 * (i + 1), last_cost: 200 * (i + 1), min_stock: 5, status: 'active'
  })));
  return store;
}

function runScenario(seed, steps) {
  ITEMS = BASE_ITEMS.slice();
  const R = rng(seed);
  const int = (a, b) => a + Math.floor(R() * (b - a + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const store = setup();
  let clock = Date.parse('2026-11-01T08:00:00+05:00');
  let seq = 0;
  const log = [];
  const ctxOf = (staff_id) => ({
    client_id: 'c1', point_id: 'p1', staff_id, role: staff_id === 's_owner' ? 'owner' : 'florist',
    now: new Date((clock += int(1, 30) * 60000) + 5 * 3600000).toISOString().replace('.000Z', '+05:00')
  });
  const view = () => Ops.makeView(store, ctxOf('s_owner'));

  function post(who, kind, payload) {
    const op_id = 'f' + seed + '-' + String(++seq).padStart(6, '0');
    const ctx = ctxOf(who);
    const crashAt = R() < 0.15 ? pick(STEP_NAMES) : null;
    let res;
    try {
      res = Posting.post(store, ctx, { op_id, kind, payload }, {
        step: (s) => { if (s === crashAt) throw Object.assign(new Error('обрыв'), { crash: true }); }
      });
    } catch (e) {
      if (e.crash) {
        res = Posting.post(store, ctx, { op_id, kind, payload }); // повтор того же нажатия
        assert.equal(res.status, 'posted', 'повтор после обрыва на ' + crashAt);
        const again = Posting.post(store, ctx, { op_id, kind, payload });
        assert.equal(again.status, 'already');
      } else {
        if (!e.code) throw new Error(`сбой программы на ${kind} ${JSON.stringify(payload)}: ${e.stack}`);
        log.push(kind + ' ✗ ' + e.code);
        return null;
      }
    }
    log.push(kind + ' ✓');
    return res;
  }

  const receiptsOf = () => view().rows('receipts');
  const randomItems = () => Array.from({ length: int(1, 3) }, () => ({ item_id: pick(ITEMS), qty: int(1, 12) }));
  const randomPays = (total) => {
    const mode = int(0, 4);
    if (mode === 0) return [{ method: 'cash', amount: total }];
    if (mode === 1) return [{ method: 'card', amount: total }];
    if (mode === 2 && total > 1) { const c = int(1, total - 1); return [{ method: 'cash', amount: c }, { method: 'card', amount: total - c }]; }
    if (mode === 3) return [{ method: 'cash', amount: Math.max(1, total - int(-3, 3)) }]; // часто неверно
    return [];
  };
  const discount = () => pick([undefined, { kind: 'none' }, { kind: 'amount', value: int(0, 2000) }, { kind: 'pct', value: int(0, 10000) }]);

  post('s_owner', 'stock_start', { lines: ITEMS.map((item_id) => ({ item_id, qty: int(0, 60) })) });
  post('s_owner', 'debt_opening', { customer: { new_customer: { name: 'Старый долг' } }, amount: int(1, 9000), since_date: '2026-10-01' });

  for (let i = 0; i < steps; i++) {
    const v = view();
    const shift = v.openShift();
    if (!shift) {
      const n = int(1, 2);
      const team = n === 1 ? [pick(FLORISTS)] : [pick(FLORISTS), pick(FLORISTS)];
      const prev = v.rows('shifts').filter((s) => s.status === 'closed').pop();
      post(team[0], 'open_shift', { florist_ids: team, open_cash: (prev ? prev.next_cash : 0) + (R() < 0.2 ? int(-500, 500) : 0) });
      continue;
    }
    const team = v.shiftStaff(shift.shift_id).map((s) => s.staff_id);
    const who = R() < 0.05 ? pick(FLORISTS) : pick(team);
    const myReceipts = receiptsOf();
    const r = int(0, 100);
    if (r < 25) {
      const price = int(1, 30000);
      const d = discount();
      let total = price;
      try { total = Calc.receiptTotal(price, d).total; } catch (e) { /* отказ проверит сама операция */ }
      const pays = randomPays(total);
      const debt = R() < 0.25;
      if (debt && pays.length) pays.pop();
      post(who, pick(['sale', 'bouquet']), {
        items: randomItems(), price, discount: d, payments: pays,
        debt_customer: debt ? (R() < 0.5 && v.rows('customers').length ? { customer_id: pick(v.rows('customers')).customer_id } : { new_customer: { name: 'К' + int(1, 6), confirm_new: true } }) : undefined
      });
    } else if (r < 32) {
      const price = int(2, 40000);
      post(who, 'preorder', { customer: { new_customer: { name: 'П' + int(1, 9), confirm_new: true } }, pickup_date: '2026-11-20', price, payments: [{ method: pick(['cash', 'card']), amount: int(1, price) }] });
    } else if (r < 36) {
      const pre = myReceipts.filter((x) => x.type === 'preorder' && x.status === 'posted');
      if (pre.length) {
        const p = pick(pre);
        if (p.assembly_status === 'waiting') post(who, 'preorder_assemble', { receipt_id: p.receipt_id, items: randomItems() });
        else {
          const m = { paid: 0, debt: 0 };
          v.rows('payments').forEach((x) => { if (x.receipt_id === p.receipt_id) m.paid += x.kind === 'refund' ? -x.amount : x.amount; });
          const left = p.total - m.paid;
          post(who, 'preorder_pickup', R() < 0.5 ? { receipt_id: p.receipt_id, payments: left > 0 ? [{ method: 'cash', amount: left }] : [] }
            : { receipt_id: p.receipt_id, payments: [], to_debt: true });
        }
      }
    } else if (r < 44) {
      post(who, 'income', { lines: randomItems().map((l) => ({ ...l, cost_sum: int(0, 20000) })), supplier: 'Опт' });
    } else if (r < 48) {
      post(who, 'defect', { lines: [{ item_id: pick(ITEMS), qty: int(1, 5), reason: pick(['wilted', 'broken', 'gift']) }] });
    } else if (r < 54 && myReceipts.length) {
      const x = pick(myReceipts);
      if (R() < 0.6) post(who, 'refund', { receipt_id: x.receipt_id, mode: 'money', method: pick(['cash', 'card']), amount: int(1, x.total) });
      else post(who, 'refund', { receipt_id: x.receipt_id, mode: 'replace', items: randomItems() });
    } else if (r < 60 && myReceipts.length) {
      post(who, 'cancel', { receipt_id: pick(myReceipts).receipt_id, reason: 'ошибка' });
    } else if (r < 65) {
      const debtors = v.rows('customers').filter((c) => v.debtOf(c.customer_id) > 0);
      if (debtors.length) {
        const c = pick(debtors);
        post(who, 'debt_repay', { customer_id: c.customer_id, method: pick(['cash', 'card']), amount: int(1, v.debtOf(c.customer_id) + 50) });
      }
    } else if (r < 72) {
      post(who, 'cash_out', { type: pick(['delivery', 'other', 'rent']), amount: int(1, 5000) });
    } else if (r < 75) {
      post(who, 'withdrawal', { amount: int(1, 8000) });
    } else if (r < 77) {
      post(who, 'pay_adjust', { staff_id: pick(FLORISTS), amount: int(1, 3000) });
    } else if (r < 80) {
      const k = int(0, 4);
      if (k === 0) post('s_owner', 'owner_expense', { month: '2026-11', item: 'Аренда', amount: int(1, 100000) });
      else if (k === 1) {
        // Отмена предзаказа владелицей: аванс вернуть наличными/на карту или оставить, букет на склад.
        const pre = myReceipts.filter((x) => x.type === 'preorder' && x.status === 'posted' && (x.assembly_status === 'waiting' || x.assembly_status === 'assembled'));
        if (pre.length) {
          const p = pick(pre);
          const paid = v.rows('payments').filter((x) => x.receipt_id === p.receipt_id).reduce((a, x) => a + (x.kind === 'refund' ? -x.amount : x.amount), 0);
          const mode = int(0, 2);
          post('s_owner', 'preorder_cancel', {
            receipt_id: p.receipt_id, reason: 'отказ', return_stock: R() < 0.5,
            refund: mode === 2 || paid <= 0 ? undefined : { method: mode ? 'card' : 'cash', amount: int(1, paid + 100) }
          });
        }
      } else if (k === 2) {
        post(who, 'reserve', { customer: { new_customer: { name: 'Б' + int(1, 5), confirm_new: true } }, pickup_date: '2026-11-25', price: int(1, 20000) });
      } else if (k === 3) {
        const res = v.rows('reservations').filter((x) => x.status === 'active');
        if (res.length) {
          const x = pick(res);
          if (R() < 0.7) post(who, 'preorder', { reservation_id: x.reservation_id, payments: [{ method: pick(['cash', 'card']), amount: int(1, x.total) }] });
          else post(who, 'reserve_cancel', { reservation_id: x.reservation_id });
        }
      } else {
        const item = post(who, 'new_item', { category: 'flowers', name: 'Новая ' + int(1, 3), sale_price: int(100, 3000), confirm_new: R() < 0.5 });
        if (item) ITEMS.push(item.result.item_id);
      }
    } else if (r < 88) {
      // Закрытие по порядку ТЗ: инвентаризация (иногда с расхождением) → пересчёт → изъятие.
      const facts = Object.fromEntries(ITEMS.map((id) => [id, Math.max(0, v.stock(id) + (R() < 0.3 ? int(-2, 2) : 0))]));
      post(who, 'inventory', { facts });
      const rep = Ops.shiftReport(view(), shift.shift_id);
      const counted = Math.max(0, rep.calc_cash + (R() < 0.3 ? int(-300, 300) : 0));
      post(who, 'close_shift', { counted, close_withdrawal: R() < 0.4 ? int(0, Math.max(0, counted)) : 0, expenses_confirmed: true });
    }
    checkInvariants(store, view(), seed, log);
  }
  return { store, log };
}

function checkInvariants(store, v, seed, log) {
  const where = () => `зерно ${seed}, после: ${log.slice(-3).join(' | ')}`;
  // 1. Остатки = сумма проведённых движений, и не бывают отрицательными.
  const fromJournal = Calc.stockBalance(v.rows('stock_moves'));
  for (const b of v.balance()) {
    assert.equal(b.qty, fromJournal[b.item_id] || 0, 'остаток ' + b.item_id + ' ' + where());
    assert.ok(b.qty >= 0, 'отрицательный остаток ' + b.item_id + ' ' + where());
  }
  // 2. Долги не бывают отрицательными.
  for (const c of v.rows('customers')) assert.ok(v.debtOf(c.customer_id) >= 0, 'отрицательный долг ' + where());
  // 3. Нет незавершённых операций (каждый обрыв был дописан повтором).
  assert.equal(store.rows('ops_log').filter((o) => o.status !== 'posted').length, 0, where());
  // 4. Отчёт каждой смены сходится сам с собой; цепочка касс между сменами не рвётся.
  const shifts = v.rows('shifts');
  let prevNext = 0;
  for (const s of shifts) {
    const r = Ops.shiftReport(v, s.shift_id);
    assert.equal(r.sales_cash + r.sales_card + r.sales_debt + r.preorder_unpaid, r.revenue, 'тождество выручки ' + where());
    assert.equal(s.prev_next_cash, prevNext, 'приём кассы = остаток прошлой смены ' + where());
    assert.equal(s.open_diff, s.open_cash - s.prev_next_cash, where());
    if (s.status === 'closed') {
      const paid = r.payroll.reduce((a, p) => a + p.paid, 0);
      const unpaid = r.payroll.reduce((a, p) => a + p.unpaid, 0);
      assert.equal(s.next_cash, s.counted_cash - paid - s.close_withdrawal, 'остаток на следующую смену ' + where());
      assert.equal(s.cash_diff, s.counted_cash - s.calc_cash, where());
      assert.equal(r.calc_cash, s.calc_cash, 'расчёт кассы не меняется после закрытия ' + where());
      assert.equal(paid + unpaid, s.payroll_total, 'выдано + к доплате = начислено ' + where());
      assert.equal(unpaid, s.payroll_unpaid, where());
      assert.ok(s.next_cash >= 0, where());
      prevNext = s.next_cash;
    }
  }
  // 5. Возвраты по каждому чеку не больше оплаченного.
  const money = {};
  for (const p of v.rows('payments')) {
    if (!p.receipt_id) continue;
    const m = (money[p.receipt_id] = money[p.receipt_id] || { in: 0, back: 0 });
    if (p.kind === 'refund') m.back += p.amount; else m.in += p.amount;
  }
  for (const id of Object.keys(money)) assert.ok(money[id].back <= money[id].in, 'возврат больше оплаты ' + where());
  // 6. По каждому неотменённому чеку: оплачено + долг ≤ итого.
  for (const rc of v.rows('receipts')) {
    if (rc.status === 'cancelled') continue;
    const debt = v.rows('debt_moves').filter((m) => m.receipt_id === rc.receipt_id).reduce((a, m) => a + m.amount, 0);
    const m = money[rc.receipt_id] || { in: 0, back: 0 };
    if (rc.type !== 'preorder') {
      // Продажа: при оформлении оплачено + в долг ровно итого (возвраты — отдельные выплаты позже).
      assert.equal(m.in + debt, rc.total, 'чек оплачен не так ' + where());
    } else {
      // Предзаказ: за вычетом возвратов не больше итого; после выдачи поступления + долг покрывают итого.
      assert.ok(m.in - m.back + debt <= rc.total, 'оплачено больше итого ' + where());
      if (rc.assembly_status === 'picked_up') assert.ok(m.in + debt >= rc.total, 'выдан неоплаченным ' + where());
    }
  }
}

test('случайные смены: 40 сценариев × 250 шагов, обрывы и повторы — правила учёта не нарушаются', () => {
  let ok = 0;
  let refused = 0;
  const done = {};
  for (let seed = 1; seed <= 40; seed++) {
    const { log } = runScenario(seed, 250);
    ok += log.filter((l) => l.endsWith('✓')).length;
    refused += log.filter((l) => l.includes('✗')).length;
    log.filter((l) => l.endsWith('✓')).forEach((l) => { const k = l.split(' ')[0]; done[k] = (done[k] || 0) + 1; });
  }
  // Каждая операция реально проводилась, а не только получала отказы.
  for (const kind of ['sale', 'bouquet', 'preorder', 'preorder_assemble', 'preorder_pickup', 'preorder_cancel', 'reserve', 'reserve_cancel',
    'income', 'new_item', 'defect', 'refund', 'cancel', 'debt_repay', 'cash_out', 'withdrawal', 'pay_adjust', 'inventory', 'close_shift', 'open_shift']) {
    assert.ok(done[kind] > 0, 'ни разу не проведено: ' + kind + ' ' + JSON.stringify(done));
  }
  // Сценарии должны реально что-то проводить, а не упираться в отказы.
  assert.ok(ok > 5000, 'проведено ' + ok);
  assert.ok(refused > 500, 'отказов ' + refused);
});
