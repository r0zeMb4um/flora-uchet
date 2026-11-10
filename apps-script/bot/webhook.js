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
    if (cb) {
      Tg.call('answerCallbackQuery', { callback_query_id: cb.id });
      // Убираем кнопки из сообщения — повторно нажать уже нельзя.
      try { Tg.call('editMessageReplyMarkup', { chat_id: chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (ignore) { /* сообщение могло устареть */ }
    }

    var text = msg && typeof msg.text === 'string' ? msg.text.trim() : '';
    var data = cb ? String(cb.data || '') : '';

    try {
      if (text === '/id') return Tg.send(chatId, 'Ваш Telegram ID: <code>' + tgId + '</code>');
      // Администратор прислал гифку или видео — отвечаем её file_id (его вписывают в свойства GUIDE_GIF_FLORIST / GUIDE_GIF_OWNER).
      var media = msg && (msg.animation || msg.video || (msg.document && /^(video|image\/gif)/.test(String(msg.document.mime_type || '')) ? msg.document : null));
      if (media && tgId === String(PropertiesService.getScriptProperties().getProperty('ADMIN_TELEGRAM_ID') || '')) {
        return Tg.send(chatId, 'file_id этой гифки:\n<code>' + Tg.esc(media.file_id) + '</code>\n\nВставьте его в свойство скрипта GUIDE_GIF_FLORIST (для флористов) или GUIDE_GIF_OWNER (для владелицы).');
      }
      if (text.indexOf('/start') === 0) {
        var token = text.split(/\s+/)[1];
        if (token) return showConsent_(store, chatId, token);
        return showMenu_(store, chatId, tgId, true);
      }
      if (data.indexOf('consent:') === 0) return acceptConsent_(store, chatId, from, data.slice(8));

      var me = staffByTg_(store, tgId);
      if (!me) return Tg.send(chatId, 'Нет доступа. Попросите у владелицы магазина ссылку-приглашение.\n' + Guide.supportLine());
      var ctx = { client_id: me.client_id, point_id: me.point_id, staff_id: me.staff_id, role: me.role, now: nowIso(), tg: tgId };

      if (text === '/help' || text === 'Как пользоваться') return sendGuide_(chatId, me.role, false);
      if (text === '/support' || text === 'Поддержка') return sendSupport_(chatId);
      if (text === 'Открыть смену') { flowDeps_(store, ctx, chatId).state.clear(); return OpenShiftFlow.start(store, ctx, chatId); }
      if (data.indexOf('oc:') === 0) return OpenShiftFlow.onButton(store, ctx, chatId, data, update.update_id);
      if (text && OpenShiftFlow.waitsForInput(ctx)) return OpenShiftFlow.onText(store, ctx, chatId, text);
      if (ChatFlows.handle(ctx, { text: text, data: data, update_id: update.update_id }, flowDeps_(store, ctx, chatId))) return null;
      return showMenu_(store, chatId, tgId, false);
    } catch (err) {
      if (err.code) return Tg.send(chatId, '⚠️ ' + Tg.esc(err.message)); // отказ по правилу — понятный ответ
      throw err;
    }
  }

  /** Всё внешнее для сценариев чата: хранилище, отправка, состояние в кэше (15 минут), уведомления. */
  function flowDeps_(store, ctx, chatId) {
    var cache = CacheService.getScriptCache();
    var key = 'fl:' + ctx.tg;
    return {
      store: store,
      miniAppUrl: MINIAPP_URL,
      botUsername: PropertiesService.getScriptProperties().getProperty('BOT_USERNAME') || 'flora_uchet_bot',
      newToken: function () { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32); },
      reportText: function (shiftId) { return shiftReportText_(store, ctx.client_id, shiftId) || 'Отчёт не найден.'; },
      exportExcel: function (from, to) { ExportExcel.sendTo(store, ctx, chatId, from, to); },
      send: function (text, rows) { return Tg.send(chatId, text, rows ? { reply_markup: { inline_keyboard: rows } } : undefined); },
      state: {
        get: function () { var v = cache.get(key); return v ? JSON.parse(v) : null; },
        set: function (st) { cache.put(key, JSON.stringify(st), 900); },
        clear: function () { cache.remove(key); }
      },
      notify: function (list) { notify(store, ctx.client_id, list); }
    };
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
      // Один Telegram — один сотрудник в магазине: прежняя привязка этого аккаунта снимается.
      store.rows('staff').filter(function (s) {
        return s.client_id === inv.client_id && s.telegram_id === tgId && s.staff_id !== inv.staff_id;
      }).forEach(function (s) { store.update('staff', { staff_id: s.staff_id, client_id: s.client_id }, { telegram_id: '' }); });
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
    sendGuide_(chatId, joined.role, true); // первый вход: короткая инструкция по роли
  }

  // ---------- инструкция и поддержка ----------

  /** Инструкция по роли. Если администратор загрузил гифку (свойство GUIDE_GIF_FLORIST / GUIDE_GIF_OWNER), она идёт первой. */
  function sendGuide_(chatId, role, first) {
    var owner = role === 'owner';
    var gif = PropertiesService.getScriptProperties().getProperty(owner ? 'GUIDE_GIF_OWNER' : 'GUIDE_GIF_FLORIST');
    if (gif) Tg.sendAnimation(chatId, gif, first ? 'Как это работает 👆' : '');
    var parts = Guide.botMessages(owner ? 'owner' : 'florist');
    parts.forEach(function (p, i) {
      Tg.send(chatId, p, i === parts.length - 1 ? { reply_markup: { inline_keyboard: [[{ text: 'Написать в поддержку', url: Guide.SUPPORT.url }]] } } : undefined);
    });
  }

  function sendSupport_(chatId) {
    Tg.send(chatId, 'Поддержка: ' + Guide.SUPPORT.name + '\nОпишите, что делали и что увидели на экране (лучше со скриншотом).',
      { reply_markup: { inline_keyboard: [[{ text: 'Написать в поддержку', url: Guide.SUPPORT.url }]] } });
  }

  // ---------- меню ----------

  function showMenu_(store, chatId, tgId, greet) {
    var me = staffByTg_(store, tgId);
    if (!me) {
      return Tg.send(chatId, 'Здравствуйте! Это бот учёта цветочного магазина — он для сотрудников.\n' +
        'Попросите у владелицы ссылку-приглашение.\n' + Guide.supportLine() + '\n\nВаш Telegram ID: <code>' + tgId + '</code>');
    }
    var view = Ops.makeView(store, { client_id: me.client_id, point_id: me.point_id, staff_id: me.staff_id, role: me.role, now: nowIso() });
    var shift = view.openShift();
    var lines = [];
    if (greet) lines.push('Здравствуйте, ' + Tg.esc(me.name) + '!');
    var cashButton = [[{ text: 'Открыть кассу', web_app: { url: MINIAPP_URL } }], [{ text: 'Как пользоваться' }, { text: 'Поддержка' }]];
    if (me.role === 'owner' || me.role === 'florist') {
      // D29: всё управление и работа смены — в кассе. Чат — для отчётов, напоминаний и срочных сообщений.
      if (me.role === 'owner') {
        lines.push(shift ? 'Сейчас открыта смена №' + shift.shift_no + '.' : 'Открытой смены нет.');
        lines.push('Отчёт приходит сам после закрытия смены. Склад, сотрудники, расходы и отчёты — в кассе.');
      } else if (shift && view.shiftStaff(shift.shift_id).some(function (s) { return s.staff_id === me.staff_id; })) {
        lines.push('Открыта смена №' + shift.shift_no + '. Всё — в кассе.');
      } else if (shift) {
        lines.push('Открыта смена №' + shift.shift_no + ' — вы в ней не работаете.');
      } else {
        lines.push('Смена не открыта. Откройте её в кассе.');
      }
      return Tg.send(chatId, lines.join('\n'), { reply_markup: { keyboard: cashButton, resize_keyboard: true } });
    }
    Tg.send(chatId, (lines.join('\n') || 'Откройте кассу.'), { reply_markup: { keyboard: cashButton, resize_keyboard: true } });
  }

  // ---------- уведомления и ошибки ----------

  function notify(store, clientId, list) {
    (list || []).forEach(function (n) {
      var text = n.kind === 'shift_report' ? shiftReportText_(store, clientId, n.shift_id) : Notify.text(n);
      if (!text) return;
      if (n.to === 'owner') {
        ownersOf_(store, clientId).forEach(function (o) { Tg.send(o.telegram_id, text); });
        // Администратор видит финансы клиента, пока доступ не выключен (решение D16).
        var admin = PropertiesService.getScriptProperties().getProperty('ADMIN_TELEGRAM_ID');
        var client = store.find('clients', 'client_id', clientId)[0];
        if (admin && n.kind === 'shift_report' && client && client.admin_finance_access === true) {
          Tg.send(admin, '📋 ' + Tg.esc(client.name) + '\n' + text);
        }
      }
    });
  }

  /** Отчёт смены текстом (данные — Ops.shiftReport). */
  function shiftReportText_(store, clientId, shiftId) {
    var shift = store.rows('shifts').filter(function (s) { return s.shift_id === shiftId && s.client_id === clientId; })[0];
    if (!shift) return '';
    var view = Ops.makeView(store, { client_id: clientId, point_id: shift.point_id, staff_id: 'system', role: 'owner', now: nowIso() });
    var names = { items: {}, staff: {} };
    view.rows('catalog').forEach(function (c) { names.items[c.item_id] = c.name; });
    view.rows('staff').forEach(function (s) { names.staff[s.staff_id] = s.name; });
    return Reports.shiftText(Ops.shiftReport(view, shiftId), names);
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
    if (n.kind === 'refund') return '↩️ Возврат денег ' + Tg.money(n.amount) + ' по чеку №' + n.receipt_no + ' (чек на ' + Tg.money(n.total) + ').';
    if (n.kind === 'defect') return '🥀 Брак на ' + Tg.money(n.cost) + ' по закупке (' + n.qty + ' шт).';
    if (n.kind === 'pay_adjust') return '💵 Доплата ЗП из кассы: ' + Tg.esc(n.name) + ' — ' + Tg.money(n.amount) + '.';
    if (n.kind === 'new_item') return '🆕 Флорист добавил позицию «' + Tg.esc(n.name) + '» — на проверке.';
    return '';
  }
};
