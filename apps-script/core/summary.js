/**
 * Сводка за период для владелицы (ТЗ, «Сводка за период» и «Формулы → 5. Месяц»).
 * Чистые функции поверх «вида» Ops.makeView (только проведённые операции).
 *
 * Правила:
 *  - смены берутся по дате смены (= дате открытия) в пределах [from, to];
 *  - прибыль = выручка − возвраты деньгами − закупки − ЗП − доставки − прочие − расходы месяца владелицы (D11);
 *    расходы владелицы берутся за месяцы, которые попадают в период;
 *  - брак, замены, недостачи и изъятия в прибыль не входят, показываются отдельно.
 */
var Summary = (function () {
  'use strict';

  var C = typeof Calc !== 'undefined' ? Calc : require('./calc.js');
  var O = typeof Ops !== 'undefined' ? Ops : require('./ops.js');

  function sum(arr, f) { return arr.reduce(function (a, x) { return a + f(x); }, 0); }
  function months(from, to) {
    var out = [];
    var y = Number(from.slice(0, 4));
    var m = Number(from.slice(5, 7));
    var end = to.slice(0, 7);
    for (var guard = 0; guard < 240; guard++) {
      var key = y + '-' + (m < 10 ? '0' : '') + m;
      if (key > end) break;
      out.push(key);
      m += 1;
      if (m === 13) { m = 1; y += 1; }
    }
    return out;
  }

  /** Остатки на начало дня date (по журналу движений до этой даты). */
  function stockAt(view, dateExclusive) {
    var moves = view.rows('stock_moves').filter(function (m) { return String(m.created_at).slice(0, 10) < dateExclusive; });
    return C.stockBalance(moves);
  }
  function stockValue(view, balance) {
    return Object.keys(balance).reduce(function (a, id) {
      var it = view.item(id);
      return a + Math.max(0, balance[id]) * (it ? it.last_cost : 0);
    }, 0);
  }

  function period(view, from, to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      throw O.opsError('BAD_INPUT', 'Период: даты ГГГГ-ММ-ДД, начало не позже конца');
    }
    var shifts = view.rows('shifts').filter(function (s) { return s.shift_date >= from && s.shift_date <= to; })
      .sort(function (a, b) { return a.shift_no - b.shift_no; });
    var ids = {};
    shifts.forEach(function (s) { ids[s.shift_id] = true; });
    var reports = shifts.map(function (s) { return O.shiftReport(view, s.shift_id); });

    var revenue = sum(reports, function (r) { return r.revenue; });
    var receipts = sum(reports, function (r) { return r.receipts_count; });

    // Деньги: все платежи смен периода (включая погашения и доплаты) минус возвраты.
    var cancelled = {};
    view.rows('receipts').forEach(function (r) { if (r.status === 'cancelled') cancelled[r.receipt_id] = true; });
    // Платежи вне смены (владелица вернула аванс на карту, D24) — по дате записи.
    var inPeriod = function (p) {
      if (p.shift_id) return !!ids[p.shift_id];
      var d = String(p.created_at).slice(0, 10);
      return d >= from && d <= to;
    };
    var pays = view.rows('payments').filter(function (p) {
      return inPeriod(p) && !(p.receipt_id && cancelled[p.receipt_id] && p.kind !== 'refund');
    });
    var money = function (method) {
      return sum(pays.filter(function (p) { return p.method === method; }), function (p) { return p.kind === 'refund' ? -p.amount : p.amount; });
    };
    var refunds = sum(pays.filter(function (p) { return p.kind === 'refund'; }), function (p) { return p.amount; });

    // Закупки по поставщикам.
    var income = view.rows('stock_moves').filter(function (m) { return m.type === 'income' && ids[m.shift_id]; });
    var bySupplier = {};
    income.forEach(function (m) { bySupplier[m.supplier_or_reason] = (bySupplier[m.supplier_or_reason] || 0) + (m.cost_sum || 0); });
    var purchases = sum(income, function (m) { return m.cost_sum || 0; });

    // ЗП по флористам.
    var pay = {};
    reports.forEach(function (r) {
      r.payroll.forEach(function (p) {
        var x = pay[p.staff_id] || (pay[p.staff_id] = { staff_id: p.staff_id, shifts: 0, rate: 0, pct: 0, total: 0 });
        x.shifts += 1; x.rate += p.rate; x.pct += p.pct; x.total += p.total;
      });
    });
    var payrollList = Object.keys(pay).map(function (k) { return pay[k]; });
    var payroll = sum(payrollList, function (p) { return p.total; });

    var delivery = sum(reports, function (r) { return r.delivery; });
    var other = sum(reports, function (r) { return r.other; });
    var withdrawal = sum(reports, function (r) { return r.withdrawal; });
    var monthsIn = months(from, to);
    var ownerRows = view.rows('owner_expenses').filter(function (e) { return monthsIn.indexOf(e.month) >= 0; });
    var ownerByItem = {};
    ownerRows.forEach(function (e) { ownerByItem[e.item] = (ownerByItem[e.item] || 0) + e.amount; });
    var ownerTotal = sum(ownerRows, function (e) { return e.amount; });

    var profit = C.monthProfit({ revenue: revenue, refunds: refunds, purchases: purchases, payroll: payroll,
      delivery: delivery, other: other, owner_expenses: ownerTotal });

    // Потери.
    var defects = sum(reports, function (r) { return sum(r.defects, function (d) { return d.cost; }); });
    var replaces = view.rows('stock_moves').filter(function (m) { return m.type === 'replace' && ids[m.shift_id]; });
    var replaceCost = sum(replaces, function (m) { return typeof m.cost_sum === 'number' ? m.cost_sum : 0; });
    var shortage = sum(reports, function (r) { return sum(r.adjustments.filter(function (a) { return a.qty < 0; }), function (a) { return a.cost; }); });
    var cashDiff = sum(shifts.filter(function (s) { return s.status === 'closed'; }), function (s) { return s.cash_diff || 0; });

    // Скидки по флористам (кто оформил чек).
    var discBy = {};
    view.rows('receipts').filter(function (r) { return ids[r.shift_id] && r.status !== 'cancelled' && r.discount_amount; })
      .forEach(function (r) { discBy[r.created_by] = (discBy[r.created_by] || 0) + r.discount_amount; });
    var discounts = sum(reports, function (r) { return r.discounts; });

    // Не получено: долги (старше 30 дней — по дате самого старого долга) и предзаказы к доплате.
    var today = view.ctx.now.slice(0, 10);
    var cut = new Date(Date.parse(today + 'T00:00:00Z') - 30 * 86400000).toISOString().slice(0, 10);
    var debtTotal = 0;
    var debtOld = 0;
    view.rows('customers').forEach(function (c) {
      var d = view.debtOf(c.customer_id);
      if (d <= 0) return;
      debtTotal += d;
      var since = view.rows('debt_moves').filter(function (m) { return m.customer_id === c.customer_id && m.amount > 0; })
        .map(function (m) { return m.since_date || String(m.created_at).slice(0, 10); }).sort()[0];
      if (since && since < cut) debtOld += d;
    });
    var allPays = view.rows('payments');
    var allDebt = view.rows('debt_moves');
    var preorderDue = sum(view.rows('receipts').filter(function (r) {
      return r.type === 'preorder' && r.status === 'posted' && (r.assembly_status === 'waiting' || r.assembly_status === 'assembled');
    }), function (r) {
      var paid = sum(allPays.filter(function (p) { return p.receipt_id === r.receipt_id; }), function (p) { return p.kind === 'refund' ? -p.amount : p.amount; });
      var debt = sum(allDebt.filter(function (m) { return m.receipt_id === r.receipt_id; }), function (m) { return m.amount; });
      return Math.max(0, r.total - paid - debt);
    });

    var next = new Date(Date.parse(to + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    return {
      from: from, to: to, shifts: shifts.length, receipts: receipts, revenue: revenue,
      avg_check: receipts ? C.roundDiv(revenue, receipts) : 0,
      cash: money('cash'), card: money('card'),
      purchases: purchases, by_supplier: bySupplier,
      payroll: payroll, payroll_by: payrollList,
      delivery: delivery, other: other, refunds: refunds,
      owner_expenses: ownerTotal, owner_by_item: ownerByItem,
      profit: profit,
      losses: { defects: defects, replaces: replaceCost, shortage: shortage, cash_diff: cashDiff },
      discounts: discounts, discounts_by: discBy, withdrawal: withdrawal,
      stock_value_start: stockValue(view, stockAt(view, from)),
      stock_value_end: stockValue(view, stockAt(view, next)),
      not_received: { debts: debtTotal, debts_old: debtOld, preorders: preorderDue },
      corrected_shifts: reports.filter(function (r) { return r.corrected; }).length
    };
  }

  /** Остатки на сейчас: ниже минимума первыми, по категориям. */
  function stock(view) {
    var bal = {};
    view.balance().forEach(function (b) { bal[b.item_id] = b.qty; });
    var items = view.rows('catalog').filter(function (c) { return c.status !== 'hidden'; }).map(function (c) {
      return { item_id: c.item_id, name: c.name, category: c.category, qty: bal[c.item_id] || 0, min: c.min_stock };
    });
    return {
      below: items.filter(function (i) { return i.qty < i.min; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }),
      items: items.sort(function (a, b) { return a.name < b.name ? -1 : 1; })
    };
  }

  /** Должники: имя, пометка, долг, дата самой старой покупки в долг. */
  function debtors(view) {
    return view.rows('customers').map(function (c) {
      var d = view.debtOf(c.customer_id);
      var since = view.rows('debt_moves').filter(function (m) { return m.customer_id === c.customer_id && m.amount > 0; })
        .map(function (m) { return m.since_date || String(m.created_at).slice(0, 10); }).sort()[0] || '';
      return { name: c.name, note: c.note, debt: d, since: since };
    }).filter(function (x) { return x.debt > 0; }).sort(function (a, b) { return b.debt - a.debt; });
  }

  return { period: period, stock: stock, debtors: debtors, months: months };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Summary;
