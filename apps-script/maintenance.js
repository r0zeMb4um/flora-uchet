/**
 * Автоматизация и надёжность (этап E, docs/ARCHITECTURE.md раздел 7).
 * Триггеры ставятся ОДИН раз функцией installTriggers() из редактора:
 *   каждые 15 минут — reminderTick (напоминание о незакрытой смене после времени из настроек точки);
 *   ночью в 03:00   — nightly (зависшие операции → failed, сверка остатков, резервная копия, заполненность таблицы);
 *   утром в 09:00   — healthCheck (вебхук Telegram, ошибки за сутки).
 * Решения о том, КОГДА что делать, — чистые функции Maintenance.* (тестируются в Node).
 */
var Maintenance = (function () {
  'use strict';

  /** Напоминать ли о смене: время по Алматы ≥ времени напоминания и сегодня ещё не напоминали. */
  function shouldRemind(nowIso, reminderTime, shift, alreadyRemindedKey) {
    if (!shift || shift.status !== 'open') return false;
    var hhmm = String(nowIso).slice(11, 16);
    var rt = /^\d{2}:\d{2}$/.test(String(reminderTime || '')) ? reminderTime : '22:00';
    if (hhmm < rt) return false;
    return alreadyRemindedKey !== reminderKey(nowIso, shift);
  }
  function reminderKey(nowIso, shift) { return shift.shift_id + '@' + String(nowIso).slice(0, 10); }

  /** Какие копии удалить: старше keepDays по дате в имени «Флора·Учёт копия ГГГГ-ММ-ДД». */
  function backupsToDelete(names, todayIso, keepDays) {
    var cut = new Date(Date.parse(String(todayIso).slice(0, 10) + 'T00:00:00Z') - keepDays * 86400000).toISOString().slice(0, 10);
    return names.filter(function (n) {
      var m = /копия (\d{4}-\d{2}-\d{2})$/.exec(n);
      return m && m[1] < cut;
    });
  }

  /** Доля заполненности таблицы (предел Google — 10 млн ячеек). */
  function fillRatio(cells) { return cells / 10000000; }

  /** Ключ недели — дата её понедельника (для счётчиков скорости). */
  function weekKey(dateIso) {
    var d = new Date(Date.parse(String(dateIso).slice(0, 10) + 'T00:00:00Z'));
    var back = (d.getUTCDay() + 6) % 7;
    return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
  }

  /** Что в недельном отчёте не в порядке. st — собранные цифры недели. */
  function digestProblems(st) {
    var p = [];
    if (st.errors > 0) p.push('ошибок бота: ' + st.errors + ' (лист audit)');
    if (st.failed_ops > 0) p.push('операций «не прошла»: ' + st.failed_ops);
    if (st.perf && st.perf.n && (st.perf.slow > 0 || st.perf.sum / st.perf.n > 3000)) {
      p.push('касса отвечает медленно: в среднем ' + Math.round(st.perf.sum / st.perf.n) + ' мс, медленных запросов (дольше 5 с) ' + st.perf.slow);
    }
    if (st.fill > 0.5) p.push('таблица заполнена на ' + Math.round(st.fill * 100) + '%');
    if (!st.last_backup || st.backup_age_days > 2) p.push('резервной копии нет уже ' + (st.last_backup ? st.backup_age_days + ' дн.' : 'совсем'));
    if (st.webhook_problem) p.push('вебхук Telegram: ' + st.webhook_problem);
    if (st.stale_open_shifts > 0) p.push('смен открыто больше суток: ' + st.stale_open_shifts);
    return p;
  }

  /** Текст недельного отчёта администратору: вердикт, потом цифры. */
  function digestText(st) {
    var problems = digestProblems(st);
    var L = [problems.length ? '⚠️ Неделя ' + st.from + ' — ' + st.to + ': есть что проверить' : '✅ Неделя ' + st.from + ' — ' + st.to + ': всё спокойно'];
    problems.forEach(function (x) { L.push('  • ' + x); });
    L.push('');
    L.push('Работа: смен ' + st.shifts + ', чеков ' + st.receipts + ', запросов кассы ' + (st.perf ? st.perf.n : 0));
    if (st.perf && st.perf.n) L.push('Скорость кассы: в среднем ' + Math.round(st.perf.sum / st.perf.n) + ' мс, самый долгий ' + st.perf.max + ' мс');
    L.push('Ошибок: ' + st.errors + ' · не прошедших операций: ' + st.failed_ops);
    L.push('Таблица заполнена на ' + (Math.round(st.fill * 1000) / 10) + '% · копий на Диске: ' + st.backups + (st.last_backup ? ', последняя ' + st.last_backup : ''));
    return L.join('\n');
  }

  return { shouldRemind: shouldRemind, reminderKey: reminderKey, backupsToDelete: backupsToDelete, fillRatio: fillRatio,
    weekKey: weekKey, digestProblems: digestProblems, digestText: digestText };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Maintenance;

// ---------- ниже — только Apps Script ----------

var BACKUP_FOLDER = 'Флора·Учёт — резервные копии';
var BACKUP_KEEP_DAYS = 30;

/** Поставить все триггеры заново (старые удаляются). Запустить один раз из редактора. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('reminderTick').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('nightly').timeBased().atHour(3).everyDays(1).inTimezone('Asia/Almaty').create();
  ScriptApp.newTrigger('healthCheck').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Almaty').create();
  ScriptApp.newTrigger('pickupsToday').timeBased().atHour(9).everyDays(1).inTimezone('Asia/Almaty').create();
  ScriptApp.newTrigger('pickupsTomorrow').timeBased().atHour(18).everyDays(1).inTimezone('Asia/Almaty').create();
  ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone('Asia/Almaty').create();
  Logger.log('Триггеры поставлены: напоминание о смене каждые 15 минут; копия и проверки в 03:00; проверка бота, утро владелицы и выдачи на сегодня в 09:00; выдачи на завтра в 18:00; недельный отчёт администратору по понедельникам.');
  nightly(); // сразу проверить, что всё работает (первая копия появится на Диске)
  healthCheck();
}

function adminSay_(text) {
  var admin = PropertiesService.getScriptProperties().getProperty('ADMIN_TELEGRAM_ID');
  if (!admin) { Logger.log('(администратору) ' + text); return; }
  try { Tg.send(admin, text); } catch (e) { Logger.log('Не удалось написать администратору: ' + e.message); }
}

/** Напоминание о незакрытой смене флористам смены и владелице — один раз за день. */
function reminderTick() {
  var store = SheetsStore.open();
  var props = PropertiesService.getScriptProperties();
  var now = nowIso();
  store.rows('shifts').filter(function (s) { return s.status === 'open'; }).forEach(function (shift) {
    var settings = store.rows('settings').filter(function (x) { return x.client_id === shift.client_id && x.point_id === shift.point_id; })[0] || {};
    var keyName = 'REMINDED_' + shift.shift_id;
    if (!Maintenance.shouldRemind(now, settings.reminder_time, shift, props.getProperty(keyName))) return;
    props.setProperty(keyName, Maintenance.reminderKey(now, shift));
    var ids = String(shift.florist_ids).split(',');
    var text = '⏰ Смена №' + shift.shift_no + ' ещё не закрыта. Закройте её в кассе: инвентаризация → пересчёт → зарплата.';
    store.rows('staff').forEach(function (s) {
      if (!s.telegram_id || s.active !== true || s.client_id !== shift.client_id) return;
      if (ids.indexOf(s.staff_id) >= 0) Tg.send(s.telegram_id, text);
      else if (s.role === 'owner') Tg.send(s.telegram_id, '⏰ Смена №' + shift.shift_no + ' ещё не закрыта (' + Tg.esc(String(shift.florist_ids)) + ').');
    });
  });
}

/** Ночная проверка: зависшие операции, сверка остатков, резервная копия, заполненность таблицы. */
function nightly() {
  var store = SheetsStore.open();
  var now = nowIso();
  var report = [];

  var failed = Posting.failStale(store, now, 3600000);
  if (failed.length) report.push('Зависшие операции переведены в «не прошла» (D14): ' + failed.length);

  store.refresh();
  var diffs = Posting.reconcileStock(store, now);
  if (diffs.length) {
    report.push('Остатки расходились с журналом и исправлены: ' + diffs.map(function (d) { return d.item_id + ' ' + d.was + '→' + d.now; }).join(', '));
  }

  try {
    report.push(backup_(store.spreadsheet, now));
  } catch (e) {
    report.push('⚠️ Резервная копия не сделана: ' + e.message);
  }

  var cells = store.spreadsheet.getSheets().reduce(function (a, sh) { return a + sh.getMaxRows() * sh.getMaxColumns(); }, 0);
  var ratio = Maintenance.fillRatio(cells);
  if (ratio > 0.5) report.push('⚠️ Таблица заполнена на ' + Math.round(ratio * 100) + '% от предела Google — пора архивировать или переходить на этап 2.');

  var problems = report.filter(function (r) { return r.indexOf('⚠️') === 0 || r.indexOf('Зависшие') === 0 || r.indexOf('Остатки') === 0; });
  Logger.log(report.join('\n'));
  if (problems.length) adminSay_('🌙 Ночная проверка:\n' + problems.join('\n'));
}

/** Копия таблицы в папку на Диске; копии старше 30 дней — в корзину (восстановимо ещё 30 дней). */
function backup_(ss, now) {
  var folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);
  var name = 'Флора·Учёт копия ' + now.slice(0, 10);
  var exists = folder.getFilesByName(name);
  if (!exists.hasNext()) DriveApp.getFileById(ss.getId()).makeCopy(name, folder);
  var all = [];
  var files = folder.getFiles();
  while (files.hasNext()) { var f = files.next(); all.push({ file: f, name: f.getName() }); }
  var old = Maintenance.backupsToDelete(all.map(function (x) { return x.name; }), now, BACKUP_KEEP_DAYS);
  all.forEach(function (x) { if (old.indexOf(x.name) >= 0) x.file.setTrashed(true); });
  return 'Копия: «' + name + '», всего копий ' + (all.length - old.length) + (old.length ? ', старых в корзину: ' + old.length : '');
}

/** Утро владелицы: итог вчерашнего дня одной строкой и приглашение к карточке дня. */
function morningCard_() {
  var store = SheetsStore.open();
  var now = nowIso();
  var yesterday = new Date(Date.parse(now.slice(0, 10) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  store.rows('staff').filter(function (s) { return s.role === 'owner' && s.active === true && s.telegram_id; }).forEach(function (o) {
    var view = Ops.makeView(store, { client_id: o.client_id, point_id: o.point_id, staff_id: o.staff_id, role: 'owner', now: now });
    var d = Summary.day(view, yesterday);
    if (!d.shifts) return;
    Tg.send(o.telegram_id, Reports.morningText(d, Summary.stock(view).below, Summary.restock(view)));
  });
}

/** Напоминание о выдачах на дату всем сотрудникам точки и владелице. Пустое — не шлём. */
function pickupReminder_(offsetDays, label) {
  var store = SheetsStore.open();
  var now = nowIso();
  var date = new Date(Date.parse(now.slice(0, 10) + 'T00:00:00Z') + offsetDays * 86400000).toISOString().slice(0, 10);
  var sent = {};
  store.rows('staff').filter(function (s) { return s.active === true && s.telegram_id; }).forEach(function (s) {
    var key = s.client_id + '|' + s.point_id;
    var view = Ops.makeView(store, { client_id: s.client_id, point_id: s.point_id, staff_id: s.staff_id, role: s.role, now: now });
    var text = sent[key] !== undefined ? sent[key] : (sent[key] = Reports.pickupsText(Summary.pickups(view, date), label));
    if (text) Tg.send(s.telegram_id, text);
  });
}
function pickupsToday() { pickupReminder_(0, 'Сегодня'); }
function pickupsTomorrow() { pickupReminder_(1, 'Завтра'); }

/** Счётчик скорости кассы: запросов, сумма и максимум миллисекунд за неделю (в свойствах скрипта). */
function recordPerf_(ms) {
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'PERF_' + Maintenance.weekKey(nowIso());
    var c = JSON.parse(props.getProperty(key) || '{"n":0,"sum":0,"max":0,"slow":0}');
    c.n += 1; c.sum += ms; c.max = Math.max(c.max, ms); if (ms > 5000) c.slow += 1;
    props.setProperty(key, JSON.stringify(c));
  } catch (e) { /* счётчик не должен ломать запрос */ }
}

/** Недельный отчёт администратору: вердикт и пять-шесть цифр. По понедельникам. */
function weeklyDigest() {
  var store = SheetsStore.open();
  var now = nowIso();
  var today = now.slice(0, 10);
  var from = new Date(Date.parse(today + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  var to = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  var props = PropertiesService.getScriptProperties();
  var lastWeek = Maintenance.weekKey(from);
  var perf = JSON.parse(props.getProperty('PERF_' + lastWeek) || 'null');
  var st = { from: from.split('-').reverse().join('.'), to: to.split('-').reverse().join('.'), perf: perf };
  st.errors = store.rows('audit').filter(function (a) { return a.action === 'error' && String(a.ts).slice(0, 10) >= from; }).length;
  st.failed_ops = store.rows('ops_log').filter(function (o) { return o.status === 'failed' && String(o.created_at).slice(0, 10) >= from; }).length;
  var shifts = store.rows('shifts').filter(function (s) { return s.shift_date >= from && s.shift_date <= to; });
  st.shifts = shifts.length;
  var ids = {};
  shifts.forEach(function (s) { ids[s.shift_id] = true; });
  st.receipts = store.rows('receipts').filter(function (r) { return ids[r.shift_id] && r.status !== 'cancelled'; }).length;
  st.stale_open_shifts = store.rows('shifts').filter(function (s) { return s.status === 'open' && s.shift_date < today; }).length;
  st.fill = Maintenance.fillRatio(store.spreadsheet.getSheets().reduce(function (a, sh) { return a + sh.getMaxRows() * sh.getMaxColumns(); }, 0));
  var names = [];
  var folders = DriveApp.getFoldersByName(BACKUP_FOLDER);
  if (folders.hasNext()) { var files = folders.next().getFiles(); while (files.hasNext()) names.push(files.next().getName()); }
  var dates = names.map(function (n) { var m = /копия (\d{4}-\d{2}-\d{2})$/.exec(n); return m ? m[1] : ''; }).filter(Boolean).sort();
  st.backups = dates.length;
  st.last_backup = dates.length ? dates[dates.length - 1].split('-').reverse().join('.') : '';
  st.backup_age_days = dates.length ? Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(dates[dates.length - 1] + 'T00:00:00Z')) / 86400000) : 999;
  try {
    var info = Tg.call('getWebhookInfo');
    st.webhook_problem = !info.url ? 'не подключён' : info.last_error_message ? info.last_error_message : info.pending_update_count > 0 ? 'очередь ' + info.pending_update_count : '';
  } catch (e) { st.webhook_problem = 'Telegram не отвечает'; }
  adminSay_(Maintenance.digestText(st));
  // Счётчики старше 4 недель удаляем.
  var cut = Maintenance.weekKey(new Date(Date.parse(today + 'T00:00:00Z') - 28 * 86400000).toISOString().slice(0, 10));
  Object.keys(props.getProperties()).forEach(function (k) { if (k.indexOf('PERF_') === 0 && k.slice(5) < cut) props.deleteProperty(k); });
}

/** Утренняя проверка бота: вебхук без ошибок и очереди, ошибки за сутки. Заодно — утреннее сообщение владелице. */
function healthCheck() {
  try { morningCard_(); } catch (eM) { Logger.log('Утреннее сообщение: ' + eM.message); }
  var problems = [];
  try {
    var info = Tg.call('getWebhookInfo');
    if (!info.url) problems.push('вебхук не подключён — запустите connectBot()');
    if (info.pending_update_count > 0) problems.push('в очереди Telegram ' + info.pending_update_count + ' сообщений');
    if (info.last_error_message) problems.push('ошибка Telegram: ' + info.last_error_message);
  } catch (e) {
    problems.push('Telegram не отвечает: ' + e.message);
  }
  try {
    var since = new Date(Date.now() - 86400000 + 5 * 3600000).toISOString().slice(0, 19);
    var errors = SheetsStore.open().rows('audit').filter(function (a) { return a.action === 'error' && String(a.ts) >= since; });
    if (errors.length) problems.push('ошибок за сутки: ' + errors.length + ' (лист audit)');
  } catch (e2) {
    problems.push('таблица не читается: ' + e2.message);
  }
  Logger.log(problems.length ? problems.join('\n') : 'Бот здоров.');
  if (problems.length) adminSay_('🩺 Проверка бота:\n' + problems.join('\n'));
}
