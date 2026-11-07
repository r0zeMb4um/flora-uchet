/**
 * API Mini App. Запрос: POST text/plain, тело — JSON { initData, action, ... }.
 * Кто пишет — только по проверенной подписи Telegram → staff (клиент и точка из таблицы, не из запроса).
 * Ответ: { ok: true, data } или { ok: false, error: { code, message, details } }.
 *
 * Флорист НЕ получает расчётную сумму кассы (пересчёт вслепую) — в ответах её нет.
 */
var MiniApi = (function () {
  'use strict';

  // Операции, которые Mini App может проводить сейчас (расширяется на этапе D).
  var FLORIST_KINDS = { sale: true, bouquet: true };

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
        my_pay: mine ? { rate: mine.rate, pct: mine.pct, total: mine.total } : null
      };
    }
    var catalog = view.rows('catalog').filter(function (c) { return c.status !== 'hidden'; }).map(function (c) {
      return {
        item_id: c.item_id, name: c.name, category: c.category, price: c.sale_price,
        stock: view.stock(c.item_id), min: c.min_stock, review: c.status === 'review'
      };
    }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    return { me: { name: staff.name, role: staff.role }, shift: shiftInfo, catalog: catalog };
  }

  /** Обработка запроса после проверки подписи. Чистая относительно Google: store передаётся снаружи. */
  function dispatch(store, telegramId, body, now) {
    var staff = staffOf(store, telegramId);
    if (body.action === 'bootstrap') return { data: bootstrap(store, staff, now), notify: [] };
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
