/**
 * Проверка initData Mini App (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 *   secret = HMAC_SHA256(key = "WebAppData", msg = токен бота)
 *   hash   = hex(HMAC_SHA256(key = secret, msg = data_check_string))
 * data_check_string — все поля, кроме hash, по алфавиту, «key=value» через перевод строки.
 * Срок жизни — 12 часов (решение ТЗ). Функция чистая: HMAC передаётся снаружи (Apps Script или Node).
 */
var Auth = (function () {
  'use strict';

  var MAX_AGE_SEC = 12 * 3600;

  function authError(message) {
    var e = new Error(message);
    e.code = 'AUTH';
    return e;
  }

  function parse(initData) {
    var out = {};
    String(initData || '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, '%20'));
      var v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, '%20'));
      out[k] = v;
    });
    return out;
  }

  /**
   * hmacHex(keyBytesOrString, message) → hex; hmacRaw(keyString, message) → bytes (для secret).
   * Возвращает { user, auth_date } или бросает ошибку с code 'AUTH'.
   */
  function verify(initData, botToken, nowSec, hmacRaw, hmacHex) {
    var f = parse(initData);
    if (!f.hash) throw authError('Откройте кассу из меню бота');
    var keys = Object.keys(f).filter(function (k) { return k !== 'hash'; }).sort();
    var dcs = keys.map(function (k) { return k + '=' + f[k]; }).join('\n');
    var secret = hmacRaw('WebAppData', botToken);
    var expected = hmacHex(secret, dcs);
    if (!safeEqual(expected, String(f.hash).toLowerCase())) throw authError('Подпись Telegram не сошлась — откройте кассу из меню бота заново');
    var authDate = Number(f.auth_date);
    if (!authDate || nowSec - authDate > MAX_AGE_SEC) throw authError('Вход в кассу устарел (больше 12 часов) — закройте и откройте её из бота');
    var user;
    try { user = JSON.parse(f.user); } catch (e) { throw authError('Нет данных пользователя Telegram'); }
    if (!user || !user.id) throw authError('Нет данных пользователя Telegram');
    return { user: user, auth_date: authDate };
  }

  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /** Вариант для Apps Script. */
  function verifyGas(initData) {
    var token = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
    var bytes = function (s) { return typeof s === 'string' ? Utilities.newBlob(s).getBytes() : s; };
    var raw = function (key, msg) { return Utilities.computeHmacSha256Signature(bytes(msg), bytes(key)); };
    var hex = function (key, msg) {
      return raw(key, msg).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    };
    return verify(initData, token, Math.floor(Date.now() / 1000), raw, hex);
  }

  return { verify: verify, verifyGas: verifyGas, parse: parse, MAX_AGE_SEC: MAX_AGE_SEC };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Auth;
