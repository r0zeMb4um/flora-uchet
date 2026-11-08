/**
 * Сценарии кнопок чата (ТЗ, «Кнопки флориста»): расход, «Владелица забрала», погашение долга,
 * отменить продажу, передать смену. Каждый заканчивается экраном «Проверьте и подтвердите» —
 * до подтверждения ничего не записывается.
 *
 * Защита от двойного нажатия: ID операции задаётся в начале сценария, после проведения сценарий
 * стирается — повторное нажатие «Провести» уже ничего не делает.
 *
 * Модуль не зависит от Google: всё внешнее приходит в deps
 *   { store, send(text, inlineRows?), state: {get, set, clear}, notify(list), miniAppUrl }.
 */
var ChatFlows = (function () {
  'use strict';

  var C = typeof Calc !== 'undefined' ? Calc : require('../core/calc.js');
  var O = typeof Ops !== 'undefined' ? Ops : require('../core/ops.js');
  var P = typeof Posting !== 'undefined' ? Posting : require('../core/posting.js');
  var S = typeof Summary !== 'undefined' ? Summary : require('../core/summary.js');
  // Отчёты берутся в момент вызова: в Apps Script файл reports.js загружается позже этого.
  function R() { return typeof Reports !== 'undefined' ? Reports : require('./reports.js'); }

  var MENU = {
    'Расход': 'expense',
    'Владелица забрала': 'withdrawal',
    'Погашение долга': 'repay',
    'Отменить продажу': 'cancel',
    'Передать смену': 'handover',
    // Владелица
    'Сотрудники': 'staff',
    'Расходы месяца': 'expenses',
    'Предзаказы': 'preorders',
    'Отчёт за смену': 'report',
    'Отчёт за период': 'period',
    'Остатки': 'stock',
    'Должники': 'debtors',
    'Каталог': 'catalog',
    'Настройки': 'settings',
    'Закупка': 'restock',
    'Выгрузка в Excel': 'export'
  };
  var OWNER_FLOWS = { staff: true, expenses: true, preorders: true, report: true, period: true, stock: true, debtors: true, catalog: true, settings: true,
    restock: true, export: true };
  var CANCEL_ROW = [{ text: 'Отмена', callback_data: 'f:x' }];

  function money(n) {
    var sign = n < 0 ? '−' : '';
    return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function intOf(t) {
    var s = String(t || '').replace(/[\s ₸]/g, '');
    return /^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null;
  }

  function isMenu(text) { return Object.prototype.hasOwnProperty.call(MENU, text); }

  /** Проверки до начала сценария: флорист в открытой смене. */
  function requireOnShift(view) {
    if (view.ctx.role !== 'florist') throw O.opsError('FORBIDDEN', 'Это действие для флориста смены');
    var shift = view.openShift();
    if (!shift) throw O.opsError('NO_OPEN_SHIFT', 'Смена не открыта — сначала «Открыть смену»');
    if (!view.shiftStaff(shift.shift_id).some(function (s) { return s.staff_id === view.ctx.staff_id; })) {
      throw O.opsError('NOT_ON_SHIFT', 'Вы не работаете в открытой смене');
    }
    return shift;
  }

  // ---------- старт ----------

  function start(ctx, text, updateId, deps) {
    var flow = MENU[text];
    var view = O.makeView(deps.store, ctx);
    var st = { flow: flow, step: '', d: {}, op_id: 'tg-op-' + String(updateId).padStart(10, '0') };
    if (OWNER_FLOWS[flow]) {
      if (ctx.role !== 'owner' && ctx.role !== 'admin') throw O.opsError('FORBIDDEN', 'Это меню владелицы');
      return Owner.start(view, st, deps);
    }
    var shift = requireOnShift(view);

    if (flow === 'expense') {
      st.step = 'type';
      deps.state.set(st);
      return deps.send('Какой расход из кассы?', [
        [{ text: 'Доставка', callback_data: 'f:t:delivery' }, { text: 'Прочее', callback_data: 'f:t:other' }], CANCEL_ROW]);
    }
    if (flow === 'withdrawal') {
      st.step = 'amount';
      deps.state.set(st);
      return deps.send('Сколько забрала владелица? Напишите сумму цифрами, например: 10000', [CANCEL_ROW]);
    }
    if (flow === 'repay') {
      var debtors = view.rows('customers').filter(function (c) { return c.anonymized !== true; })
        .map(function (c) { return { c: c, debt: view.debtOf(c.customer_id) }; })
        .filter(function (x) { return x.debt > 0; })
        .sort(function (a, b) { return a.c.name < b.c.name ? -1 : 1; });
      if (!debtors.length) return deps.send('Должников нет.');
      st.step = 'who';
      deps.state.set(st);
      return deps.send('Кто гасит долг?', debtors.slice(0, 30).map(function (x) {
        return [{ text: x.c.name + (x.c.note ? ' (' + x.c.note + ')' : '') + ' — ' + money(x.debt), callback_data: 'f:c:' + x.c.customer_id }];
      }).concat([CANCEL_ROW]));
    }
    if (flow === 'cancel') {
      var receipts = view.rows('receipts').filter(function (r) {
        return r.shift_id === shift.shift_id && r.status === 'posted' && r.type !== 'preorder';
      }).sort(function (a, b) { return b.receipt_no - a.receipt_no; });
      if (!receipts.length) return deps.send('В этой смене нет чеков, которые можно отменить.');
      st.step = 'which';
      deps.state.set(st);
      return deps.send('Какой чек отменить? Показаны чеки этой смены.', receipts.slice(0, 20).map(function (r) {
        return [{ text: '№' + r.receipt_no + ' · ' + money(r.total) + ' · ' + String(r.created_at).slice(11, 16) + (r.type === 'bouquet' ? ' · букет' : ''),
          callback_data: 'f:r:' + r.receipt_id }];
      }).concat([CANCEL_ROW]));
    }
    if (flow === 'handover') {
      // Передача = то же закрытие (инвентаризация, пересчёт вслепую, ЗП), затем следующий флорист открывает свою смену.
      return deps.send('Передача смены — это её закрытие: инвентаризация, пересчёт кассы, зарплата. ' +
        'Затем следующий флорист нажимает «Открыть смену» и принимает кассу.', [
        [{ text: 'Закрыть смену в кассе', web_app: { url: deps.miniAppUrl + '#close' } }]]);
    }
    return null;
  }

  // ---------- кнопки ----------

  function onButton(ctx, data, deps) {
    var st = deps.state.get();
    if (data === 'f:x') { deps.state.clear(); return deps.send('Отменено. Ничего не записано.'); }
    if (!st) return deps.send('Эта кнопка уже не действует. Начните заново из меню.');
    var view = O.makeView(deps.store, ctx);
    if (OWNER_FLOWS[st.flow]) {
      if (data === 'f:ok' && st.step === 'confirm') return commit(ctx, st, deps);
      return Owner.onButton(view, st, data, deps);
    }

    if (st.flow === 'expense' && st.step === 'type' && data.indexOf('f:t:') === 0) {
      st.d.type = data.slice(4) === 'delivery' ? 'delivery' : 'other';
      st.step = 'amount';
      deps.state.set(st);
      return deps.send((st.d.type === 'delivery' ? 'Доставка' : 'Прочий расход') + '. Сумма цифрами?', [CANCEL_ROW]);
    }
    if (st.flow === 'expense' && st.step === 'comment' && data === 'f:nc') {
      st.d.comment = '';
      return confirm(st, deps);
    }
    if (st.flow === 'repay' && st.step === 'who' && data.indexOf('f:c:') === 0) {
      var id = data.slice(4);
      var c = view.customer(id);
      var debt = c ? view.debtOf(id) : 0;
      if (!c || debt <= 0) { deps.state.clear(); return deps.send('У этого покупателя нет долга.'); }
      st.d = { customer_id: id, name: c.name, debt: debt };
      st.step = 'amount';
      deps.state.set(st);
      return deps.send('Долг: ' + esc(c.name) + ' — <b>' + money(debt) + '</b>. Сколько вносят сейчас? Напишите сумму или нажмите кнопку.', [
        [{ text: 'Весь долг — ' + money(debt), callback_data: 'f:all' }], CANCEL_ROW]);
    }
    if (st.flow === 'repay' && st.step === 'amount' && data === 'f:all') {
      st.d.amount = st.d.debt;
      return askMethod(st, deps);
    }
    if (st.flow === 'repay' && st.step === 'method' && data.indexOf('f:m:') === 0) {
      st.d.method = data.slice(4) === 'card' ? 'card' : 'cash';
      return confirm(st, deps);
    }
    if (st.flow === 'cancel' && st.step === 'which' && data.indexOf('f:r:') === 0) {
      var r = view.receipt(data.slice(4));
      if (!r || r.status !== 'posted') { deps.state.clear(); return deps.send('Чек не найден или уже отменён.'); }
      st.d = { receipt_id: r.receipt_id, receipt_no: r.receipt_no, total: r.total };
      st.step = 'reason';
      deps.state.set(st);
      return deps.send('Чек №' + r.receipt_no + ' на ' + money(r.total) + '. Напишите причину отмены.', [CANCEL_ROW]);
    }
    if (data === 'f:ok' && st.step === 'confirm') return commit(ctx, st, deps);
    return deps.send('Эта кнопка уже не действует. Начните заново из меню.');
  }

  // ---------- текст ----------

  function onText(ctx, text, deps) {
    var st = deps.state.get();
    if (!st) return null;
    if (OWNER_FLOWS[st.flow]) return Owner.onText(O.makeView(deps.store, ctx), st, text, deps);
    if (st.step === 'amount') {
      var n = intOf(text);
      if (!n) return deps.send('Напишите сумму цифрами, например: 2500');
      st.d.amount = n;
      if (st.flow === 'expense') {
        st.step = 'comment';
        deps.state.set(st);
        return deps.send('Комментарий (кому, за что)? Или нажмите «Без комментария».', [
          [{ text: 'Без комментария', callback_data: 'f:nc' }], CANCEL_ROW]);
      }
      if (st.flow === 'repay') {
        if (n > st.d.debt) return deps.send('Это больше долга (' + money(st.d.debt) + '). Напишите сумму не больше долга.');
        return askMethod(st, deps);
      }
      return confirm(st, deps); // withdrawal
    }
    if (st.step === 'comment') {
      st.d.comment = String(text).trim().slice(0, 200);
      return confirm(st, deps);
    }
    if (st.step === 'reason') {
      var reason = String(text).trim();
      if (!reason) return deps.send('Напишите причину отмены.');
      st.d.reason = reason.slice(0, 200);
      return confirm(st, deps);
    }
    return deps.send('Нажмите одну из кнопок выше или «Отмена».');
  }

  function askMethod(st, deps) {
    st.step = 'method';
    deps.state.set(st);
    return deps.send('Как вносят ' + money(st.d.amount) + '?', [
      [{ text: 'Наличными', callback_data: 'f:m:cash' }, { text: 'Безнал', callback_data: 'f:m:card' }], CANCEL_ROW]);
  }

  // ---------- «Проверьте и подтвердите» ----------

  function summary(st) {
    var d = st.d;
    if (st.flow === 'expense') return (d.type === 'delivery' ? 'Доставка' : 'Прочий расход') + ' из кассы: <b>' + money(d.amount) + '</b>' + (d.comment ? '\nКомментарий: ' + esc(d.comment) : '');
    if (st.flow === 'withdrawal') return 'Владелица забрала из кассы: <b>' + money(d.amount) + '</b>';
    if (st.flow === 'repay') return 'Погашение долга: ' + esc(d.name) + ' — <b>' + money(d.amount) + '</b> ' + (d.method === 'card' ? 'безналом' : 'наличными') + '\nОстанется долг: ' + money(d.debt - d.amount);
    if (st.flow === 'cancel') return 'Отменить чек №' + d.receipt_no + ' на <b>' + money(d.total) + '</b>\nПричина: ' + esc(d.reason) + '\nТовар вернётся на склад, оплаты и долг по чеку аннулируются.';
    return Owner.summary(st);
  }

  function confirm(st, deps) {
    st.step = 'confirm';
    deps.state.set(st);
    return deps.send('Проверьте и подтвердите:\n\n' + summary(st), [
      [{ text: 'Провести', callback_data: 'f:ok' }], CANCEL_ROW]);
  }

  function commit(ctx, st, deps) {
    var d = st.d;
    var req;
    if (st.flow === 'expense') req = { kind: 'cash_out', payload: { type: d.type, amount: d.amount, comment: d.comment } };
    else if (st.flow === 'withdrawal') req = { kind: 'withdrawal', payload: { amount: d.amount } };
    else if (st.flow === 'repay') req = { kind: 'debt_repay', payload: { customer_id: d.customer_id, method: d.method, amount: d.amount } };
    else if (st.flow === 'cancel') req = { kind: 'cancel', payload: { receipt_id: d.receipt_id, reason: d.reason } };
    else if (OWNER_FLOWS[st.flow] && d.req) req = d.req;
    else { deps.state.clear(); return deps.send('Сценарий устарел. Начните заново из меню.'); }
    req.op_id = st.op_id;
    deps.state.clear(); // повторное нажатие «Провести» больше ничего не сделает
    var res = P.post(deps.store, ctx, req);
    deps.send('✅ Проведено. ' + summary(st).split('\n')[0]);
    if (res.result && res.result.token) {
      deps.send('Ссылка-приглашение (одноразовая, действует 48 часов). Перешлите её флористу:\n' +
        'https://t.me/' + deps.botUsername + '?start=' + res.result.token);
    }
    deps.notify(res.notify || []);
    return res;
  }

  // ---------- меню владелицы ----------

  var Owner = {
    start: function (view, st, deps) {
      if (st.flow === 'staff') return Owner.staffList(view, st, deps);
      if (st.flow === 'expenses') {
        var items = String(view.settings().expense_items || 'Аренда').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
        st.step = 'item';
        st.d = { items: items };
        deps.state.set(st);
        var month = view.ctx.now.slice(0, 7);
        var sums = {};
        view.rows('owner_expenses').filter(function (e) { return e.month === month; })
          .forEach(function (e) { sums[e.item] = (sums[e.item] || 0) + e.amount; });
        var lines = Object.keys(sums).map(function (k) { return esc(k) + ': ' + money(sums[k]); });
        return deps.send('Расходы за ' + month + (lines.length ? ':\n' + lines.join('\n') : ': пока нет.') + '\n\nКакую статью внести?',
          items.map(function (it, i) { return [{ text: it, callback_data: 'o:ei:' + i }]; })
            .concat([[{ text: 'Другая статья', callback_data: 'o:ei:new' }], CANCEL_ROW]));
      }
      if (st.flow === 'preorders') {
        var pre = view.rows('receipts').filter(function (r) {
          return r.type === 'preorder' && r.status === 'posted' && (r.assembly_status === 'waiting' || r.assembly_status === 'assembled');
        }).sort(function (a, b) { return a.pickup_date < b.pickup_date ? -1 : 1; });
        if (!pre.length) return deps.send('Активных предзаказов нет.');
        st.step = 'pick';
        deps.state.set(st);
        return deps.send('Активные предзаказы. Выберите, чтобы отменить:', pre.slice(0, 20).map(function (r) {
          var c = view.customer(r.customer_id);
          return [{ text: r.pickup_date.slice(8, 10) + '.' + r.pickup_date.slice(5, 7) + ' · ' + (c ? c.name : '') + ' · ' + money(r.total), callback_data: 'o:p:' + r.receipt_id }];
        }).concat([CANCEL_ROW]));
      }
      if (st.flow === 'catalog') {
        st.step = 'pick';
        deps.state.set(st);
        var cat = view.rows('catalog').slice().sort(function (a, b) {
          var ra = a.status === 'review' ? 0 : a.status === 'active' ? 1 : 2;
          var rb = b.status === 'review' ? 0 : b.status === 'active' ? 1 : 2;
          return ra - rb || (a.name < b.name ? -1 : 1);
        });
        var review = cat.filter(function (c) { return c.status === 'review'; }).length;
        return deps.send('Каталог' + (review ? ' — на проверке: ' + review + ' (сверху)' : '') + '. Выберите позицию:', cat.slice(0, 60).map(function (c) {
          var mark = c.status === 'review' ? '⚠️ ' : c.status === 'hidden' ? '🚫 ' : '';
          return [{ text: mark + c.name + ' · ' + money(c.sale_price) + ' · мин. ' + c.min_stock, callback_data: 'o:ci:' + c.item_id }];
        }).concat([CANCEL_ROW]));
      }
      if (st.flow === 'settings') {
        var se = view.settings();
        st.step = 'pick';
        deps.state.set(st);
        return deps.send('Настройки точки:\nРазмен (всегда в кассе): ' + money(se.change_fund) + '\nНапоминание о незакрытой смене: ' + (se.reminder_time || '22:00') +
          '\nСтатьи расходов месяца: ' + esc(String(se.expense_items || '').split(';').join(', ')) + '\n\nЧто изменить?', [
          [{ text: 'Размен', callback_data: 'o:se:change_fund' }], [{ text: 'Время напоминания', callback_data: 'o:se:reminder_time' }],
          [{ text: 'Статьи расходов', callback_data: 'o:se:expense_items' }], CANCEL_ROW]);
      }
      if (st.flow === 'restock') return deps.send(R().restockText(S.restock(view)));
      if (st.flow === 'export') {
        st.step = 'range';
        deps.state.set(st);
        return deps.send('Выгрузить в Excel: сводка, смены, чеки, должники и остатки. За какой период?', [
          [{ text: 'Последние 7 дней', callback_data: 'o:xp:7' }],
          [{ text: 'Этот месяц', callback_data: 'o:xp:cur' }, { text: 'Прошлый месяц', callback_data: 'o:xp:prev' }], CANCEL_ROW]);
      }
      if (st.flow === 'stock') return deps.send(R().stockText(S.stock(view), view.ctx.now));
      if (st.flow === 'debtors') return deps.send(R().debtorsText(S.debtors(view)));
      if (st.flow === 'period') {
        st.step = 'range';
        deps.state.set(st);
        return deps.send('Сводка за какой период?', [
          [{ text: 'Последние 7 дней', callback_data: 'o:pd:7' }],
          [{ text: 'Этот месяц', callback_data: 'o:pd:cur' }, { text: 'Прошлый месяц', callback_data: 'o:pd:prev' }], CANCEL_ROW]);
      }
      if (st.flow === 'report') {
        var shifts = view.rows('shifts').filter(function (s) { return s.status === 'closed'; })
          .sort(function (a, b) { return a.closed_at < b.closed_at ? 1 : -1; });
        if (!shifts.length) return deps.send('Закрытых смен пока нет.');
        if (shifts.length === 1) return deps.send(deps.reportText(shifts[0].shift_id));
        st.step = 'pick';
        deps.state.set(st);
        return deps.send('Отчёт какой смены?', shifts.slice(0, 8).map(function (s) {
          return [{ text: '№' + s.shift_no + ' · ' + s.shift_date.slice(8, 10) + '.' + s.shift_date.slice(5, 7), callback_data: 'o:r:' + s.shift_id }];
        }).concat([CANCEL_ROW]));
      }
      return null;
    },

    staffList: function (view, st, deps) {
      st.step = 'pick';
      deps.state.set(st);
      var florists = view.rows('staff').filter(function (s) { return s.role === 'florist'; });
      return deps.send('Флористы точки. Выберите, чтобы дать новую ссылку или отключить доступ:', florists.map(function (s) {
        var mark = s.active !== true ? '⛔ отключена' : s.telegram_id ? '✅ подключена' : '⏳ ждёт входа';
        return [{ text: s.name + ' · ' + money(s.shift_rate) + ' + ' + (s.pct_bp / 100) + '% · ' + mark, callback_data: 'o:s:' + s.staff_id }];
      }).concat([[{ text: '+ Добавить флориста', callback_data: 'o:add' }], CANCEL_ROW]));
    },

    onButton: function (view, st, data, deps) {
      var d = st.d;
      if (st.flow === 'staff' && data === 'o:add') {
        st.step = 'name'; st.d = {}; deps.state.set(st);
        return deps.send('Как зовут нового флориста? Только имя.', [CANCEL_ROW]);
      }
      if (st.flow === 'staff' && data.indexOf('o:s:') === 0) {
        var s = view.staff(data.slice(4));
        if (!s) return deps.send('Сотрудник не найден.');
        st.d = { staff_id: s.staff_id, name: s.name };
        st.step = 'act'; deps.state.set(st);
        var rows = s.active === true
          ? [[{ text: 'Новая ссылка-приглашение', callback_data: 'o:inv' }], [{ text: 'Отключить доступ', callback_data: 'o:off' }]]
          : [[{ text: 'Вернуть доступ', callback_data: 'o:on' }]];
        return deps.send(esc(s.name) + ': ' + (s.active !== true ? 'доступ отключён' : s.telegram_id ? 'подключена к боту' : 'ещё не входила по ссылке'),
          rows.concat([CANCEL_ROW]));
      }
      if (st.flow === 'staff' && st.step === 'act' && (data === 'o:inv' || data === 'o:off' || data === 'o:on')) {
        d.req = data === 'o:inv'
          ? { kind: 'staff_invite', payload: { staff_id: d.staff_id, invite_token: deps.newToken() } }
          : { kind: 'staff_set_active', payload: { staff_id: d.staff_id, active: data === 'o:on' } };
        d.what = data;
        return confirm(st, deps);
      }
      if (st.flow === 'expenses' && st.step === 'item' && data.indexOf('o:ei:') === 0) {
        var k = data.slice(5);
        if (k === 'new') { st.step = 'item_name'; deps.state.set(st); return deps.send('Название статьи (например, «Налоги»):', [CANCEL_ROW]); }
        d.item = d.items[Number(k)];
        if (!d.item) return deps.send('Статья не найдена.');
        return Owner.askMonth(view, st, deps);
      }
      if (st.flow === 'expenses' && st.step === 'month' && data.indexOf('o:mo:') === 0) {
        d.month = data.slice(5);
        st.step = 'amount'; deps.state.set(st);
        var prev = Owner.prevMonth(d.month);
        var last = view.rows('owner_expenses').filter(function (e) { return e.month === prev && e.item === d.item; })
          .reduce(function (a, e) { return a + e.amount; }, 0);
        var hint = last > 0 ? [[{ text: 'Как в прошлом месяце: ' + money(last), callback_data: 'o:am:' + last }]] : [];
        return deps.send(esc(d.item) + ' за ' + d.month + '. Сумма цифрами?', hint.concat([CANCEL_ROW]));
      }
      if (st.flow === 'expenses' && st.step === 'amount' && data.indexOf('o:am:') === 0) {
        d.amount = Number(data.slice(5));
        d.req = { kind: 'owner_expense', payload: { month: d.month, item: d.item, amount: d.amount } };
        return confirm(st, deps);
      }
      if (st.flow === 'preorders' && st.step === 'pick' && data.indexOf('o:p:') === 0) {
        var r = view.receipt(data.slice(4));
        if (!r || r.status !== 'posted') return deps.send('Предзаказ не найден.');
        var paid = view.rows('payments').filter(function (p) { return p.receipt_id === r.receipt_id; })
          .reduce(function (a, p) { return a + (p.kind === 'refund' ? -p.amount : p.amount); }, 0);
        var c = view.customer(r.customer_id);
        st.d = { receipt_id: r.receipt_id, name: c ? c.name : '', total: r.total, paid: paid, assembled: r.assembly_status === 'assembled' };
        if (paid <= 0) { st.d.refund = 'keep'; return Owner.askStock(st, deps); }
        st.step = 'refund'; deps.state.set(st);
        var opts = [];
        if (view.openShift()) opts.push([{ text: 'Вернуть ' + money(paid) + ' наличными из кассы', callback_data: 'o:rf:cash' }]);
        opts.push([{ text: 'Вернуть ' + money(paid) + ' на карту', callback_data: 'o:rf:card' }], [{ text: 'Аванс остаётся магазину', callback_data: 'o:rf:keep' }]);
        return deps.send('Отмена предзаказа: ' + esc(st.d.name) + ', ' + money(r.total) + ', аванс ' + money(paid) + '. Что с авансом?', opts.concat([CANCEL_ROW]));
      }
      if (st.flow === 'preorders' && st.step === 'refund' && data.indexOf('o:rf:') === 0) {
        d.refund = data.slice(5);
        return Owner.askStock(st, deps);
      }
      if (st.flow === 'preorders' && st.step === 'stock' && data.indexOf('o:rs:') === 0) {
        d.return_stock = data === 'o:rs:1';
        st.step = 'reason'; deps.state.set(st);
        return deps.send('Причина отмены?', [CANCEL_ROW]);
      }
      if (st.flow === 'catalog' && data.indexOf('o:ci:') === 0) {
        var it = view.item(data.slice(5));
        if (!it) return deps.send('Позиция не найдена.');
        st.d = { item_id: it.item_id, name: it.name, status: it.status };
        st.step = 'act'; deps.state.set(st);
        var acts = [];
        if (it.status === 'review') acts.push([{ text: '✅ Подтвердить позицию', callback_data: 'o:ca:active' }]);
        acts.push([{ text: 'Цена продажи', callback_data: 'o:ca:price' }, { text: 'Минимальный остаток', callback_data: 'o:ca:min' }]);
        acts.push([it.status === 'hidden' ? { text: 'Вернуть в продажу', callback_data: 'o:ca:active' } : { text: 'Скрыть из продажи', callback_data: 'o:ca:hidden' }]);
        return deps.send(esc(it.name) + '\nЦена ' + money(it.sale_price) + ' · закупка ' + money(it.last_cost) + ' · мин. остаток ' + it.min_stock +
          ' · ' + (it.status === 'review' ? 'на проверке' : it.status === 'hidden' ? 'скрыта' : 'в продаже'), acts.concat([CANCEL_ROW]));
      }
      if (st.flow === 'catalog' && st.step === 'act' && data.indexOf('o:ca:') === 0) {
        var a = data.slice(5);
        if (a === 'price' || a === 'min') { d.field = a; st.step = 'value'; deps.state.set(st); return deps.send(a === 'price' ? 'Новая цена продажи, ₸?' : 'Минимальный остаток, шт?', [CANCEL_ROW]); }
        d.req = { kind: 'catalog_edit', payload: { item_id: d.item_id, status: a } };
        d.what = a;
        return confirm(st, deps);
      }
      if (st.flow === 'settings' && data.indexOf('o:se:') === 0) {
        st.d = { field: data.slice(5) };
        st.step = 'value'; deps.state.set(st);
        var ask = { change_fund: 'Размен, ₸? Например: 5000', reminder_time: 'Время напоминания ЧЧ:ММ? Например: 21:30',
          expense_items: 'Статьи расходов через запятую? Например: Аренда, Коммуналка, Интернет, Налоги' };
        return deps.send(ask[st.d.field] || 'Значение?', [CANCEL_ROW]);
      }
      if (st.flow === 'period' && data.indexOf('o:pd:') === 0) {
        deps.state.clear();
        var range = Owner.range(view.ctx.now.slice(0, 10), data.slice(5));
        var names = { staff: {} };
        view.rows('staff').forEach(function (x) { names.staff[x.staff_id] = x.name; });
        var pr = S.prevRange(range[0], range[1]);
        return deps.send(R().periodText(S.period(view, range[0], range[1]), names,
          { prev: S.period(view, pr[0], pr[1]), top: S.top(view, range[0], range[1], 5) }));
      }
      if (st.flow === 'export' && data.indexOf('o:xp:') === 0) {
        deps.state.clear();
        var xr = Owner.range(view.ctx.now.slice(0, 10), data.slice(5));
        deps.send('Готовлю файл за ' + xr[0].split('-').reverse().join('.') + ' — ' + xr[1].split('-').reverse().join('.') + '…');
        return deps.exportExcel(xr[0], xr[1]);
      }
      if (st.flow === 'report' && data.indexOf('o:r:') === 0) {
        deps.state.clear();
        return deps.send(deps.reportText(data.slice(4)));
      }
      return deps.send('Эта кнопка уже не действует. Начните заново из меню.');
    },

    onText: function (view, st, text, deps) {
      var d = st.d;
      var t = String(text).trim();
      if (st.flow === 'staff' && st.step === 'name') {
        if (!t || t.length > 40) return deps.send('Имя — до 40 символов.');
        d.name = t; st.step = 'rate'; deps.state.set(st);
        return deps.send('Ставка за смену, ₸? Например: 5000');
      }
      if (st.flow === 'staff' && st.step === 'rate') {
        var rate = intOf(t);
        if (!rate) return deps.send('Ставка цифрами, например: 5000');
        d.rate = rate; st.step = 'pct'; deps.state.set(st);
        return deps.send('Процент от продаж? Например: 3 или 2,5');
      }
      if (st.flow === 'staff' && st.step === 'pct') {
        var v = Number(t.replace(',', '.').replace('%', ''));
        var bp = Math.round(v * 100);
        if (!/^\d{1,3}([.,]\d{1,2})?%?$/.test(t) || !isFinite(v) || bp > 10000) return deps.send('Процент числом от 0 до 100, например: 3 или 2,5');
        d.pct_bp = bp;
        d.req = { kind: 'staff_add', payload: { name: d.name, shift_rate: d.rate, pct_bp: bp, invite_token: deps.newToken() } };
        return confirm(st, deps);
      }
      if (st.flow === 'expenses' && st.step === 'item_name') {
        if (!t || t.length > 60) return deps.send('Название до 60 символов.');
        d.item = t;
        return Owner.askMonth(view, st, deps);
      }
      if (st.flow === 'expenses' && st.step === 'amount') {
        var a = intOf(t);
        if (!a) return deps.send('Сумма цифрами, например: 120000');
        d.amount = a;
        d.req = { kind: 'owner_expense', payload: { month: d.month, item: d.item, amount: a } };
        return confirm(st, deps);
      }
      if (st.flow === 'catalog' && st.step === 'value') {
        var n = d.field === 'min' ? (/^\d{1,6}$/.test(t) ? Number(t) : null) : intOf(t);
        if (n === null) return deps.send('Число цифрами.');
        d.value = n;
        d.req = { kind: 'catalog_edit', payload: d.field === 'price' ? { item_id: d.item_id, sale_price: n } : { item_id: d.item_id, min_stock: n } };
        return confirm(st, deps);
      }
      if (st.flow === 'settings' && st.step === 'value') {
        var payload = {};
        if (d.field === 'change_fund') {
          if (!/^\d{1,9}$/.test(t.replace(/\s/g, ''))) return deps.send('Сумма цифрами, например: 5000');
          payload.change_fund = Number(t.replace(/\s/g, ''));
        } else if (d.field === 'reminder_time') {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return deps.send('Время ЧЧ:ММ, например: 21:30');
          payload.reminder_time = t;
        } else payload.expense_items = t;
        d.value = t;
        d.req = { kind: 'settings_edit', payload: payload };
        return confirm(st, deps);
      }
      if (st.flow === 'preorders' && st.step === 'reason') {
        if (!t) return deps.send('Напишите причину.');
        d.reason = t.slice(0, 200);
        var payload = { receipt_id: d.receipt_id, reason: d.reason, return_stock: !!d.return_stock };
        if (d.refund === 'cash' || d.refund === 'card') payload.refund = { method: d.refund, amount: d.paid };
        d.req = { kind: 'preorder_cancel', payload: payload };
        return confirm(st, deps);
      }
      return deps.send('Нажмите одну из кнопок выше или «Отмена».');
    },

    askMonth: function (view, st, deps) {
      var cur = view.ctx.now.slice(0, 7);
      var prev = Owner.prevMonth(cur);
      st.step = 'month'; deps.state.set(st);
      return deps.send(esc(st.d.item) + '. За какой месяц?', [
        [{ text: 'Этот: ' + cur, callback_data: 'o:mo:' + cur }, { text: 'Прошлый: ' + prev, callback_data: 'o:mo:' + prev }], CANCEL_ROW]);
    },
    askStock: function (st, deps) {
      if (!st.d.assembled) { st.d.return_stock = false; st.step = 'reason'; deps.state.set(st); return deps.send('Причина отмены?', [CANCEL_ROW]); }
      st.step = 'stock'; deps.state.set(st);
      return deps.send('Букет уже собран. Вернуть цветы на склад?', [
        [{ text: 'Да, вернуть на склад', callback_data: 'o:rs:1' }, { text: 'Нет', callback_data: 'o:rs:0' }], CANCEL_ROW]);
    },
    /** Период: '7' — последние 7 дней включая сегодня; 'cur' — с 1-го числа по сегодня; 'prev' — весь прошлый месяц. */
    range: function (today, kind) {
      if (kind === '7') return [new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10), today];
      if (kind === 'cur') return [today.slice(0, 8) + '01', today];
      var pm = Owner.prevMonth(today.slice(0, 7));
      var last = new Date(Date.parse(today.slice(0, 8) + '01T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      return [pm + '-01', last];
    },
    prevMonth: function (m) {
      var y = Number(m.slice(0, 4));
      var mo = Number(m.slice(5, 7)) - 1;
      if (mo === 0) { y -= 1; mo = 12; }
      return y + '-' + (mo < 10 ? '0' : '') + mo;
    },
    summary: function (st) {
      var d = st.d;
      if (st.flow === 'staff' && d.req && d.req.kind === 'staff_add') {
        return 'Новый флорист: <b>' + esc(d.name) + '</b>\nСтавка ' + money(d.rate) + ' + ' + (d.pct_bp / 100) + '% от продаж\nПосле подтверждения бот даст ссылку-приглашение.';
      }
      if (st.flow === 'staff') {
        return (d.what === 'o:inv' ? 'Новая ссылка для ' : d.what === 'o:off' ? 'Отключить доступ: ' : 'Вернуть доступ: ') + '<b>' + esc(d.name) + '</b>' +
          (d.what === 'o:inv' ? '\nСтарые ссылки перестанут работать.' : d.what === 'o:off' ? '\nДоступ пропадёт сразу, прошлые записи останутся.' : '');
      }
      if (st.flow === 'catalog') {
        if (d.what) return (d.what === 'hidden' ? 'Скрыть из продажи: ' : d.status === 'review' ? 'Подтвердить позицию: ' : 'Вернуть в продажу: ') + '<b>' + esc(d.name) + '</b>';
        return esc(d.name) + ': ' + (d.field === 'price' ? 'цена продажи <b>' + money(d.value) + '</b>' : 'минимальный остаток <b>' + d.value + ' шт</b>');
      }
      if (st.flow === 'settings') {
        var label = { change_fund: 'Размен', reminder_time: 'Время напоминания', expense_items: 'Статьи расходов' }[d.field];
        return label + ': <b>' + esc(String(d.value)) + '</b>';
      }
      if (st.flow === 'expenses') return 'Расход месяца: ' + esc(d.item) + ' за ' + d.month + ' — <b>' + money(d.amount) + '</b>\nНе из кассы, вычитается из прибыли месяца.';
      if (st.flow === 'preorders') {
        var adv = d.refund === 'cash' ? 'Аванс ' + money(d.paid) + ' вернуть наличными из кассы'
          : d.refund === 'card' ? 'Аванс ' + money(d.paid) + ' вернуть на карту'
          : d.paid > 0 ? 'Аванс ' + money(d.paid) + ' остаётся магазину' : 'Аванса не было';
        return 'Отменить предзаказ: ' + esc(d.name) + ', ' + money(d.total) + '\n' + adv +
          (d.assembled ? '\nБукет: ' + (d.return_stock ? 'вернуть на склад' : 'не возвращать') : '') + '\nПричина: ' + esc(d.reason);
      }
      return '';
    }
  };

  /** Вход: что пришло — меню, кнопка сценария или текст. Возвращает true, если сообщение обработано. */
  function handle(ctx, input, deps) {
    try {
      if (input.text === 'Отмена') { deps.state.clear(); deps.send('Отменено. Ничего не записано.'); return true; }
      if (input.text && isMenu(input.text)) { deps.state.clear(); start(ctx, input.text, input.update_id, deps); return true; }
      if (input.data && (input.data.indexOf('f:') === 0 || input.data.indexOf('o:') === 0)) { onButton(ctx, input.data, deps); return true; }
      if (input.text && deps.state.get()) { onText(ctx, input.text, deps); return true; }
      return false;
    } catch (err) {
      if (!err.code) throw err;
      deps.state.clear();
      deps.send('⚠️ ' + esc(err.message));
      return true;
    }
  }

  return { handle: handle, isMenu: isMenu, MENU: MENU, money: money };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChatFlows;
