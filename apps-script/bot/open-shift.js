/**
 * Сценарий «Открыть смену» в чате (ТЗ, «Кнопки флориста»):
 * бот показывает остаток прошлой смены → флорист подтверждает или вводит другую сумму →
 * выбирает второго флориста или «работаю одна» → смена проводится операцией open_shift.
 * Промежуточные ответы хранятся 15 минут в кэше скрипта; в таблицу пишется только итог.
 */
var OpenShiftFlow = (function () {
  'use strict';

  var TTL = 900;
  function key(ctx) { return 'oc:' + ctx.tg; }
  function load(ctx) { var v = CacheService.getScriptCache().get(key(ctx)); return v ? JSON.parse(v) : null; }
  function save(ctx, st) { CacheService.getScriptCache().put(key(ctx), JSON.stringify(st), TTL); }
  function clear(ctx) { CacheService.getScriptCache().remove(key(ctx)); }

  function requireFlorist(ctx) {
    if (ctx.role !== 'florist') throw Ops.opsError('FORBIDDEN', 'Смену открывает флорист');
  }

  function start(store, ctx, chatId) {
    requireFlorist(ctx);
    var view = Ops.makeView(store, ctx);
    var open = view.openShift();
    if (open) throw Ops.opsError('SHIFT_ALREADY_OPEN', 'Смена №' + open.shift_no + ' уже открыта');
    var closed = view.rows('shifts').filter(function (s) { return s.status === 'closed'; })
      .sort(function (a, b) { return a.closed_at < b.closed_at ? -1 : 1; });
    var prev = closed.length ? closed[closed.length - 1].next_cash : 0;
    save(ctx, { step: 'cash', prev: prev });
    Tg.send(chatId,
      'Прошлая смена оставила в кассе <b>' + Tg.money(prev) + '</b> (размен уже внутри).\n' +
      'Пересчитайте наличные в кассе.', {
        reply_markup: { inline_keyboard: [
          [{ text: 'Верно, ' + Tg.money(prev), callback_data: 'oc:ok' }],
          [{ text: 'Другая сумма', callback_data: 'oc:other' }]
        ] }
      });
  }

  function waitsForInput(ctx) {
    var st = load(ctx);
    return !!st && st.step === 'cash_input';
  }

  function onText(store, ctx, chatId, text) {
    var st = load(ctx);
    var clean = text.replace(/[\s ₸]/g, '');
    if (!/^\d{1,9}$/.test(clean)) return Tg.send(chatId, 'Напишите сумму цифрами, например: 14500');
    st.cash = Number(clean);
    askPartner(store, ctx, chatId, st);
  }

  function askPartner(store, ctx, chatId, st) {
    st.step = 'partner';
    save(ctx, st);
    var others = store.rows('staff').filter(function (s) {
      return s.client_id === ctx.client_id && s.point_id === ctx.point_id && s.role === 'florist' &&
        s.active === true && s.staff_id !== ctx.staff_id;
    });
    var rows = others.map(function (s) { return [{ text: 'Со мной ' + s.name, callback_data: 'oc:with:' + s.staff_id }]; });
    rows.push([{ text: 'Работаю без напарника', callback_data: 'oc:alone' }]);
    Tg.send(chatId, 'Принято наличных: <b>' + Tg.money(st.cash) + '</b>.\nКто работает с вами в смене?', {
      reply_markup: { inline_keyboard: rows }
    });
  }

  function onButton(store, ctx, chatId, data, updateId) {
    requireFlorist(ctx);
    var st = load(ctx);
    if (!st) return Tg.send(chatId, 'Время на открытие смены вышло. Нажмите «Открыть смену» ещё раз.');
    if (data === 'oc:ok' && st.step === 'cash') { st.cash = st.prev; return askPartner(store, ctx, chatId, st); }
    if (data === 'oc:other' && st.step === 'cash') {
      st.step = 'cash_input';
      save(ctx, st);
      return Tg.send(chatId, 'Сколько наличных в кассе? Напишите число, например: 14500');
    }
    if ((data === 'oc:alone' || data.indexOf('oc:with:') === 0) && st.step === 'partner') {
      var team = [ctx.staff_id];
      if (data !== 'oc:alone') team.push(data.slice(8));
      var res = Posting.post(store, ctx, {
        op_id: 'tg-op-' + String(updateId).padStart(10, '0'), kind: 'open_shift', payload: { florist_ids: team, open_cash: st.cash }
      });
      clear(ctx);
      var r = res.result;
      var msg = '✅ Смена №' + r.shift_no + ' открыта. В кассе: ' + Tg.money(st.cash) + '.';
      if (r.open_diff) msg += '\nРасхождение при приёме: ' + Tg.money(r.open_diff) + ' — владелица получила сообщение.';
      Tg.send(chatId, msg);
      Webhook.notify(store, ctx.client_id, res.notify);
      return Webhook.showMenu(store, chatId, ctx.tg, false);
    }
    return Tg.send(chatId, 'Эта кнопка уже не действует. Нажмите «Открыть смену» ещё раз.');
  }

  return { start: start, waitsForInput: waitsForInput, onText: onText, onButton: onButton };
})();
