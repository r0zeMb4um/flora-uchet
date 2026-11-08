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
    inventory: true, cash_out: true, withdrawal: true, close_shift: true, template_save: true, template_hide: true
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
    // Шаблоны букетов и «хиты» — позиции, которых больше всего продали за 30 дней.
    var templates = view.rows('bouquet_templates').filter(function (t) { return t.status === 'active'; }).map(function (t) {
      return { template_id: t.template_id, name: t.name, items: JSON.parse(t.items_json || '[]'), price: t.price, mine: t.created_by === staff.staff_id };
    }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    var cut = new Date(Date.parse(now) - 30 * 86400000 + 5 * 3600000).toISOString().slice(0, 10);
    var sold = {};
    view.rows('stock_moves').forEach(function (m) {
      if (m.type === 'sale' && String(m.created_at).slice(0, 10) >= cut) sold[m.item_id] = (sold[m.item_id] || 0) - m.qty;
    });
    var hits = Object.keys(sold).filter(function (id) { return sold[id] > 0; })
      .sort(function (a, b) { return sold[b] - sold[a]; }).slice(0, 8);
    var client = store.rows('clients').filter(function (c) { return c.client_id === staff.client_id; })[0] || {};
    return { me: { name: staff.name, role: staff.role }, shop: { name: client.name || 'Флора·Учёт' },
      shift: shiftInfo, catalog: catalog, templates: templates, hits: hits,
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


  // ---------- экраны владелицы (этап G) ----------

  var OWNER_KINDS = { correction: true, anonymize: true };

  function requireOwnerStaff(staff) {
    if (staff.role !== 'owner') throw apiError('FORBIDDEN', 'Это раздел владелицы');
  }
  function names(view) {
    var n = { items: {}, staff: {} };
    view.rows('catalog').forEach(function (c) { n.items[c.item_id] = c.name; });
    view.rows('staff').forEach(function (s) { n.staff[s.staff_id] = s.name; });
    return n;
  }

  /** «Сегодня»: открытая смена целиком (владелице расчёт кассы виден), тревоги, ниже минимума. */
  function ownerToday(store, staff, now) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    var shift = view.openShift();
    var rep = shift ? Ops.shiftReport(view, shift.shift_id) : null;
    var st = Summary.stock(view);
    var alerts = [];
    if (rep && rep.open_diff) alerts.push('Расхождение при приёме смены: ' + rep.open_diff + ' ₸');
    if (rep && rep.cancelled_count) alerts.push('Отменено чеков: ' + rep.cancelled_count);
    var review = view.rows('catalog').filter(function (c) { return c.status === 'review'; }).length;
    if (review) alerts.push('Новых позиций на проверке: ' + review + ' (чат → «Каталог»)');
    var yesterday = new Date(Date.parse(now.slice(0, 10) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    var client = store.rows('clients').filter(function (c) { return c.client_id === staff.client_id; })[0] || {};
    return { me: { name: staff.name, role: staff.role }, shop: { name: client.name || 'Флора·Учёт' },
      shift: rep, names: names(view), below_min: st.below, restock: Summary.restock(view), alerts: alerts, yesterday: Summary.day(view, yesterday) };
  }

  function ownerShifts(store, staff, now, limit) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    var corrected = {};
    view.rows('ops_log').forEach(function (o) { if (o.kind === 'correction') corrected[o.shift_id] = true; });
    var staffNames = names(view).staff;
    return view.rows('shifts').sort(function (a, b) { return b.shift_no - a.shift_no; }).slice(0, limit || 40).map(function (s) {
      var rev = Calc.shiftRevenue(view.rows('receipts').filter(function (r) { return r.shift_id === s.shift_id; }));
      return {
        shift_id: s.shift_id, shift_no: s.shift_no, shift_date: s.shift_date, status: s.status,
        florists: String(s.florist_ids).split(',').map(function (id) { return staffNames[id] || id; }),
        revenue: rev.revenue, receipts: rev.receipts_count, cash_diff: s.status === 'closed' ? s.cash_diff : null,
        corrected: !!corrected[s.shift_id]
      };
    });
  }

  function ownerShift(store, staff, now, shiftId) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    var rep = Ops.shiftReport(view, shiftId);
    var pays = view.rows('payments');
    var debts = view.rows('debt_moves');
    var receipts = view.rows('receipts').filter(function (r) { return r.shift_id === shiftId; })
      .sort(function (a, b) { return a.receipt_no - b.receipt_no; }).map(function (r) {
        var cash = 0, card = 0;
        pays.forEach(function (p) {
          if (p.receipt_id !== r.receipt_id || p.kind === 'refund' || p.shift_id !== shiftId) return;
          if (p.method === 'cash') cash += p.amount; else card += p.amount;
        });
        var debt = debts.filter(function (m) { return m.receipt_id === r.receipt_id && m.shift_id === shiftId && m.amount > 0; })
          .reduce(function (a, m) { return a + m.amount; }, 0);
        return { receipt_id: r.receipt_id, receipt_no: r.receipt_no, time: String(r.created_at).slice(11, 16), type: r.type,
          price: r.price, discount: r.discount_amount, total: r.total, cash: cash, card: card, debt: debt, status: r.status };
      });
    var shift = view.rows('shifts').filter(function (s) { return s.shift_id === shiftId; })[0];
    return { report: rep, status: shift.status, receipts: receipts, names: names(view),
      text: typeof Reports !== 'undefined' ? Reports.shiftText(rep, names(view)) : '' };
  }

  /**
   * Сводка за период + ряды по дням (выручка и прибыль дня), прошлый период той же длины для сравнения, топ позиций.
   * Прибыль дня = выручка − возвраты − закупки − ЗП − доставки − прочее (расходы месяца владелицы в дни не делятся).
   */
  function ownerPeriod(store, staff, now, from, to) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    var s = Summary.period(view, from, to);
    var days = [];
    var byDay = {};
    for (var d = from; d <= to && days.length < 92; d = new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)) {
      byDay[d] = { date: d, revenue: 0, profit: 0 };
      days.push(byDay[d]);
    }
    var ids = {};
    view.rows('shifts').filter(function (x) { return x.shift_date >= from && x.shift_date <= to; }).forEach(function (x) {
      ids[x.shift_id] = x.shift_date;
      var r = Ops.shiftReport(view, x.shift_id);
      var pay = r.payroll.reduce(function (a, p) { return a + p.total; }, 0);
      var day = byDay[x.shift_date];
      if (!day) return;
      day.revenue += r.revenue;
      day.profit += r.revenue - r.refunds_cash - r.refunds_card - pay - r.delivery - r.other;
    });
    view.rows('stock_moves').forEach(function (m) {
      if (m.type === 'income' && ids[m.shift_id] && byDay[ids[m.shift_id]]) byDay[ids[m.shift_id]].profit -= (m.cost_sum || 0);
    });
    var top = Summary.top(view, from, to, 5);
    // Прошлый период той же длины — для «↑12%».
    var pr = Summary.prevRange(from, to);
    var pFrom = pr[0], pTo = pr[1];
    var prev = Summary.period(view, pFrom, pTo);
    return { summary: s, days: days, top: top, prev: { from: pFrom, to: pTo, revenue: prev.revenue, profit: prev.profit, receipts: prev.receipts },
      names: names(view) };
  }

  function ownerCustomers(store, staff, now) {
    var view = Ops.makeView(store, ctxOf(staff, now));
    return view.rows('customers').filter(function (c) { return c.anonymized !== true; }).map(function (c) {
      var since = view.rows('debt_moves').filter(function (m) { return m.customer_id === c.customer_id && m.amount > 0; })
        .map(function (m) { return m.since_date || String(m.created_at).slice(0, 10); }).sort()[0] || '';
      return { customer_id: c.customer_id, name: c.name, note: c.note, debt: view.debtOf(c.customer_id), since: since };
    }).sort(function (a, b) { return b.debt - a.debt || (a.name < b.name ? -1 : 1); });
  }

  function ownerDispatch(store, staff, body, now) {
    requireOwnerStaff(staff);
    if (body.action === 'owner_today') return ownerToday(store, staff, now);
    if (body.action === 'owner_shifts') return ownerShifts(store, staff, now, Math.min(Number(body.limit) || 40, 200));
    if (body.action === 'owner_shift') return ownerShift(store, staff, now, String(body.shift_id || ''));
    if (body.action === 'owner_period') return ownerPeriod(store, staff, now, String(body.from || ''), String(body.to || ''));
    if (body.action === 'owner_customers') return ownerCustomers(store, staff, now);
    throw apiError('BAD_ACTION', 'Неизвестное действие');
  }

  /** Обработка запроса после проверки подписи. Чистая относительно Google: store передаётся снаружи. */
  function dispatch(store, telegramId, body, now) {
    var staff = staffOf(store, telegramId);
    if (body.action === 'bootstrap') return { data: bootstrap(store, staff, now), notify: [] };
    if (String(body.action).indexOf('owner_') === 0 && body.action !== 'owner_export') return { data: ownerDispatch(store, staff, body, now), notify: [] };
    if (body.action === 'send_image') {
      // Картинка (чек клиенту, карточка дня) приходит самому сотруднику в чат с ботом — оттуда её пересылают.
      var b64 = String(body.image || '');
      if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length > 3000000) throw apiError('BAD_INPUT', 'Картинка не получилась — попробуйте ещё раз');
      return { data: { sent: true }, notify: [], photo: { chat_id: staff.telegram_id, base64: b64, caption: String(body.caption || '').slice(0, 900) } };
    }
    if (body.action === 'owner_export') {
      if (staff.role !== 'owner') throw apiError('FORBIDDEN', 'Это раздел владелицы');
      var from = String(body.from || ''), to = String(body.to || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw apiError('BAD_INPUT', 'Период: даты ГГГГ-ММ-ДД');
      return { data: { sent: true }, notify: [], export: { from: from, to: to, staff: staff } };
    }
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
      var allowed = staff.role === 'florist' ? FLORIST_KINDS[body.kind] : staff.role === 'owner' ? OWNER_KINDS[body.kind] : false;
      if (!allowed) throw apiError('FORBIDDEN', 'Эта операция недоступна в кассе');
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
    var t0 = Date.now();
    try {
      var auth = Auth.verifyGas(data.initData);
      store = SheetsStore.open();
      var out = dispatch(store, auth.user.id, data, nowIso());
      if (out.export) {
        ExportExcel.sendTo(store, ctxOf(out.export.staff, nowIso()), out.export.staff.telegram_id, out.export.from, out.export.to);
      }
      if (out.photo) {
        var blob = Utilities.newBlob(Utilities.base64Decode(out.photo.base64), 'image/jpeg', 'flora.jpg');
        Tg.sendPhoto(out.photo.chat_id, blob, out.photo.caption);
      }
      if (out.notify.length) {
        try { Webhook.notify(store, out.client_id, out.notify); } catch (ignore) { /* уведомление не ломает продажу */ }
      }
      if (typeof recordPerf_ === 'function') recordPerf_(Date.now() - t0);
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
