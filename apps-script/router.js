/**
 * Единственная точка входа веб-приложения (docs/ARCHITECTURE.md, раздел 1).
 * Обновление Telegram (есть update_id) → чат-бот; иначе → API Mini App.
 */
function doPost(e) {
  var data = null;
  try {
    data = JSON.parse(e && e.postData ? e.postData.contents : '');
  } catch (err) {
    data = null;
  }
  if (data && data.update_id !== undefined) return Webhook.handle(e, data);
  if (data && data.initData !== undefined) return MiniApi.handle(data);
  return jsonOut_({ ok: false, error: { code: 'BAD_REQUEST', message: 'Неверный запрос' } });
}

function doGet(e) {
  if (e && e.parameter && e.parameter.health === '1') {
    // Адрес открытый: ответ держим в кэше на минуту, чтобы частые заходы не жгли квоты Google и не читали таблицу.
    var cache = CacheService.getScriptCache();
    var hit = cache.get('health');
    if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    var body = JSON.stringify(health_());
    try { cache.put('health', body, 60); } catch (ignore) { /* кэш не обязателен */ }
    return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createHtmlOutput('Флора·Учёт работает');
}

/** Состояние подключения: только «да/нет», без сумм, имён, ключей и токенов. */
function health_() {
  var props = PropertiesService.getScriptProperties();
  var out = {
    setup: !!props.getProperty('SPREADSHEET_ID'),
    bot_token: !!props.getProperty('BOT_TOKEN'),
    webhook_key: !!props.getProperty('WEBHOOK_KEY'),
    updates_received: !!props.getProperty('LAST_UPDATE_ID')
  };
  try {
    if (out.bot_token) {
      var info = Tg.call('getWebhookInfo');
      out.webhook = { connected: !!info.url, pending: info.pending_update_count, error: info.last_error_message || '' };
    }
  } catch (err) { out.webhook = { error: 'не удалось проверить' }; }
  try {
    if (out.setup) {
      var store = SheetsStore.open();
      out.someone_joined = store.rows('staff').some(function (s) { return !!s.telegram_id; });
      out.shift_opened = store.rows('shifts').length > 0;
      out.stock_ready = store.rows('stock_balance').length > 0;
      out.errors_logged = store.rows('audit').filter(function (a) { return a.action === 'error'; }).length;
      // Только количества — для проверки защиты от дублей (без сумм и имён).
      out.receipts = store.rows('receipts').length;
      out.ops_not_posted = store.rows('ops_log').filter(function (o) { return o.status !== 'posted'; }).length;
      out.stock_matches_journal = Posting.reconcileStock !== undefined && (function () {
        var bal = {};
        store.rows('stock_balance').forEach(function (b) { bal[b.client_id + b.point_id + b.item_id] = b.qty; });
        var posted = {};
        store.rows('ops_log').forEach(function (o) { if (o.status === 'posted') posted[o.op_id] = true; });
        var sum = {};
        store.rows('stock_moves').forEach(function (m) {
          if (posted[m.op_id]) { var k = m.client_id + m.point_id + m.item_id; sum[k] = (sum[k] || 0) + m.qty; }
        });
        return Object.keys(bal).every(function (k) { return bal[k] === (sum[k] || 0); });
      })();
    }
  } catch (err2) { out.sheets = 'не удалось прочитать: ' + String(err2 && err2.message || err2).slice(0, 200); }
  return out;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
