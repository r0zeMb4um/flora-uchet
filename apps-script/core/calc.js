/**
 * Флора·Учёт — ядро расчётов.
 *
 * Чистые функции без Google API: работают в Apps Script, в Node (тесты) и в браузере (Mini App).
 * Источник правил: docs/TZ.md (раздел «Формулы») + docs/DECISIONS.md.
 *
 * Жёсткие правила:
 *  - все суммы — целые тенге, проценты — сотые доли процента целым числом (3% = 300);
 *  - округление одно на всю систему: «0,5 вверх», целочисленно — roundDiv();
 *  - отменённые чеки нигде не учитываются.
 */
var Calc = (function () {
  'use strict';

  // ---------- ошибки и проверки ----------

  function calcError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /** Целое число без потери точности (не дробь, не NaN, в пределах ±9e15). */
  function assertInt(value, name) {
    if (!Number.isSafeInteger(value)) {
      throw calcError('NOT_INTEGER', 'Поле «' + name + '» должно быть целым числом, получено: ' + value);
    }
    return value;
  }

  function assertNonNegative(value, name) {
    assertInt(value, name);
    if (value < 0) throw calcError('NEGATIVE', 'Поле «' + name + '» не может быть меньше нуля: ' + value);
    return value;
  }

  function assertPositive(value, name) {
    assertInt(value, name);
    if (value <= 0) throw calcError('NOT_POSITIVE', 'Поле «' + name + '» должно быть больше нуля: ' + value);
    return value;
  }

  function sum(list, pick) {
    var total = 0;
    for (var i = 0; i < list.length; i++) total += pick ? pick(list[i]) : list[i];
    return assertInt(total, 'сумма');
  }

  // ---------- 0. Округление ----------

  /**
   * round(a / b) по математике: 0,5 и больше — вверх.
   * Только целые неотрицательные a и положительные b. Без дробей: floor((2a + b) / (2b)).
   */
  function roundDiv(a, b) {
    assertNonNegative(a, 'делимое');
    assertPositive(b, 'делитель');
    var num = 2 * a + b;
    var den = 2 * b;
    assertInt(num, 'промежуточный результат');
    assertInt(den, 'промежуточный результат');
    return Math.floor(num / den);
  }

  // ---------- 1. Чек ----------

  /**
   * Скидка в тенге.
   * discount: { kind: 'none' } | { kind: 'amount', value: ₸ } | { kind: 'pct', value: сотые доли % }
   */
  function discountAmount(price, discount) {
    assertPositive(price, 'цена');
    var d = discount || { kind: 'none' };
    var amount;
    if (d.kind === 'none') {
      amount = 0;
    } else if (d.kind === 'amount') {
      amount = assertNonNegative(d.value, 'скидка, ₸');
    } else if (d.kind === 'pct') {
      assertNonNegative(d.value, 'скидка, %');
      if (d.value > 10000) throw calcError('DISCOUNT_TOO_BIG', 'Скидка не может быть больше 100%');
      amount = roundDiv(price * d.value, 10000);
    } else {
      throw calcError('BAD_DISCOUNT', 'Неизвестный вид скидки: ' + d.kind);
    }
    if (amount > price) throw calcError('DISCOUNT_TOO_BIG', 'Скидка больше цены');
    return amount;
  }

  /** Итог чека. Итого должно быть больше нуля (решение D6: подарок — это списание, а не чек). */
  function receiptTotal(price, discount) {
    var disc = discountAmount(price, discount);
    var total = price - disc;
    if (total <= 0) {
      throw calcError('ZERO_TOTAL', 'Итого чека должно быть больше нуля. Подарок оформляется списанием с причиной «подарок»');
    }
    return { price: price, discount_amount: disc, total: total };
  }

  /**
   * Проверка чека: оплаты + в долг + неоплаченный остаток предзаказа = итого.
   * payments: [{ method: 'cash'|'card', amount }]
   */
  function checkReceiptBalance(total, payments, debtAmount, preorderUnpaid) {
    assertPositive(total, 'итого');
    var paid = 0;
    for (var i = 0; i < payments.length; i++) paid += assertPositive(payments[i].amount, 'оплата');
    var debt = assertNonNegative(debtAmount || 0, 'в долг');
    var unpaid = assertNonNegative(preorderUnpaid || 0, 'остаток предзаказа');
    if (paid + debt + unpaid !== total) {
      throw calcError('BALANCE_MISMATCH',
        'Сумма оплат не сходится с итого: оплачено ' + paid + ' + в долг ' + debt +
        ' + остаток предзаказа ' + unpaid + ' ≠ ' + total);
    }
    return true;
  }

  // ---------- 2. Выручка смены и зарплата ----------

  function isActiveReceipt(r) {
    return r.status !== 'cancelled';
  }

  /**
   * Выручка смены = сумма «итого» всех неотменённых чеков, оформленных в смену.
   * receipts: [{ total, discount_amount?, status? }]
   */
  function shiftRevenue(receipts) {
    var active = receipts.filter(isActiveReceipt);
    var revenue = sum(active, function (r) { return assertPositive(r.total, 'итого чека'); });
    return {
      revenue: revenue,
      receipts_count: active.length,
      avg_check: active.length ? roundDiv(revenue, active.length) : 0,
      discounts_total: sum(active, function (r) { return r.discount_amount || 0; }),
      cancelled_count: receipts.length - active.length
    };
  }

  /** % флориста = round(выручка × % / (10 000 × N)) — деление пополам и процент одной формулой. */
  function floristPct(revenue, pctBp, floristsCount) {
    assertNonNegative(revenue, 'выручка');
    assertNonNegative(pctBp, 'процент');
    if (pctBp > 10000) throw calcError('PCT_TOO_BIG', 'Процент флориста не может быть больше 100%');
    if (floristsCount !== 1 && floristsCount !== 2) {
      throw calcError('BAD_FLORISTS_COUNT', 'В смене может быть 1 или 2 флориста, получено: ' + floristsCount);
    }
    return roundDiv(revenue * pctBp, 10000 * floristsCount);
  }

  /**
   * Зарплата смены по условиям на момент открытия (shift_staff, решение D3).
   * shiftStaff: [{ staff_id, shift_rate, pct_bp }]
   */
  function payroll(revenue, shiftStaff) {
    var n = shiftStaff.length;
    if (n !== 1 && n !== 2) {
      throw calcError('BAD_FLORISTS_COUNT', 'В смене может быть 1 или 2 флориста, получено: ' + n);
    }
    var each = {};
    var total = 0;
    for (var i = 0; i < n; i++) {
      var s = shiftStaff[i];
      if (each[s.staff_id]) throw calcError('DUPLICATE_STAFF', 'Флорист указан в смене дважды: ' + s.staff_id);
      var rate = assertNonNegative(s.shift_rate, 'ставка');
      var pct = floristPct(revenue, s.pct_bp, n);
      each[s.staff_id] = { rate: rate, pct: pct, total: rate + pct };
      total += rate + pct;
    }
    return { each: each, total: total };
  }

  // ---------- 3. Касса ----------

  var PAYMENT_IN = { sale: true, advance: true, topup: true, debt_repay: true };
  // Расходы из кассы, которые идут в «расчёт кассы» (до пересчёта).
  var CASH_OUT_BEFORE_COUNT = { delivery: true, other: true, withdrawal_day: true };
  // Выдаются после пересчёта и в расчёт не входят.
  var CASH_OUT_AFTER_COUNT = { rate: true, pct: true, pay_adjust: true, withdrawal_close: true };

  var PAYMENT_METHODS = { cash: true, card: true };

  function splitPayments(payments, method) {
    var inSum = 0;
    var refundSum = 0;
    for (var i = 0; i < payments.length; i++) {
      var p = payments[i];
      if (!PAYMENT_METHODS[p.method]) {
        throw calcError('BAD_PAYMENT_METHOD', 'Неизвестный способ оплаты: ' + p.method + ' (только cash или card)');
      }
      if (p.method !== method) continue;
      assertPositive(p.amount, 'платёж');
      if (p.kind === 'refund') refundSum += p.amount;
      else if (PAYMENT_IN[p.kind]) inSum += p.amount;
      else throw calcError('BAD_PAYMENT_KIND', 'Неизвестный вид платежа: ' + p.kind);
    }
    return { in: inSum, refund: refundSum };
  }

  /**
   * Расчёт кассы = наличные на начало + оплаты наличными − возвраты наличными
   *              − доставки − прочие расходы − изъятия в течение смены.
   * Аренды в смене нет (решение D11). ЗП и изъятие при закрытии — после пересчёта.
   * payments: [{ kind, method, amount }] — только неотменённые; cashOps: [{ type, amount }]
   */
  function cashCalc(openCash, payments, cashOps) {
    assertNonNegative(openCash, 'наличные на начало');
    var cash = splitPayments(payments, 'cash');
    var out = 0;
    for (var i = 0; i < cashOps.length; i++) {
      var op = cashOps[i];
      assertPositive(op.amount, 'расход из кассы');
      if (CASH_OUT_BEFORE_COUNT[op.type]) out += op.amount;
      else if (!CASH_OUT_AFTER_COUNT[op.type]) throw calcError('BAD_CASH_OP', 'Неизвестный тип расхода: ' + op.type);
    }
    return openCash + cash.in - cash.refund - out;
  }

  /** Безнал за смену для сверки с Kaspi = оплаты безналом − возвраты безналом. */
  function cardTotal(payments) {
    var card = splitPayments(payments, 'card');
    return card.in - card.refund;
  }

  /** Расхождение при приёме смены = принято − оставлено прошлой сменой. */
  function openDiff(openCash, prevNextCash) {
    return assertNonNegative(openCash, 'принято') - assertNonNegative(prevNextCash, 'остаток прошлой смены');
  }

  /**
   * Закрытие смены после пересчёта вслепую.
   * Возвращает расхождение, подсказку «можно забрать сверх размена» и остаток на следующую смену.
   */
  function closeShift(p) {
    var counted = assertNonNegative(p.counted, 'пересчёт');
    var calc = assertInt(p.calc_cash, 'расчёт кассы');
    var pay = assertNonNegative(p.payroll_total, 'ЗП');
    var fund = assertNonNegative(p.change_fund, 'размен');
    var withdrawal = assertNonNegative(p.close_withdrawal || 0, 'изъятие при закрытии');

    if (pay > counted) {
      throw calcError('NOT_ENOUGH_FOR_PAYROLL', 'В кассе ' + counted + ' ₸, а зарплата ' + pay + ' ₸ — не хватает денег');
    }
    var nextCash = counted - pay - withdrawal;
    if (nextCash < 0) {
      throw calcError('WITHDRAWAL_TOO_BIG', 'Нельзя забрать больше, чем осталось в кассе после зарплаты: ' + (counted - pay) + ' ₸');
    }
    return {
      cash_diff: counted - calc,
      can_take_above_change_fund: Math.max(0, counted - pay - fund),
      next_cash: nextCash
    };
  }

  // ---------- 4. Склад ----------

  /** Остатки по позициям = сумма движений со знаком. moves: [{ item_id, qty }] */
  function stockBalance(moves) {
    var bal = {};
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      assertInt(m.qty, 'количество');
      bal[m.item_id] = (bal[m.item_id] || 0) + m.qty;
    }
    return bal;
  }

  /** Нельзя продать или списать больше остатка. need: { item_id: qty } */
  function checkStock(balance, need) {
    var short = [];
    Object.keys(need).forEach(function (id) {
      var q = assertPositive(need[id], 'количество');
      var have = balance[id] || 0;
      if (q > have) short.push({ item_id: id, need: q, have: have });
    });
    if (short.length) {
      var e = calcError('NOT_ENOUGH_STOCK', 'Не хватает на складе — сначала внесите приход');
      e.details = short;
      throw e;
    }
    return true;
  }

  /** Закупочная цена за штуку = round(сумма по строке прихода / количество). */
  function unitCost(costSum, qty) {
    return roundDiv(assertNonNegative(costSum, 'сумма по накладной'), assertPositive(qty, 'количество'));
  }

  /** Стоимость брака, замен, недостач = количество × последняя закупочная цена (всегда ≥ 0). */
  function lossCost(qty, lastCost) {
    assertInt(qty, 'количество');
    return assertInt(Math.abs(qty) * assertNonNegative(lastCost, 'закупочная цена'), 'стоимость');
  }

  /** Корректировки инвентаризации = факт − расчёт (только ненулевые). */
  function inventoryAdjust(balance, facts) {
    var adj = {};
    Object.keys(facts).forEach(function (id) {
      var diff = assertNonNegative(facts[id], 'факт') - (balance[id] || 0);
      if (diff !== 0) adj[id] = diff;
    });
    return adj;
  }

  /** Позиции ниже минимума. catalog: [{ item_id, min_stock }] */
  function belowMin(balance, catalog) {
    return catalog
      .filter(function (c) { return (balance[c.item_id] || 0) < c.min_stock; })
      .map(function (c) { return c.item_id; });
  }

  // ---------- Долги ----------

  /** Долг каждого покупателя = сумма его строк debt_moves (решение D4). */
  function customerDebts(debtMoves) {
    var debts = {};
    for (var i = 0; i < debtMoves.length; i++) {
      var m = debtMoves[i];
      assertInt(m.amount, 'сумма долга');
      debts[m.customer_id] = (debts[m.customer_id] || 0) + m.amount;
    }
    return debts;
  }

  /** Погашение не больше долга. */
  function checkRepay(currentDebt, amount) {
    assertPositive(amount, 'погашение');
    if (amount > currentDebt) {
      throw calcError('REPAY_TOO_BIG', 'Погашение ' + amount + ' ₸ больше долга ' + currentDebt + ' ₸');
    }
    return true;
  }

  /** Возврат денег не больше реально оплаченного по чеку (решение D13). */
  function checkRefund(paidByReceipt, refundedBefore, amount) {
    assertPositive(amount, 'возврат');
    var left = assertNonNegative(paidByReceipt, 'оплачено по чеку') - assertNonNegative(refundedBefore, 'уже возвращено');
    if (amount > left) {
      throw calcError('REFUND_TOO_BIG', 'По чеку можно вернуть не больше ' + Math.max(0, left) + ' ₸');
    }
    return true;
  }

  // ---------- 5. Месяц ----------

  /**
   * Прибыль = выручка − возвраты деньгами − закупки − ЗП − доставки − прочие расходы
   *         − постоянные расходы владелицы (аренда и т. п., решение D11).
   * Брак, замены, недостачи и изъятия в прибыль не входят.
   */
  function monthProfit(p) {
    var parts = ['revenue', 'refunds', 'purchases', 'payroll', 'delivery', 'other', 'owner_expenses'];
    parts.forEach(function (k) { assertInt(p[k] || 0, k); });
    return (p.revenue || 0) - (p.refunds || 0) - (p.purchases || 0) - (p.payroll || 0)
      - (p.delivery || 0) - (p.other || 0) - (p.owner_expenses || 0);
  }

  return {
    calcError: calcError,
    roundDiv: roundDiv,
    discountAmount: discountAmount,
    receiptTotal: receiptTotal,
    checkReceiptBalance: checkReceiptBalance,
    shiftRevenue: shiftRevenue,
    floristPct: floristPct,
    payroll: payroll,
    cashCalc: cashCalc,
    cardTotal: cardTotal,
    openDiff: openDiff,
    closeShift: closeShift,
    stockBalance: stockBalance,
    checkStock: checkStock,
    unitCost: unitCost,
    lossCost: lossCost,
    inventoryAdjust: inventoryAdjust,
    belowMin: belowMin,
    customerDebts: customerDebts,
    checkRepay: checkRepay,
    checkRefund: checkRefund,
    monthProfit: monthProfit
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
