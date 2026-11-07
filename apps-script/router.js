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

function doGet() {
  return HtmlService.createHtmlOutput('Флора·Учёт работает');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
