/**
 * Флора·Учёт — логика операций.
 *
 * Каждая операция: проверка → ПЛАН ЗАПИСИ (какие строки дописать, какие поля поменять,
 * остатки каких позиций пересчитать, что ответить, кого уведомить). Сама ничего не пишет.
 * Хранилище не знает: читает только через «вид» (makeView), который показывает лишь
 * проведённые операции (ops_log.status = posted). Записывает план core/posting.js.
 *
 * Правила: docs/TZ.md + docs/DECISIONS.md. Формулы — только из core/calc.js.
 */
var Ops = (function () {
  'use strict';

  var C = typeof Calc !== 'undefined' ? Calc : require('./calc.js');

  function opsError(code, message, details) {
    var e = new Error(message);
    e.code = code;
    if (details) e.details = details;
    return e;
  }

  // Листы, где у строки есть точка (point_id). Остальные — общие на клиента.
  var POINT_SHEETS = {
    shifts: true, shift_staff: true, receipts: true, payments: true, stock_moves: true,
    cash_ops: true, debt_moves: true, reservations: true, owner_expenses: true
  };
  var CATEGORIES = ['flowers', 'greens', 'toys', 'baskets', 'packaging'];
  var DEFECT_REASONS = ['arrived_bad', 'wilted', 'broken', 'gift', 'other'];

  // ---------- вид: только проведённые данные своего клиента и точки ----------

  function makeView(store, ctx) {
    var posted = {};
    store.rows('ops_log').forEach(function (o) {
      if (o.status === 'posted') posted[o.op_id] = true;
    });
    function rows(sheet) {
      return store.rows(sheet).filter(function (r) {
        if (!posted[r.op_id] || r.client_id !== ctx.client_id) return false;
        return !POINT_SHEETS[sheet] && sheet !== 'staff' && sheet !== 'settings' ? true : r.point_id === ctx.point_id;
      });
    }
    function stock(itemId) {
      var row = store.rows('stock_balance').filter(function (b) {
        return b.client_id === ctx.client_id && b.point_id === ctx.point_id && b.item_id === itemId;
      })[0];
      return row ? row.qty : 0;
    }
    return {
      ctx: ctx,
      rows: rows,
      stock: stock,
      balance: function () {
        return store.rows('stock_balance').filter(function (b) {
          return b.client_id === ctx.client_id && b.point_id === ctx.point_id;
        });
      },
      openShift: function () {
        return rows('shifts').filter(function (s) { return s.status === 'open'; })[0] || null;
      },
      settings: function () {
        var s = rows('settings')[0];
        if (!s) throw opsError('NO_SETTINGS', 'Нет настроек точки');
        return s;
      },
      receipt: function (id) { return rows('receipts').filter(function (r) { return r.receipt_id === id; })[0] || null; },
      item: function (id) { return rows('catalog').filter(function (c) { return c.item_id === id; })[0] || null; },
      customer: function (id) { return rows('customers').filter(function (c) { return c.customer_id === id; })[0] || null; },
      staff: function (id) { return rows('staff').filter(function (s) { return s.staff_id === id; })[0] || null; },
      shiftStaff: function (shiftId) { return rows('shift_staff').filter(function (s) { return s.shift_id === shiftId; }); },
      debtOf: function (customerId) {
        return rows('debt_moves').filter(function (m) { return m.customer_id === customerId; })
          .reduce(function (a, m) { return a + m.amount; }, 0);
      }
    };
  }

  // ---------- проверки ввода ----------

  function text(v, name, max) {
    if (typeof v !== 'string' || !v.trim()) throw opsError('BAD_INPUT', 'Заполните поле «' + name + '»');
    v = v.trim();
    if (v.length > (max || 100)) throw opsError('BAD_INPUT', 'Поле «' + name + '» длиннее ' + (max || 100) + ' символов');
    return v;
  }
  function optText(v, name, max) { return v == null || v === '' ? '' : text(v, name, max); }
  function posInt(v, name) {
    if (!Number.isSafeInteger(v) || v <= 0) throw opsError('BAD_INPUT', 'Поле «' + name + '» — целое число больше нуля');
    return v;
  }
  function nonNegInt(v, name) {
    if (!Number.isSafeInteger(v) || v < 0) throw opsError('BAD_INPUT', 'Поле «' + name + '» — целое число не меньше нуля');
    return v;
  }
  function dateStr(v, name) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw opsError('BAD_INPUT', 'Поле «' + name + '» — дата ГГГГ-ММ-ДД');
    return v;
  }
  function oneOf(v, list, name) {
    if (list.indexOf(v) < 0) throw opsError('BAD_INPUT', 'Поле «' + name + '»: недопустимое значение ' + v);
    return v;
  }
  function list(v, name) {
    if (!Array.isArray(v) || !v.length) throw opsError('BAD_INPUT', 'Список «' + name + '» пуст');
    return v;
  }
  function payments(v) {
    return (v || []).map(function (p) {
      return { method: oneOf(p.method, ['cash', 'card'], 'способ оплаты'), amount: posInt(p.amount, 'оплата') };
    });
  }
  function sumAmounts(arr) { return arr.reduce(function (a, p) { return a + p.amount; }, 0); }

  // ---------- план ----------

  function newPlan(view, kind, opId) {
    return {
      op_id: opId, kind: kind,
      client_id: view.ctx.client_id, point_id: view.ctx.point_id, shift_id: '',
      facts: {}, updates: [], stock_items: [], result: {}, notify: []
    };
  }

  function add(plan, view, sheet, row) {
    row.op_id = plan.op_id;
    row.client_id = plan.client_id;
    if (POINT_SHEETS[sheet]) row.point_id = plan.point_id;
    if (row.created_at === undefined) row.created_at = view.ctx.now;
    (plan.facts[sheet] = plan.facts[sheet] || []).push(row);
    return row;
  }

  function nextId(plan, prefix) {
    plan._n = (plan._n || 0) + 1;
    return prefix + '-' + plan.op_id + '-' + plan._n;
  }

  /** Изменение поля на месте (состояние). before — для отката зависшей операции. */
  function update(plan, sheet, match, row, set) {
    var before = {};
    Object.keys(set).forEach(function (k) { before[k] = row[k]; });
    plan.updates.push({ sheet: sheet, match: match, set: set, before: before });
  }

  function touchStock(plan, itemId) {
    if (plan.stock_items.indexOf(itemId) < 0) plan.stock_items.push(itemId);
  }

  // ---------- общие шаги ----------

  function requireOwner(view) {
    if (view.ctx.role !== 'owner' && view.ctx.role !== 'admin') throw opsError('FORBIDDEN', 'Это может сделать только владелица');
  }

  /** Открытая смена, и пишущий в ней работает. */
  function requireShift(view, plan) {
    var shift = view.openShift();
    if (!shift) throw opsError('NO_OPEN_SHIFT', 'Смена не открыта — сначала нажмите «Открыть смену»');
    var onShift = view.shiftStaff(shift.shift_id).some(function (s) { return s.staff_id === view.ctx.staff_id; });
    if (!onShift) throw opsError('NOT_ON_SHIFT', 'Вы не работаете в открытой смене');
    var me = view.staff(view.ctx.staff_id);
    if (!me || me.active !== true) throw opsError('FORBIDDEN', 'Доступ отключён владелицей');
    plan.shift_id = shift.shift_id;
    return shift;
  }

  function activeItem(view, id, allowHidden) {
    var it = view.item(id);
    if (!it || (it.status === 'hidden' && !allowHidden)) throw opsError('UNKNOWN_ITEM', 'Нет такой позиции в каталоге: ' + id);
    return it;
  }

  /** Покупатель: существующий { customer_id } или новый { new_customer: { name, note } }. */
  function customerRef(view, plan, ref) {
    if (!ref) throw opsError('BAD_INPUT', 'Укажите покупателя');
    if (ref.customer_id) {
      var c = view.customer(ref.customer_id);
      if (!c || c.anonymized === true) throw opsError('UNKNOWN_CUSTOMER', 'Нет такого покупателя');
      return c.customer_id;
    }
    var n = ref.new_customer || {};
    var name = text(n.name, 'имя покупателя', 60);
    var same = view.rows('customers').filter(function (c) {
      return c.anonymized !== true && String(c.name).toLowerCase() === name.toLowerCase();
    }).map(function (c) { return { customer_id: c.customer_id, name: c.name, note: c.note }; });
    if (same.length && n.confirm_new !== true) {
      throw opsError('SIMILAR_CUSTOMERS', 'Покупатель с таким именем уже есть — выберите его или подтвердите нового', same);
    }
    var row = add(plan, view, 'customers', {
      customer_id: nextId(plan, 'cu'),
      name: name,
      note: optText(n.note, 'пометка', 100),
      phone: '', phone_consent_at: '', anonymized: false // телефоны на этапе 1 не храним
    });
    return row.customer_id;
  }

  /** Списание/движение товара со знаком; при списании — проверка остатка. */
  function moveStock(plan, view, lines, type, opts) {
    opts = opts || {};
    var need = {};
    lines.forEach(function (l) {
      activeItem(view, l.item_id, opts.allowHidden);
      posInt(l.qty, 'количество');
      need[l.item_id] = (need[l.item_id] || 0) + l.qty;
    });
    if (opts.sign < 0) {
      var bal = {};
      Object.keys(need).forEach(function (id) { bal[id] = view.stock(id); });
      C.checkStock(bal, need);
    }
    lines.forEach(function (l) {
      add(plan, view, 'stock_moves', {
        move_id: nextId(plan, 'mv'), shift_id: plan.shift_id, type: type, item_id: l.item_id,
        qty: opts.sign * l.qty, cost_sum: l.cost_sum == null ? '' : l.cost_sum,
        supplier_or_reason: l.reason || opts.reason || '', receipt_id: opts.receipt_id || ''
      });
      touchStock(plan, l.item_id);
    });
  }

  function receiptNo(view, shiftId) {
    return view.rows('receipts').filter(function (r) { return r.shift_id === shiftId; }).length + 1;
  }

  function addPayments(plan, view, list, kind, receiptId, customerId) {
    list.forEach(function (p) {
      add(plan, view, 'payments', {
        payment_id: nextId(plan, 'pay'), shift_id: plan.shift_id, receipt_id: receiptId || '',
        customer_id: customerId || '', kind: kind, method: p.method, amount: p.amount
      });
    });
  }

  /** Сколько реально оплачено по чеку (все смены) и сколько уже возвращено. */
  function receiptMoney(view, receiptId) {
    var paid = 0;
    var refunded = 0;
    view.rows('payments').forEach(function (p) {
      if (p.receipt_id !== receiptId) return;
      if (p.kind === 'refund') refunded += p.amount;
      else paid += p.amount;
    });
    var debt = view.rows('debt_moves').filter(function (m) { return m.receipt_id === receiptId; })
      .reduce(function (a, m) { return a + m.amount; }, 0);
    return { paid: paid, refunded: refunded, debt: debt };
  }

  // ---------- операции ----------

  var H = {};

  H.open_shift = function (view, p, plan) {
    if (view.openShift()) throw opsError('SHIFT_ALREADY_OPEN', 'Прошлая смена не закрыта — сначала закройте её');
    var ids = list(p.florist_ids, 'флористы');
    if (ids.length > 2 || ids[0] === ids[1]) throw opsError('BAD_INPUT', 'В смене 1 или 2 разных флориста');
    if (ids.indexOf(view.ctx.staff_id) < 0) throw opsError('NOT_ON_SHIFT', 'Открывающий смену должен быть в её составе');
    var staff = ids.map(function (id) {
      var s = view.staff(id);
      if (!s || s.active !== true || s.role !== 'florist') throw opsError('UNKNOWN_STAFF', 'Нет активного флориста: ' + id);
      return s;
    });
    var shifts = view.rows('shifts');
    var closed = shifts.filter(function (s) { return s.status === 'closed'; })
      .sort(function (a, b) { return a.closed_at < b.closed_at ? -1 : 1; });
    var prev = closed.length ? closed[closed.length - 1].next_cash : 0;
    var openCash = nonNegInt(p.open_cash, 'наличные на начало');
    var diff = C.openDiff(openCash, prev);
    var shiftId = 'sh-' + plan.op_id;
    plan.shift_id = shiftId;
    add(plan, view, 'shifts', {
      shift_id: shiftId, shift_no: shifts.length + 1, shift_date: view.ctx.now.slice(0, 10),
      florist_ids: ids.join(','), opened_at: view.ctx.now, closed_at: '',
      prev_next_cash: prev, open_cash: openCash, open_diff: diff,
      calc_cash: '', counted_cash: '', cash_diff: '', payroll_total: '', payroll_unpaid: '',
      close_withdrawal: '', next_cash: '', status: 'open'
    });
    staff.forEach(function (s) {
      add(plan, view, 'shift_staff', { shift_id: shiftId, staff_id: s.staff_id, shift_rate: s.shift_rate, pct_bp: s.pct_bp });
    });
    if (diff !== 0) plan.notify.push({ to: 'owner', kind: 'open_diff', shift_id: shiftId, open_diff: diff });
    plan.result = { shift_id: shiftId, shift_no: shifts.length + 1, prev_next_cash: prev, open_diff: diff };
  };

  function saleLike(type) {
    return function (view, p, plan) {
      var shift = requireShift(view, plan);
      var items = list(p.items, 'позиции');
      var r = C.receiptTotal(p.price, p.discount);
      var pays = payments(p.payments);
      var paid = sumAmounts(pays);
      var debt = 0;
      var customerId = '';
      if (p.debt_customer) {
        debt = r.total - paid;
        if (debt <= 0) throw opsError('BAD_INPUT', 'В долг нечего записывать: чек оплачен полностью');
        customerId = customerRef(view, plan, p.debt_customer);
      }
      C.checkReceiptBalance(r.total, pays, debt, 0);
      var receiptId = 'rc-' + plan.op_id;
      add(plan, view, 'receipts', {
        receipt_id: receiptId, receipt_no: receiptNo(view, shift.shift_id), shift_id: shift.shift_id, type: type,
        price: r.price, discount_kind: (p.discount && p.discount.kind) || 'none',
        discount_value: (p.discount && p.discount.value) || 0, discount_amount: r.discount_amount,
        total: r.total, debt_amount: debt, customer_id: customerId, pickup_date: '', assembly_status: '',
        status: 'posted', reservation_id: '', created_by: view.ctx.staff_id
      });
      addPayments(plan, view, pays, 'sale', receiptId);
      if (debt) {
        add(plan, view, 'debt_moves', {
          debt_move_id: nextId(plan, 'dm'), shift_id: shift.shift_id, customer_id: customerId,
          type: 'sale', amount: debt, receipt_id: receiptId, since_date: '', comment: ''
        });
      }
      moveStock(plan, view, items, 'sale', { sign: -1, receipt_id: receiptId });
      plan.result = { receipt_id: receiptId, total: r.total, debt: debt };
    };
  }
  H.sale = saleLike('sale');
  H.bouquet = saleLike('bouquet');

  H.preorder = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var src = p;
    var customerId;
    var reservation = null;
    if (p.reservation_id) {
      reservation = view.rows('reservations').filter(function (r) { return r.reservation_id === p.reservation_id; })[0];
      if (!reservation || reservation.status !== 'active') throw opsError('BAD_RESERVATION', 'Бронь не найдена или уже не активна');
      src = { price: reservation.price, discount: { kind: reservation.discount_kind, value: reservation.discount_value }, pickup_date: reservation.pickup_date };
      customerId = reservation.customer_id;
    } else {
      customerId = customerRef(view, plan, p.customer);
    }
    var r = C.receiptTotal(src.price, src.discount);
    var pickup = dateStr(src.pickup_date, 'дата выдачи');
    var pays = payments(p.payments);
    var paid = sumAmounts(pays);
    if (paid <= 0) throw opsError('NO_ADVANCE', 'Предзаказ без аванса оформляется как бронь');
    if (paid > r.total) throw opsError('BALANCE_MISMATCH', 'Аванс больше суммы заказа');
    C.checkReceiptBalance(r.total, pays, 0, r.total - paid);
    var receiptId = 'rc-' + plan.op_id;
    add(plan, view, 'receipts', {
      receipt_id: receiptId, receipt_no: receiptNo(view, shift.shift_id), shift_id: shift.shift_id, type: 'preorder',
      price: r.price, discount_kind: (src.discount && src.discount.kind) || 'none',
      discount_value: (src.discount && src.discount.value) || 0, discount_amount: r.discount_amount,
      total: r.total, debt_amount: 0, customer_id: customerId, pickup_date: pickup, assembly_status: 'waiting',
      status: 'posted', reservation_id: reservation ? reservation.reservation_id : '', created_by: view.ctx.staff_id
    });
    addPayments(plan, view, pays, 'advance', receiptId);
    if (reservation) {
      update(plan, 'reservations', { reservation_id: reservation.reservation_id }, reservation, { status: 'converted', receipt_id: receiptId });
    }
    plan.result = { receipt_id: receiptId, total: r.total, advance: paid, unpaid: r.total - paid };
  };

  H.reserve = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var r = C.receiptTotal(p.price, p.discount);
    var id = 'rs-' + plan.op_id;
    add(plan, view, 'reservations', {
      reservation_id: id, shift_id: shift.shift_id, customer_id: customerRef(view, plan, p.customer),
      pickup_date: dateStr(p.pickup_date, 'дата выдачи'), price: r.price,
      discount_kind: (p.discount && p.discount.kind) || 'none', discount_value: (p.discount && p.discount.value) || 0,
      discount_amount: r.discount_amount, total: r.total, status: 'active', receipt_id: '', created_by: view.ctx.staff_id
    });
    plan.result = { reservation_id: id, total: r.total };
  };

  H.reserve_cancel = function (view, p, plan) {
    if (view.ctx.role !== 'owner' && view.ctx.role !== 'admin') requireShift(view, plan);
    var res = view.rows('reservations').filter(function (r) { return r.reservation_id === p.reservation_id; })[0];
    if (!res || res.status !== 'active') throw opsError('BAD_RESERVATION', 'Бронь не найдена или уже не активна');
    update(plan, 'reservations', { reservation_id: res.reservation_id }, res, { status: 'cancelled' });
    plan.result = { reservation_id: res.reservation_id };
  };

  function preorderReceipt(view, id, assemblyStatus) {
    var r = view.receipt(id);
    if (!r || r.type !== 'preorder' || r.status !== 'posted') throw opsError('UNKNOWN_RECEIPT', 'Предзаказ не найден или отменён');
    if (r.assembly_status !== assemblyStatus) {
      throw opsError('BAD_STATE', assemblyStatus === 'waiting' ? 'Предзаказ уже собран' : 'Сначала соберите предзаказ');
    }
    return r;
  }

  H.preorder_assemble = function (view, p, plan) {
    requireShift(view, plan);
    var r = preorderReceipt(view, p.receipt_id, 'waiting');
    moveStock(plan, view, list(p.items, 'состав'), 'sale', { sign: -1, receipt_id: r.receipt_id });
    update(plan, 'receipts', { receipt_id: r.receipt_id }, r, { assembly_status: 'assembled' });
    plan.result = { receipt_id: r.receipt_id };
  };

  /** Выдача: остаток платится полностью или по явному выбору уходит в долг (D12). */
  H.preorder_pickup = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var r = preorderReceipt(view, p.receipt_id, 'assembled');
    var money = receiptMoney(view, r.receipt_id);
    var unpaid = r.total - (money.paid - money.refunded) - money.debt;
    var pays = payments(p.payments);
    var paid = sumAmounts(pays);
    var toDebt = p.to_debt === true ? unpaid - paid : 0;
    if (p.to_debt === true && toDebt <= 0) throw opsError('BAD_INPUT', 'В долг нечего записывать');
    if (paid + toDebt !== unpaid) {
      throw opsError('BALANCE_MISMATCH', 'К доплате ' + unpaid + ' ₸, внесено ' + paid + ' ₸. Остаток оплатите или запишите в долг');
    }
    addPayments(plan, view, pays, 'topup', r.receipt_id);
    if (toDebt) {
      add(plan, view, 'debt_moves', {
        debt_move_id: nextId(plan, 'dm'), shift_id: shift.shift_id, customer_id: r.customer_id,
        type: 'pickup', amount: toDebt, receipt_id: r.receipt_id, since_date: '', comment: ''
      });
    }
    update(plan, 'receipts', { receipt_id: r.receipt_id }, r, { assembly_status: 'picked_up' });
    plan.result = { receipt_id: r.receipt_id, paid: paid, to_debt: toDebt };
  };

  H.income = function (view, p, plan) {
    requireShift(view, plan);
    var lines = list(p.lines, 'строки прихода').map(function (l) {
      return { item_id: l.item_id, qty: posInt(l.qty, 'количество'), cost_sum: nonNegInt(l.cost_sum, 'сумма по накладной') };
    });
    var supplier = text(p.supplier, 'поставщик', 100);
    moveStock(plan, view, lines, 'income', { sign: 1, reason: supplier });
    var costs = {};
    lines.forEach(function (l) { costs[l.item_id] = C.unitCost(l.cost_sum, l.qty); });
    Object.keys(costs).forEach(function (id) {
      update(plan, 'catalog', { item_id: id, client_id: plan.client_id }, view.item(id), { last_cost: costs[id] });
    });
    plan.result = { total_cost: lines.reduce(function (a, l) { return a + l.cost_sum; }, 0), lines: lines.length };
  };

  H.new_item = function (view, p, plan) {
    var isOwner = view.ctx.role === 'owner' || view.ctx.role === 'admin';
    if (!isOwner) requireShift(view, plan);
    var name = text(p.name, 'название', 80);
    var words = name.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 2; });
    var similar = view.rows('catalog').filter(function (c) {
      var n = String(c.name).toLowerCase();
      return words.some(function (w) { return n.indexOf(w) >= 0; });
    }).map(function (c) { return { item_id: c.item_id, name: c.name }; });
    if (similar.length && p.confirm_new !== true) {
      throw opsError('SIMILAR_ITEMS', 'Похожие позиции уже есть — выберите или подтвердите новую', similar);
    }
    var id = 'i-' + plan.op_id;
    add(plan, view, 'catalog', {
      item_id: id, code: '', category: oneOf(p.category, CATEGORIES, 'категория'), name: name, unit: 'шт',
      sale_price: posInt(p.sale_price, 'цена продажи'), last_cost: 0, min_stock: 0,
      status: isOwner ? 'active' : 'review', created_by: view.ctx.staff_id
    });
    if (!isOwner) plan.notify.push({ to: 'owner', kind: 'new_item', item_id: id, name: name });
    plan.result = { item_id: id };
  };

  H.defect = function (view, p, plan) {
    requireShift(view, plan);
    var lines = list(p.lines, 'строки').map(function (l) {
      return { item_id: l.item_id, qty: posInt(l.qty, 'количество'), reason: oneOf(l.reason, DEFECT_REASONS, 'причина') };
    });
    moveStock(plan, view, lines, 'defect', { sign: -1, allowHidden: true });
    plan.result = {
      cost: lines.reduce(function (a, l) { return a + C.lossCost(l.qty, view.item(l.item_id).last_cost); }, 0)
    };
  };

  H.refund = function (view, p, plan) {
    requireShift(view, plan);
    var r = view.receipt(p.receipt_id);
    if (!r || r.status !== 'posted') throw opsError('UNKNOWN_RECEIPT', 'Чек не найден или отменён');
    if (p.mode === 'money') {
      var amount = posInt(p.amount, 'сумма возврата');
      var money = receiptMoney(view, r.receipt_id);
      C.checkRefund(money.paid, money.refunded, amount);
      addPayments(plan, view, [{ method: oneOf(p.method, ['cash', 'card'], 'способ возврата'), amount: amount }], 'refund', r.receipt_id);
      plan.result = { receipt_id: r.receipt_id, refunded: amount };
    } else if (p.mode === 'replace') {
      // Вернувшиеся завядшие цветы на склад не приходуются (ТЗ).
      moveStock(plan, view, list(p.items, 'состав замены'), 'replace', { sign: -1, receipt_id: r.receipt_id });
      plan.result = { receipt_id: r.receipt_id, replaced: true };
    } else {
      throw opsError('BAD_INPUT', 'Вид возврата: деньги или замена');
    }
  };

  H.cancel = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var r = view.receipt(p.receipt_id);
    if (!r || r.status !== 'posted') throw opsError('UNKNOWN_RECEIPT', 'Чек не найден или уже отменён');
    if (r.shift_id !== shift.shift_id) throw opsError('NOT_THIS_SHIFT', 'Отменить можно только чек текущей смены');
    if (r.type === 'preorder') throw opsError('FORBIDDEN', 'Отмену предзаказа делает владелица');
    var money = receiptMoney(view, r.receipt_id);
    var replaced = view.rows('stock_moves').some(function (m) { return m.receipt_id === r.receipt_id && m.type === 'replace'; });
    if (money.refunded > 0 || replaced) throw opsError('HAS_REFUNDS', 'По чеку уже был возврат или замена — отмена невозможна');
    if (money.debt > 0 && view.debtOf(r.customer_id) < money.debt) {
      throw opsError('DEBT_REPAID', 'Долг по этому чеку уже частично погашен — оформите возврат, а не отмену');
    }
    var reason = text(p.reason, 'причина', 200);
    // Товар возвращается на склад.
    view.rows('stock_moves').forEach(function (m) {
      if (m.receipt_id !== r.receipt_id || m.type !== 'sale') return;
      add(plan, view, 'stock_moves', {
        move_id: nextId(plan, 'mv'), shift_id: shift.shift_id, type: 'cancel', item_id: m.item_id,
        qty: -m.qty, cost_sum: '', supplier_or_reason: reason, receipt_id: r.receipt_id
      });
      touchStock(plan, m.item_id);
    });
    // Долг по чеку аннулируется. Оплаты не учитываются, потому что чек отменён.
    if (money.debt) {
      add(plan, view, 'debt_moves', {
        debt_move_id: nextId(plan, 'dm'), shift_id: shift.shift_id, customer_id: r.customer_id,
        type: 'cancel', amount: -money.debt, receipt_id: r.receipt_id, since_date: '', comment: reason
      });
    }
    update(plan, 'receipts', { receipt_id: r.receipt_id }, r, { status: 'cancelled' });
    plan.notify.push({ to: 'owner', kind: 'cancel', receipt_id: r.receipt_id, total: r.total, reason: reason });
    plan.result = { receipt_id: r.receipt_id, returned_money: money.paid };
  };

  H.debt_repay = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var c = view.customer(p.customer_id);
    if (!c) throw opsError('UNKNOWN_CUSTOMER', 'Нет такого покупателя');
    var amount = posInt(p.amount, 'сумма погашения');
    C.checkRepay(view.debtOf(c.customer_id), amount);
    addPayments(plan, view, [{ method: oneOf(p.method, ['cash', 'card'], 'способ оплаты'), amount: amount }], 'debt_repay', '', c.customer_id);
    add(plan, view, 'debt_moves', {
      debt_move_id: nextId(plan, 'dm'), shift_id: shift.shift_id, customer_id: c.customer_id,
      type: 'repay', amount: -amount, receipt_id: '', since_date: '', comment: ''
    });
    plan.result = { customer_id: c.customer_id, debt_left: view.debtOf(c.customer_id) - amount };
  };

  H.debt_opening = function (view, p, plan) {
    requireOwner(view);
    var customerId = customerRef(view, plan, p.customer);
    add(plan, view, 'debt_moves', {
      debt_move_id: nextId(plan, 'dm'), shift_id: '', customer_id: customerId, type: 'opening',
      amount: posInt(p.amount, 'сумма долга'), receipt_id: '', since_date: dateStr(p.since_date, 'дата долга'),
      comment: optText(p.comment, 'комментарий', 200)
    });
    plan.result = { customer_id: customerId };
  };

  H.stock_start = function (view, p, plan) {
    requireOwner(view);
    if (view.openShift()) throw opsError('SHIFT_OPEN', 'Стартовые остатки вносятся, когда смена закрыта');
    moveStock(plan, view, list(p.lines, 'позиции'), 'start', { sign: 1 });
    plan.result = { lines: p.lines.length };
  };

  H.cash_out = function (view, p, plan) {
    var shift = requireShift(view, plan);
    add(plan, view, 'cash_ops', {
      cash_id: nextId(plan, 'co'), shift_id: shift.shift_id,
      type: oneOf(p.type, ['delivery', 'other'], 'тип расхода'), // аренды в смене нет (D11)
      amount: posInt(p.amount, 'сумма'), staff_id: '', comment: optText(p.comment, 'комментарий', 200)
    });
    plan.result = { amount: p.amount };
  };

  H.withdrawal = function (view, p, plan) {
    var shift = requireShift(view, plan);
    add(plan, view, 'cash_ops', {
      cash_id: nextId(plan, 'co'), shift_id: shift.shift_id, type: 'withdrawal_day',
      amount: posInt(p.amount, 'сумма'), staff_id: '', comment: ''
    });
    plan.notify.push({ to: 'owner', kind: 'withdrawal', amount: p.amount });
    plan.result = { amount: p.amount };
  };

  /** Доплата ЗП из кассы в течение смены (D7, D18). */
  H.pay_adjust = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var s = view.staff(p.staff_id);
    if (!s || s.role !== 'florist') throw opsError('UNKNOWN_STAFF', 'Нет такого флориста');
    add(plan, view, 'cash_ops', {
      cash_id: nextId(plan, 'co'), shift_id: shift.shift_id, type: 'pay_adjust',
      amount: posInt(p.amount, 'сумма'), staff_id: s.staff_id, comment: optText(p.comment, 'комментарий', 200)
    });
    plan.result = { staff_id: s.staff_id, amount: p.amount };
  };

  H.inventory = function (view, p, plan) {
    requireShift(view, plan);
    var facts = p.facts || {};
    var ids = Object.keys(facts);
    if (!ids.length) throw opsError('BAD_INPUT', 'Нет позиций для инвентаризации');
    var bal = {};
    ids.forEach(function (id) { activeItem(view, id, true); nonNegInt(facts[id], 'факт'); bal[id] = view.stock(id); });
    var adj = C.inventoryAdjust(bal, facts);
    var out = [];
    Object.keys(adj).forEach(function (id) {
      add(plan, view, 'stock_moves', {
        move_id: nextId(plan, 'mv'), shift_id: plan.shift_id, type: 'adjust', item_id: id, qty: adj[id],
        cost_sum: '', supplier_or_reason: 'инвентаризация', receipt_id: ''
      });
      touchStock(plan, id);
      out.push({ item_id: id, qty: adj[id], cost: C.lossCost(adj[id], view.item(id).last_cost) });
    });
    plan.result = { adjustments: out };
  };

  /** Цифры смены по проведённым данным (без закрытия). */
  function shiftNumbers(view, shift) {
    var receipts = view.rows('receipts');
    var cancelled = {};
    receipts.forEach(function (r) { if (r.status === 'cancelled') cancelled[r.receipt_id] = true; });
    var mine = receipts.filter(function (r) { return r.shift_id === shift.shift_id; });
    var pays = view.rows('payments').filter(function (p) {
      return p.shift_id === shift.shift_id && !(p.receipt_id && cancelled[p.receipt_id]);
    });
    var ops = view.rows('cash_ops').filter(function (o) { return o.shift_id === shift.shift_id; });
    var rev = C.shiftRevenue(mine);
    return {
      receipts: mine, payments: pays, cash_ops: ops, revenue: rev,
      calc_cash: C.cashCalc(shift.open_cash, pays, ops), card_total: C.cardTotal(pays)
    };
  }

  H.close_shift = function (view, p, plan) {
    var shift = requireShift(view, plan);
    var inventoried = view.rows('ops_log').some(function (o) { return o.kind === 'inventory' && o.shift_id === shift.shift_id; });
    if (!inventoried) throw opsError('INVENTORY_REQUIRED', 'Сначала инвентаризация: шаг 1 закрытия смены');
    if (p.expenses_confirmed !== true) throw opsError('CONFIRM_EXPENSES', 'Подтвердите, что все доставки, расходы и изъятия внесены');
    var n = shiftNumbers(view, shift);
    var staff = view.shiftStaff(shift.shift_id);
    var pay = C.payroll(n.revenue.revenue, staff);
    var due = {};
    staff.forEach(function (s) { due[s.staff_id] = pay.each[s.staff_id].total; });
    var close = C.closeShift({
      counted: nonNegInt(p.counted, 'пересчёт'), calc_cash: n.calc_cash, payroll_each: due,
      change_fund: view.settings().change_fund, close_withdrawal: nonNegInt(p.close_withdrawal || 0, 'изъятие')
    });
    staff.forEach(function (s) {
      var paid = close.payroll_paid_each[s.staff_id];
      var rate = Math.min(paid, pay.each[s.staff_id].rate);
      var parts = [['rate', rate], ['pct', paid - rate]];
      parts.forEach(function (pt) {
        if (pt[1] > 0) {
          add(plan, view, 'cash_ops', { cash_id: nextId(plan, 'co'), shift_id: shift.shift_id, type: pt[0], amount: pt[1], staff_id: s.staff_id, comment: '' });
        }
      });
    });
    if (p.close_withdrawal > 0) {
      add(plan, view, 'cash_ops', { cash_id: nextId(plan, 'co'), shift_id: shift.shift_id, type: 'withdrawal_close', amount: p.close_withdrawal, staff_id: '', comment: '' });
    }
    update(plan, 'shifts', { shift_id: shift.shift_id }, shift, {
      closed_at: view.ctx.now, calc_cash: n.calc_cash, counted_cash: p.counted, cash_diff: close.cash_diff,
      payroll_total: pay.total, payroll_unpaid: close.payroll_unpaid_total,
      close_withdrawal: p.close_withdrawal || 0, next_cash: close.next_cash, status: 'closed'
    });
    plan.notify.push({ to: 'owner', kind: 'shift_report', shift_id: shift.shift_id });
    plan.result = {
      shift_id: shift.shift_id, cash_diff: close.cash_diff, next_cash: close.next_cash,
      payroll_paid: close.payroll_paid_each, payroll_unpaid: close.payroll_unpaid_each
    };
  };

  H.owner_expense = function (view, p, plan) {
    requireOwner(view);
    var month = p.month;
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw opsError('BAD_INPUT', 'Месяц в виде ГГГГ-ММ');
    if (!Number.isSafeInteger(p.amount) || p.amount === 0) throw opsError('BAD_INPUT', 'Сумма — целое число, не ноль');
    add(plan, view, 'owner_expenses', {
      expense_id: nextId(plan, 'ex'), month: month, item: text(p.item, 'статья', 60), amount: p.amount,
      comment: optText(p.comment, 'комментарий', 200), created_by: view.ctx.staff_id
    });
    plan.result = { month: month, amount: p.amount };
  };

  // ---------- вход ----------

  /** Проверить операцию и вернуть план записи. Ничего не пишет. */
  function build(view, kind, opId, payload) {
    if (typeof opId !== 'string' || opId.length < 8 || opId.length > 64) throw opsError('BAD_OP_ID', 'Неверный ID операции');
    var h = H[kind];
    if (!h) throw opsError('UNKNOWN_OP', 'Неизвестная операция: ' + kind);
    var plan = newPlan(view, kind, opId);
    h(view, payload || {}, plan);
    delete plan._n;
    return plan;
  }

  // ---------- отчёт смены (данные, без текста) ----------

  function shiftReport(view, shiftId) {
    var shift = view.rows('shifts').filter(function (s) { return s.shift_id === shiftId; })[0];
    if (!shift) throw opsError('UNKNOWN_SHIFT', 'Нет такой смены');
    var n = shiftNumbers(view, shift);
    var own = {};
    n.receipts.forEach(function (r) { if (r.status !== 'cancelled') own[r.receipt_id] = r; });
    var sumWhere = function (arr, f) { return arr.filter(f).reduce(function (a, x) { return a + x.amount; }, 0); };
    var isIn = function (p) { return p.kind !== 'refund'; };
    var byOwn = function (p) { return isIn(p) && p.receipt_id && own[p.receipt_id]; };
    var byPrior = function (p) { return isIn(p) && !(p.receipt_id && own[p.receipt_id]); };
    // Только деньги и долги этой смены: отчёт закрытой смены не меняется задним числом.
    var debtMoves = view.rows('debt_moves').filter(function (m) { return m.shift_id === shiftId; });
    var ownDebt = function (id) {
      return debtMoves.filter(function (m) { return m.receipt_id === id && (m.type === 'sale' || m.type === 'pickup'); })
        .reduce(function (a, m) { return a + m.amount; }, 0);
    };
    var preorderUnpaid = Object.keys(own).filter(function (id) { return own[id].type === 'preorder'; })
      .reduce(function (a, id) {
        return a + own[id].total - ownDebt(id) - sumWhere(n.payments, function (p) { return p.receipt_id === id && isIn(p); });
      }, 0);
    var moves = view.rows('stock_moves').filter(function (m) { return m.shift_id === shiftId; });
    var item = function (id) { return view.item(id) || { name: id, last_cost: 0 }; };
    var staff = view.shiftStaff(shiftId);
    var pay = C.payroll(n.revenue.revenue, staff);
    var paidBy = function (sid) { return sumWhere(n.cash_ops, function (o) { return o.staff_id === sid && (o.type === 'rate' || o.type === 'pct'); }); };
    var balance = {};
    view.balance().forEach(function (b) { balance[b.item_id] = b.qty; });
    var catalog = view.rows('catalog').filter(function (c) { return c.status !== 'hidden'; });
    return {
      shift_id: shiftId, shift_no: shift.shift_no, shift_date: shift.shift_date,
      florists: staff.map(function (s) { return (view.staff(s.staff_id) || {}).name || s.staff_id; }),
      revenue: n.revenue.revenue, receipts_count: n.revenue.receipts_count, avg_check: n.revenue.avg_check,
      discounts: n.revenue.discounts_total, cancelled_count: n.revenue.cancelled_count,
      sales_cash: sumWhere(n.payments, function (p) { return byOwn(p) && p.method === 'cash'; }),
      sales_card: sumWhere(n.payments, function (p) { return byOwn(p) && p.method === 'card'; }),
      sales_debt: Object.keys(own).reduce(function (a, id) { return a + ownDebt(id); }, 0),
      preorder_unpaid: preorderUnpaid,
      prior_cash: sumWhere(n.payments, function (p) { return byPrior(p) && p.method === 'cash'; }),
      prior_card: sumWhere(n.payments, function (p) { return byPrior(p) && p.method === 'card'; }),
      refunds_cash: sumWhere(n.payments, function (p) { return p.kind === 'refund' && p.method === 'cash'; }),
      refunds_card: sumWhere(n.payments, function (p) { return p.kind === 'refund' && p.method === 'card'; }),
      replaced_qty: moves.filter(function (m) { return m.type === 'replace'; }).reduce(function (a, m) { return a - m.qty; }, 0),
      open_cash: shift.open_cash, open_diff: shift.open_diff, calc_cash: n.calc_cash,
      counted_cash: shift.counted_cash, cash_diff: shift.cash_diff, next_cash: shift.next_cash,
      card_total: n.card_total,
      payroll: staff.map(function (s) {
        var e = pay.each[s.staff_id];
        return { staff_id: s.staff_id, rate: e.rate, pct: e.pct, total: e.total, paid: paidBy(s.staff_id), unpaid: e.total - paidBy(s.staff_id) };
      }),
      delivery: sumWhere(n.cash_ops, function (o) { return o.type === 'delivery'; }),
      other: sumWhere(n.cash_ops, function (o) { return o.type === 'other'; }),
      pay_adjust: sumWhere(n.cash_ops, function (o) { return o.type === 'pay_adjust'; }),
      withdrawal: sumWhere(n.cash_ops, function (o) { return o.type === 'withdrawal_day' || o.type === 'withdrawal_close'; }),
      income: moves.filter(function (m) { return m.type === 'income'; })
        .map(function (m) { return { item_id: m.item_id, qty: m.qty, cost_sum: m.cost_sum }; }),
      defects: moves.filter(function (m) { return m.type === 'defect'; })
        .map(function (m) { return { item_id: m.item_id, qty: m.qty, reason: m.supplier_or_reason, cost: C.lossCost(m.qty, item(m.item_id).last_cost) }; }),
      adjustments: moves.filter(function (m) { return m.type === 'adjust'; })
        .map(function (m) { return { item_id: m.item_id, qty: m.qty, cost: C.lossCost(m.qty, item(m.item_id).last_cost) }; }),
      below_min: C.belowMin(balance, catalog).map(function (id) {
        return { item_id: id, qty: balance[id] || 0, min: item(id).min_stock };
      })
    };
  }

  return {
    opsError: opsError,
    makeView: makeView,
    build: build,
    shiftReport: shiftReport,
    POINT_SHEETS: POINT_SHEETS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Ops;
