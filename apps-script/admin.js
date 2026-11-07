/**
 * Служебные функции администратора. Запускаются из редактора Apps Script (выбрать функцию → «Выполнить»).
 */

/**
 * Пригласить владелицу (решение D17: владелицу назначает только администратор).
 * Перед запуском впишите имя ниже. Ссылка появится в журнале выполнения — перешлите её владелице.
 */
function inviteOwner() {
  var NAME = 'Владелица';      // ← имя владелицы
  var CLIENT_ID = 'c1';        // ← клиент
  var POINT_ID = 'p1';         // ← точка
  var store = SheetsStore.open();
  var existing = store.rows('staff').filter(function (s) {
    return s.client_id === CLIENT_ID && s.point_id === POINT_ID && s.role === 'owner' && s.name === NAME;
  })[0];
  var staffId = existing ? existing.staff_id : 'own-' + Utilities.getUuid().slice(0, 8);
  if (!existing) {
    store.append('staff', [{ staff_id: staffId, client_id: CLIENT_ID, point_id: POINT_ID, telegram_id: '', name: NAME, role: 'owner',
      shift_rate: 0, pct_bp: 0, consent_at: '', consent_version: '', active: true, op_id: 'seed', created_at: nowIso() }]);
  }
  var token = createInvite_(store, CLIENT_ID, POINT_ID, staffId, 2);
  var bot = PropertiesService.getScriptProperties().getProperty('BOT_USERNAME') || 'flora_uchet_bot';
  Logger.log('Ссылка для «' + NAME + '» (одноразовая, 48 часов): https://t.me/' + bot + '?start=' + token);
}

/**
 * Обезличить покупателя по просьбе (закон о персональных данных: в течение рабочего дня).
 * Впишите точное имя ниже. Если с таким именем несколько — функция их перечислит и ничего не изменит.
 */
function anonymizeCustomer() {
  var NAME = '';           // ← имя покупателя
  var CLIENT_ID = 'c1';
  var POINT_ID = 'p1';
  var store = SheetsStore.open();
  var found = store.rows('customers').filter(function (c) { return c.client_id === CLIENT_ID && c.name === NAME && c.anonymized !== true; });
  if (found.length !== 1) {
    Logger.log('Найдено: ' + found.length + '. ' + found.map(function (c) { return c.customer_id + ' (' + c.note + ')'; }).join(', '));
    return;
  }
  var owner = store.rows('staff').filter(function (s) { return s.client_id === CLIENT_ID && s.role === 'owner'; })[0];
  Posting.post(store, { client_id: CLIENT_ID, point_id: POINT_ID, staff_id: owner ? owner.staff_id : 'admin', role: 'admin', now: nowIso() },
    { op_id: 'anon-' + found[0].customer_id, kind: 'anonymize', payload: { customer_id: found[0].customer_id } });
  Logger.log('Обезличен: ' + found[0].customer_id + '. Долг и суммы в отчётах сохранены.');
}
