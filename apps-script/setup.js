/**
 * Первичная настройка таблицы. Запускается ОДИН раз из редактора Apps Script: выбрать setup → «Выполнить».
 * Создаёт все листы со схемы, ставит форматы и защиту, заводит тестовый магазин и приглашения.
 * Повторный запуск ничего не ломает — он откажется, если листы уже есть.
 */

var CONSENT_VERSION = 'v1';

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Запускайте setup из редактора скрипта, привязанного к таблице');
  if (ss.getSheetByName('ops_log')) throw new Error('Таблица уже настроена — setup повторно не нужен');

  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  // 1. Листы, заголовки, форматы.
  Object.keys(Schema.SHEETS).forEach(function (name) {
    var cols = Schema.SHEETS[name];
    var sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c.name; })])
      .setFontWeight('bold').setBackground('#E4EEEE');
    sh.setFrozenRows(1);
    cols.forEach(function (c, i) {
      var range = sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1);
      if (c.type === 's') range.setNumberFormat('@'); // даты и ID — текстом, Таблица их не испортит
      if (c.type === 'n') range.setNumberFormat('0');
    });
    // Защита: менять лист может только владелец таблицы (аккаунт проекта), т. е. сам скрипт.
    var p = sh.protect().setDescription('Пишет только бот');
    p.removeEditors(p.getEditors());
    if (p.canDomainEdit()) p.setDomainEdit(false);
  });
  ['Лист1', 'Sheet1'].forEach(function (n) { var s = ss.getSheetByName(n); if (s) ss.deleteSheet(s); });

  // 2. Тестовый магазин (как в эталонной смене).
  var store = SheetsStore.create(ss);
  var now = nowIso();
  var seed = function (sheet, rows) {
    store.append(sheet, rows.map(function (r) { r.op_id = 'seed'; r.created_at = now; return r; }));
  };
  store.append('ops_log', [{ op_id: 'seed', client_id: '*', point_id: '', shift_id: '', kind: 'seed', actor_staff_id: 'admin',
    status: 'posted', created_at: now, posted_at: now, plan_json: '', result_json: '' }]);
  seed('clients', [{ client_id: 'c1', name: 'Тестовый магазин', tariff: 'pilot', paid_until: '', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  seed('points', [{ point_id: 'p1', client_id: 'c1', name: 'Точка 1', address: '' }]);
  seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000, reminder_time: '22:00', cash_tolerance: 0, expense_items: 'Аренда;Коммуналка;Интернет' }]);
  seed('catalog', [
    ['rose_red_60', 'flowers', 'Роза красная 60 см', 1200, 650, 20],
    ['eucalyptus', 'greens', 'Эвкалипт', 500, 300, 20],
    ['kraft', 'packaging', 'Крафт-бумага', 300, 100, 10],
    ['chrysanthemum', 'flowers', 'Хризантема кустовая', 900, 450, 10],
    ['toy_bear', 'toys', 'Игрушка мишка', 4500, 2500, 2]
  ].map(function (c) {
    return { item_id: c[0], client_id: 'c1', code: '', category: c[1], name: c[2], unit: 'шт', sale_price: c[3], last_cost: c[4], min_stock: c[5], status: 'active', created_by: 'admin' };
  }));
  seed('staff', [
    ['s_owner', 'Владелица (тест)', 'owner', 0, 0],
    ['s_anna', 'Анна (тест)', 'florist', 5000, 300],
    ['s_mira', 'Мира (тест)', 'florist', 5000, 300]
  ].map(function (s) {
    return { staff_id: s[0], client_id: 'c1', point_id: 'p1', telegram_id: '', name: s[1], role: s[2], shift_rate: s[3], pct_bp: s[4], consent_at: '', consent_version: '', active: true };
  }));

  // 3. Стартовые остатки — настоящей операцией через проведение (проверка связки на Google).
  Posting.post(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: now }, {
    op_id: 'setup-stock-start-' + now.slice(0, 10), kind: 'stock_start',
    payload: { lines: [
      { item_id: 'rose_red_60', qty: 40 }, { item_id: 'eucalyptus', qty: 15 }, { item_id: 'kraft', qty: 61 },
      { item_id: 'chrysanthemum', qty: 49 }, { item_id: 'toy_bear', qty: 5 }
    ] }
  });

  // 4. Приглашения (на 7 дней — тестовые).
  ['s_owner', 's_anna', 's_mira'].forEach(function (id) { createInvite_(store, 'c1', 'p1', id, 7); });
  Logger.log('Готово. Листы созданы, тестовый магазин заведён. Дальше: токен бота в свойства скрипта и connectBot().');
}

/** Новое приглашение: случайный токен, срок действия в днях. */
function createInvite_(store, clientId, pointId, staffId, days) {
  var token = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  var expires = new Date(Date.now() + days * 86400000);
  store.append('invites', [{
    token: token, client_id: clientId, point_id: pointId, staff_id: staffId,
    expires_at: Utilities.formatDate(expires, 'Asia/Almaty', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    status: 'active', used_by_telegram_id: '', op_id: 'invite-' + token, created_at: nowIso()
  }]);
  return token;
}

/** Текущее время по Алматы в ISO: 2026-11-07T21:14:00+05:00. */
function nowIso() {
  return Utilities.formatDate(new Date(), 'Asia/Almaty', "yyyy-MM-dd'T'HH:mm:ssXXX");
}
