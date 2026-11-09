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

/**
 * Исправить чек в ЗАКРЫТОЙ смене (D26): найти по номеру смены и номеру чека.
 * Сначала запустите с CONFIRM = false — функция покажет чек. Потом CONFIRM = true — исправит и пришлёт владелице отчёт.
 */
function correctReceipt() {
  var SHIFT_NO = 0;          // ← номер смены
  var RECEIPT_NO = 0;        // ← номер чека в смене
  var REASON = '';           // ← причина, например «чек проведён дважды»
  var CONFIRM = false;       // ← true — исправить
  var CLIENT_ID = 'c1';
  var POINT_ID = 'p1';
  var store = SheetsStore.open();
  var shift = store.rows('shifts').filter(function (s) { return s.client_id === CLIENT_ID && s.point_id === POINT_ID && s.shift_no === SHIFT_NO; })[0];
  if (!shift) return Logger.log('Смена №' + SHIFT_NO + ' не найдена');
  var r = store.rows('receipts').filter(function (x) { return x.shift_id === shift.shift_id && x.receipt_no === RECEIPT_NO; })[0];
  if (!r) return Logger.log('Чек №' + RECEIPT_NO + ' в смене №' + SHIFT_NO + ' не найден');
  Logger.log('Чек №' + r.receipt_no + ': ' + r.type + ', итого ' + r.total + ' ₸, в долг ' + r.debt_amount + ' ₸, статус ' + r.status + ', ' + r.created_at);
  if (!CONFIRM) return Logger.log('Это тот чек? Поставьте CONFIRM = true и запустите ещё раз.');
  var owner = store.rows('staff').filter(function (s) { return s.client_id === CLIENT_ID && s.role === 'owner'; })[0];
  var res = Posting.post(store, { client_id: CLIENT_ID, point_id: POINT_ID, staff_id: owner ? owner.staff_id : 'admin', role: 'admin', now: nowIso() },
    { op_id: 'corr-' + r.receipt_id, kind: 'correction', payload: { receipt_id: r.receipt_id, reason: REASON } });
  Webhook.notify(store, CLIENT_ID, res.notify);
  Logger.log('Исправлено. Владелице отправлен пересчитанный отчёт смены №' + SHIFT_NO + '.');
}

/**
 * ЧИСТКА ТЕСТОВЫХ ДАННЫХ (D35). Запускается ВРУЧНУЮ из редактора один раз перед боевым стартом.
 * Остаются: клиент, точка, настройки, владелица (с её приглашениями). Очищается всё остальное: каталог, покупатели, смены,
 * чеки, склад, расходы, график, флористы, журнал. Перед чисткой на Диск кладётся полная копия таблицы.
 * Сначала запустите с CONFIRM = false: функция только покажет, сколько строк будет удалено. Потом CONFIRM = true.
 */
function resetTestData() {
  var CONFIRM = false;           // ← true — очистить по-настоящему
  var store = SheetsStore.open();
  var ss = store.spreadsheet;
  var plan = Maintenance.planReset({
    staff: store.rows('staff'), invites: store.rows('invites'), ops_log: store.rows('ops_log'),
    clients: store.rows('clients'), points: store.rows('points'), settings: store.rows('settings')
  });
  var report = [];
  plan.wipeSheets.forEach(function (n) { report.push(n + ': ' + store.rows(n).length + ' строк'); });
  report.push('staff: останется владельцев ' + plan.keepStaff.length + ' из ' + store.rows('staff').length);
  report.push('invites: останется ' + plan.keepInvites.length + ' из ' + store.rows('invites').length);
  report.push('ops_log: останется ' + plan.keepOps.length + ' из ' + store.rows('ops_log').length);
  Logger.log('Будет очищено:\n' + report.join('\n'));
  if (!CONFIRM) { Logger.log('Пока ничего не удалено. Чтобы очистить, поставьте CONFIRM = true и запустите снова.'); return; }

  // 1. Копия «до чистки» — имя не подходит под ночное удаление старых копий, поэтому лежит, пока вы её не уберёте сами.
  var folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  var copy = DriveApp.getFileById(ss.getId()).makeCopy('Флора·Учёт — ДО ЧИСТКИ ' + nowIso().replace('T', ' ').slice(0, 16), folder);
  Logger.log('Копия до чистки: ' + copy.getUrl());

  var keepRows = function (name, rows) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var headers = Schema.headers(name);
    var last = sh.getLastRow();
    if (last >= 2) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), headers.length)).clearContent();
    if (rows.length) {
      var values = rows.map(function (r) { return headers.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }); });
      sh.getRange(2, 1, values.length, headers.length).setValues(values);
    }
  };
  plan.wipeSheets.forEach(function (n) { keepRows(n, []); });
  keepRows('staff', plan.keepStaff.map(function (r) { delete r._row; return r; }));
  keepRows('invites', plan.keepInvites);
  keepRows('ops_log', plan.keepOps);
  SpreadsheetApp.flush();

  // 2. Служебные счётчики (напоминания, замеры скорости) — заново.
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('REMINDED_') === 0 || k.indexOf('PERF_') === 0) props.deleteProperty(k); });
  props.setProperty('DATA_VERSION', String(Date.now()));
  Logger.log('ГОТОВО. Осталась владелица и настройки. Дальше: приглашайте флористов («Управление» → «Сотрудники») и загружайте каталог.');
}
