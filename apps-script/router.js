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
  return jsonOut_({ ok: false, error: { code: 'NOT_READY', message: 'API Mini App подключается на этапе C' } });
}

function doGet(e) {
  if (e && e.parameter && e.parameter.health === '1') return jsonOut_(health_());
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
    }
  } catch (err2) { out.sheets = 'не удалось прочитать: ' + String(err2 && err2.message || err2).slice(0, 200); }
  return out;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
