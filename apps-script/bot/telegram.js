/**
 * Вызовы Telegram Bot API. Токен — только из свойств скрипта (BOT_TOKEN), никогда из кода.
 */
var Tg = (function () {
  'use strict';

  function token() {
    var t = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
    if (!t) throw new Error('Не задан BOT_TOKEN в свойствах скрипта');
    return t;
  }

  function call(method, payload) {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token() + '/' + method, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok) throw new Error('Telegram ' + method + ': ' + (body.description || res.getResponseCode()));
    return body.result;
  }

  function send(chatId, text, extra) {
    var p = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
    Object.keys(extra || {}).forEach(function (k) { p[k] = extra[k]; });
    return call('sendMessage', p);
  }

  /** Экранирование текста для parse_mode HTML. */
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 15000 → «15 000 ₸» (неразрывные пробелы). */
  function money(n) {
    var sign = n < 0 ? '−' : '';
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return sign + s + ' ₸';
  }

  /** Фото в чат (multipart): чек клиенту, карточка дня. */
  function sendPhoto(chatId, blob, caption) {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token() + '/sendPhoto', {
      method: 'post', payload: { chat_id: String(chatId), caption: caption || '', photo: blob }, muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok) throw new Error('Telegram sendPhoto: ' + (body.description || res.getResponseCode()));
    return body.result;
  }

  /** Файл в чат (Excel/CSV). */
  function sendDocument(chatId, blob, caption) {
    var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token() + '/sendDocument', {
      method: 'post', payload: { chat_id: String(chatId), caption: caption || '', document: blob }, muteHttpExceptions: true
    });
    var body = JSON.parse(res.getContentText() || '{}');
    if (!body.ok) throw new Error('Telegram sendDocument: ' + (body.description || res.getResponseCode()));
    return body.result;
  }

  return { call: call, send: send, sendPhoto: sendPhoto, sendDocument: sendDocument, esc: esc, money: money };
})();
