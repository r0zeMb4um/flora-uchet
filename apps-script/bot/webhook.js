/**
 * Чат-бот: вебхук Telegram.
 * Правила (docs/ARCHITECTURE.md, раздел 5): ключ в адресе, ответ только через HtmlService,
 * всё в try/catch и всегда 200, повторы отсекаются по LAST_UPDATE_ID, уведомления — после блокировки.
 */
var Webhook = (function () {
  'use strict';

  var CONSENT_TEXT_V1 =
    'Чтобы работать в боте, нужно согласие на обработку ваших данных.\n\n' +
    'Что хранится: имя, Telegram ID и ваши действия в боте (продажи, касса, смены).\n' +
    'Зачем: учёт в магазине и расчёт вашей зарплаты.\n' +
    'Где: в сервисах Google и Telegram — то есть за пределами Казахстана.\n' +
    'Оператор данных — владелица магазина; сервис хранит их по её поручению.\n' +
    'Отозвать согласие можно, написав владелице.\n\n' +
    'Версия текста: v1.';

  function ok() { return HtmlService.createHtmlOutput('ok'); }

  function handle(e, update) {
    var props = PropertiesService.getScriptProperties();
    var key = props.getProperty('WEBHOOK_KEY');
    if (!key || !e.parameter || e.parameter.k !== key) return ok(); // чужой запрос — молча

    var store;
    try {
      store = SheetsStore.open();
      var dup = store.withLock(function () {
        var last = Number(props.getProperty('LAST_UPDATE_ID') || 0);
        if (update.update_id <= last) return true;
        props.setProperty('LAST_UPDATE_ID', String(update.update_id));
        return false;
      });
      if (dup) return ok();
      process_(store, update);
    } catch (err) {
      reportError_(store, update, err);
    }
    return ok();
  }

  // ---------- разбор обновления ----------

  function process_(store, update) {
    var msg = update.message;
    var cb = update.callback_query;
    if (!msg && !cb) return;
    var chat = msg ? msg.chat : cb.message.chat;
    if (chat.type !== 'private') return; // бот работает только в личных сообщениях
    var from = (msg || cb).from;
    var tgId = String(from.id);
    var chatId = chat.id;
    if (cb) Tg.call('answerCallbackQuery', { callback_query_id: cb.id });

    var text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
    var data = cb ? String(cb.data || '') : '';

    try {
      if (text.indexOf('/start') === 0) {
        var token = text.split(/\s+/)[1];
        if (token) return showConsent_(store, chatId, token);
        return showMenu_(store, chatId, tgId, true);
      }
      if (data.indexOf('consent:') === 0) return acceptConsent_(store, chatId, from, data.slice(8));

      var me = staffByTg_(store, tgId);
      if (!me) return Tg.send(chatId, 'Нет доступа. Попросите у владелицы магазина ссылку-приглашение.');
      var ctx = { client_id: me.client_id, point_id: me.point_id, staff_id: me.staff_id, role: me.role, now: nowIso(), tg: tgId };

      if (text === 'Открыть смену') return OpenShiftFlow.start(store, ctx, chatId);
      if (data.indexOf('oc:') === 0) return OpenShiftFlow.onButton(store, ctx, chatId, data, update.update_id);
      if (text && OpenShiftFlow.waitsForInput(ctx)) return OpenShiftFlow.onText(store, ctx, chatId, text);
      return showMenu_(store, chatId, tgId, false);
    } catch (err) {
      if (err.code) return Tg.send(chatId, '⚠️ ' + Tg.esc(err.message)); // отказ по правилу — понятный ответ
      throw err;
    }
  }

  // ---------- кто пишет ----------

  function staffByTg_(store, tgId) {
    return store.rows('staff').filter(function (s) { return s.telegram_id === tgId && s.active === true; })[0] || null;
  }

  function ownersOf_(store, clientId) {
    return store.rows('staff').filter(function (s) {
      return s.client_id === clientId && s.role === 'owner' && s.active === true && s.telegram_id;
    });
  }

  // ---------- приглашение и согласие ----------

  function validInvite_(store, token) {
    var inv = store.find('invites', 'token', token)[0];
    if (!inv || inv.status !== 'active' || inv.expires_at < nowIso()) return null;
    return inv;
  }

  function showConsent_(store, chatId, token) {
    var inv = validInvite_(store, token);
    if (!inv) return Tg.send(chatId, 'Ссылка-приглашение недействительна или уже использована. Попросите у владелицы новую.');
    var staff = store.find('staff', 'staff_id', inv.staff_id)[0];
    Tg.send(chatId, 'Здравствуйте, ' + Tg.esc(staff ? staff.name : '') + '!\n\n' + Tg.esc(CONSENT_TEXT_V1), {
      reply_markup: { inline_keyboard: [[{ text: 'Согласен', callback_data: 'consent:' + token }]] }
    });
  }

  function acceptConsent_(store, chatId, from, token) {
    var tgId = String(from.id);
    var joined = store.withLock(function () {
      var inv = validInvite_(store, token);
      if (!inv) return null;
      var now = nowIso();
      store.update('staff', { staff_id: inv.staff_id, client_id: inv.client_id },
        { telegram_id: tgId, consent_at: now, consent_version: CONSENT_VERSION });
      store.update('invites', { token: token }, { status: 'used', used_by_telegram_id: tgId });
      store.append('ops_log', [{ op_id: 'join-' + token, client_id: inv.client_id, point_id: inv.point_id, shift_id: '',
        kind: 'join', actor_staff_id: inv.staff_id, status: 'posted', created_at: now, posted_at: now,
        plan_json: '', result_json: JSON.stringify({ telegram_id: tgId }) }]);
      store.append('audit', [{ ts: now, actor_telegram_id: tgId, action: 'join',
        details_json: JSON.stringify({ staff_id: inv.staff_id, consent: CONSENT_VERSION }) }]);
      return store.find('staff', 'staff_id', inv.staff_id)[0];
    });
    if (!joined) return Tg.send(chatId, 'Ссылка-приглашение недействительна или уже использована.');
    var who = Tg.esc(joined.name) + (from.username ? ' (@' + Tg.esc(from.username) + ')' : '');
    ownersOf_(store, joined.client_id).forEach(function (o) {
      if (o.telegram_id !== tgId) Tg.send(o.telegram_id, '👤 Подключился сотрудник: ' + who);
    });
    showMenu_(store, chatId, tgId, true);
  }

  // ---------- меню ----------

  function showMenu_(store, chatId, tgId, greet) {
    var me = staffByTg_(store, tgId);
    if (!me) {
      return Tg.send(chatId, 'Здравствуйте! Это бот учёта цветочного магазина — он для сотрудников.\n' +
        'Попросите у владелицы ссылку-приглашение.\n\nВаш Telegram ID: <code>' + tgId + '</code>');
    }
    var view = Ops.makeView(store, { client_id: me.client_id, point_id: me.point_id, staff_id: me.staff_id, role: me.role, now: nowIso() });
    var shift = view.openShift();
    var lines = [];
    if (greet) lines.push('Здравствуйте, ' + Tg.esc(me.name) + '!');
    var keyboard;
    if (me.role === 'owner') {
      lines.push(shift ? 'Сейчас открыта смена №' + shift.shift_no + '.' : 'Открытой смены нет.');
      lines.push('Отчёты и настройки появятся на следующем этапе.');
      keyboard = [['Меню']];
    } else if (shift) {
      lines.push('Открыта смена №' + shift.shift_no + '. Продажи — в Mini App (подключаем на этапе C).');
      keyboard = [['Меню']];
    } else {
      lines.push('Смена не открыта.');
      keyboard = [['Открыть смену']];
    }
    Tg.send(chatId, lines.join('\n'), { reply_markup: { keyboard: keyboard, resize_keyboard: true } });
  }

  // ---------- уведомления и ошибки ----------

  function notify(store, clientId, list) {
    (list || []).forEach(function (n) {
      var text = Notify.text(n);
      if (!text) return;
      if (n.to === 'owner') ownersOf_(store, clientId).forEach(function (o) { Tg.send(o.telegram_id, text); });
    });
  }

  function reportError_(store, update, err) {
    var details = { update_id: update && update.update_id, error: String(err && err.stack || err) };
    try {
      if (store) store.append('audit', [{ ts: nowIso(), actor_telegram_id: '', action: 'error', details_json: JSON.stringify(details).slice(0, 45000) }]);
    } catch (ignore) { /* не даём ошибке журнала сломать ответ Telegram */ }
    try {
      var admin = PropertiesService.getScriptProperties().getProperty('ADMIN_TELEGRAM_ID');
      if (admin) Tg.send(admin, '🛑 Ошибка бота: ' + Tg.esc(String(err && err.message || err)).slice(0, 3000));
    } catch (ignore2) { /* то же */ }
    console.error(details);
  }

  return { handle: handle, notify: notify, showMenu: showMenu_, ownersOf: ownersOf_ };
})();

/** Тексты уведомлений владелице. */
var Notify = {
  text: function (n) {
    if (n.kind === 'open_diff') {
      return '⚠️ Расхождение при приёме смены: ' + Tg.money(n.open_diff) + '. Касса считается от принятой суммы.';
    }
    if (n.kind === 'withdrawal') return '💸 Из кассы забрали ' + Tg.money(n.amount) + ' (изъятие владелицей).';
    if (n.kind === 'cancel') return '↩️ Отменён чек на ' + Tg.money(n.total) + '. Причина: ' + Tg.esc(n.reason);
    if (n.kind === 'new_item') return '🆕 Флорист добавил позицию «' + Tg.esc(n.name) + '» — на проверке.';
    return '';
  }
};
