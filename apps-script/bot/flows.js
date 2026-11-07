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

  var MENU = {
    'Расход': 'expense',
    'Владелица забрала': 'withdrawal',
    'Погашение долга': 'repay',
    'Отменить продажу': 'cancel',
    'Передать смену': 'handover'
  };
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
    var shift = requireOnShift(view);
    var st = { flow: flow, step: '', d: {}, op_id: 'tg-op-' + String(updateId).padStart(10, '0') };

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
    return '';
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
    else { deps.state.clear(); return deps.send('Сценарий устарел. Начните заново из меню.'); }
    req.op_id = st.op_id;
    deps.state.clear(); // повторное нажатие «Провести» больше ничего не сделает
    var res = P.post(deps.store, ctx, req);
    deps.send('✅ Проведено. ' + summary(st).split('\n')[0]);
    deps.notify(res.notify || []);
    return res;
  }

  /** Вход: что пришло — меню, кнопка сценария или текст. Возвращает true, если сообщение обработано. */
  function handle(ctx, input, deps) {
    try {
      if (input.text === 'Отмена') { deps.state.clear(); deps.send('Отменено. Ничего не записано.'); return true; }
      if (input.text && isMenu(input.text)) { deps.state.clear(); start(ctx, input.text, input.update_id, deps); return true; }
      if (input.data && input.data.indexOf('f:') === 0) { onButton(ctx, input.data, deps); return true; }
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
