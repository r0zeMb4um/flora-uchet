/**
 * API Mini App. Запрос: POST text/plain, тело — JSON { initData, action, ... }.
 * Кто пишет — только по проверенной подписи Telegram → staff (клиент и точка из таблицы, не из запроса).
 * Ответ: { ok: true, data } или { ok: false, error: { code, message, details } }.
 *
 * Флорист НЕ получает расчётную сумму кассы (пересчёт вслепую) — в ответах её нет.
 */
var MiniApi = (function () {
  'use strict';

  // Операции флориста в кассе (ТЗ, «Кнопки флориста»: всё, где больше одной позиции, — в Mini App).
  var FLORIST_KINDS = {
    sale: true, bouquet: true, preorder: true, reserve: true, reserve_cancel: true,
    preorder_assemble: true, preorder_pickup: true, income: true, new_item: true, defect: true, refund: true,
    inventory: true, cash_out: true, withdrawal: true, close_shift: true
  };

  function apiError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /** Сотрудник по Telegram ID. */
  function staffOf(store, telegramId) {
    var s = store.rows('staff').filter(function (x) { return x.telegram_id === String(telegramId) && x.active === true; })[0];
    if (!s) throw apiError('FORBIDDEN', 'Нет доступа — войдите в бота по ссылке-приглашению');
    return s;
  }

  function ctxOf(staff, now) {
    return { client_id: staff.client_id, point_id: staff.point_id, staff_id: staff.staff_id, role: staff.role, now: now };
  }

  /** Данные для экранов: кто я, смена (без расчёта кассы), каталог с остатками. */
  function bootstrap(store, staff, now) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    var shift = view.openShift();
    var shiftInfo = null;
    if (shift) {
      var rep = Ops.shiftReport(view, shift.shift_id);
      var mine = rep.payroll.filter(function (p) { return p.staff_id === staff.staff_id; })[0] || null;
      shiftInfo = {
        shift_no: shift.shift_no,
        opened_at: shift.opened_at,
        florists: rep.florists,
        on_shift: !!mine,
        revenue: rep.revenue,
        receipts_count: rep.receipts_count,
        my_pay: mine ? { rate: mine.rate, pct: mine.pct, total: mine.total } : null,
        inventory_done: view.rows('ops_log').some(function (o) { return o.kind === 'inventory' && o.shift_id === shift.shift_id; }),
        expenses: { delivery: rep.delivery, other: rep.other, withdrawal: rep.withdrawal, pay_adjust: rep.pay_adjust }
      };
    }
    var catalog = view.rows('catalog').filter(function (c) { return c.status !== 'hidden'; }).map(function (c) {
      return {
        item_id: c.item_id, name: c.name, category: c.category, price: c.sale_price,
        stock: view.stock(c.item_id), min: c.min_stock, review: c.status === 'review'
      };
    }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    var names = {};
    var customers = view.rows('customers').filter(function (c) { return c.anonymized !== true; }).map(function (c) {
      names[c.customer_id] = c.name;
      return { customer_id: c.customer_id, name: c.name, note: c.note, debt: view.debtOf(c.customer_id) };
    }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    var pays = view.rows('payments');
    var debts = view.rows('debt_moves');
    var preorders = view.rows('receipts').filter(function (r) {
      return r.type === 'preorder' && r.status === 'posted' && (r.assembly_status === 'waiting' || r.assembly_status === 'assembled');
    }).map(function (r) {
      var paid = pays.filter(function (p) { return p.receipt_id === r.receipt_id; })
        .reduce(function (a, p) { return a + (p.kind === 'refund' ? -p.amount : p.amount); }, 0);
      var debt = debts.filter(function (m) { return m.receipt_id === r.receipt_id; }).reduce(function (a, m) { return a + m.amount; }, 0);
      return { receipt_id: r.receipt_id, customer: names[r.customer_id] || '', pickup_date: r.pickup_date,
        total: r.total, paid: paid, unpaid: r.total - paid - debt, assembly_status: r.assembly_status };
    }).sort(function (a, b) { return a.pickup_date < b.pickup_date ? -1 : 1; });
    var reservations = view.rows('reservations').filter(function (r) { return r.status === 'active'; }).map(function (r) {
      return { reservation_id: r.reservation_id, customer: names[r.customer_id] || '', pickup_date: r.pickup_date, total: r.total };
    }).sort(function (a, b) { return a.pickup_date < b.pickup_date ? -1 : 1; });
    return { me: { name: staff.name, role: staff.role }, shift: shiftInfo, catalog: catalog,
      customers: customers, preorders: preorders, reservations: reservations };
  }

  /** Чеки последних дней для возврата: сколько оплачено и сколько ещё можно вернуть. */
  function recentReceipts(store, staff, now, days) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    var since = new Date(Date.parse(now) - (days || 7) * 86400000).toISOString().slice(0, 10);
    var pays = view.rows('payments');
    return view.rows('receipts').filter(function (r) { return r.status === 'posted' && String(r.created_at).slice(0, 10) >= since; })
      .map(function (r) {
        var paid = 0;
        var refunded = 0;
        pays.forEach(function (p) { if (p.receipt_id === r.receipt_id) { if (p.kind === 'refund') refunded += p.amount; else paid += p.amount; } });
        return { receipt_id: r.receipt_id, receipt_no: r.receipt_no, type: r.type, total: r.total, created_at: r.created_at,
          refundable: Math.max(0, paid - refunded) };
      })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; })
      .slice(0, 100);
  }

  /** Обработка запроса после проверки подписи. Чистая относительно Google: store передаётся снаружи. */
  function dispatch(store, telegramId, body, now) {
    var staff = staffOf(store, telegramId);
    if (body.action === 'bootstrap') return { data: bootstrap(store, staff, now), notify: [] };
    if (body.action === 'receipts') return { data: recentReceipts(store, staff, now, Math.min(Number(body.days) || 7, 31)), notify: [] };
    if (body.action === 'close_preview') {
      // Только ПОСЛЕ ввода пересчёта: расхождение, зарплата, сколько можно забрать. Ничего не пишет.
      if (staff.role !== 'florist') throw apiError('FORBIDDEN', 'Смену закрывает флорист');
      var view = Ops.makeView(store, ctxOf(staff, now));
      var plan = Ops.build(view, 'close_shift', 'preview-' + staff.staff_id, {
        counted: body.counted, close_withdrawal: body.close_withdrawal || 0, expenses_confirmed: true
      });
      var names = {};
      view.rows('staff').forEach(function (s) { names[s.staff_id] = s.name; });
      var r = plan.result;
      return { data: {
        cash_diff: r.cash_diff, next_cash: r.next_cash, can_take_above_change_fund: r.can_take_above_change_fund,
        max_withdrawal: r.max_withdrawal,
        payroll: Object.keys(r.payroll_due).map(function (id) {
          return { name: names[id] || id, due: r.payroll_due[id], paid: r.payroll_paid[id], unpaid: r.payroll_unpaid[id] };
        })
      }, notify: [] };
    }
    if (body.action === 'post') {
      if (staff.role !== 'florist' || !FLORIST_KINDS[body.kind]) throw apiError('FORBIDDEN', 'Эта операция недоступна в кассе');
      var res = Posting.post(store, ctxOf(staff, now), { op_id: body.op_id, kind: body.kind, payload: body.payload || {} });
      return {
        data: { status: res.status, result: res.result, state: bootstrap(store, staff, now) },
        notify: res.notify || [],
        client_id: staff.client_id
      };
    }
    throw apiError('BAD_ACTION', 'Неизвестное действие');
  }

  /** Вход из doPost (Apps Script). */
  function handle(data) {
    var store = null;
    try {
      var auth = Auth.verifyGas(data.initData);
      store = SheetsStore.open();
      var out = dispatch(store, auth.user.id, data, nowIso());
      if (out.notify.length) {
        try { Webhook.notify(store, out.client_id, out.notify); } catch (ignore) { /* уведомление не ломает продажу */ }
      }
      return jsonOut_({ ok: true, data: out.data });
    } catch (err) {
      if (err.code) return jsonOut_({ ok: false, error: { code: err.code, message: err.message, details: err.details || null } });
      console.error(err);
      try {
        if (store) store.append('audit', [{ ts: nowIso(), actor_telegram_id: '', action: 'error', details_json: JSON.stringify({ api: data && data.action, error: String(err.stack || err) }).slice(0, 45000) }]);
      } catch (ignore2) { /* журнал не должен ломать ответ */ }
      return jsonOut_({ ok: false, error: { code: 'SERVER', message: 'Ошибка сервера — попробуйте ещё раз. Повтор не задвоит продажу.' } });
    }
  }

  return { handle: handle, dispatch: dispatch, bootstrap: bootstrap };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MiniApi;
