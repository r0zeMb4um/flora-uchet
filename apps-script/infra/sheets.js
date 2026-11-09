/**
 * Хранилище на Google Таблице: тот же интерфейс, что у хранилища в памяти из тестов
 * (rows, find, append, update, withLock), поэтому core/ops.js и core/posting.js работают без изменений.
 *
 * Чтение листа — один вызов getValues() на запрос (кэш в пределах одного запуска скрипта).
 * Запись — одна пачка setValues() на лист.
 */
var SheetsStore = (function () {
  'use strict';

  function open() {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('Не задан SPREADSHEET_ID — сначала запустите setup()');
    return create(SpreadsheetApp.openById(id));
  }

  function create(ss) {
    var memo = {};
    var dirty = false;
    var inLock = false;
    /** Версия данных: меняется при любой записи. По ней сервер понимает, что кэш чтения устарел (D36). */
    function bump() {
      try { PropertiesService.getScriptProperties().setProperty('DATA_VERSION', String(Date.now()) + '-' + Math.floor(Math.random() * 1e6)); } catch (e) { /* без версии кэш просто живёт недолго */ }
    }
    function touched() { if (inLock) dirty = true; else bump(); }

    var checked = {};
    /** Новая колонка в конце схемы появляется и в уже созданном листе (читаем по позициям, поэтому данные не сдвигаются). */
    function ensureHeaders(sh, name) {
      if (checked[name]) return;
      checked[name] = true;
      var cols = Schema.SHEETS[name];
      if (!cols) return;
      var have = sh.getLastColumn();
      if (have >= cols.length) return;
      var add = cols.slice(have);
      sh.getRange(1, have + 1, 1, add.length).setValues([add.map(function (c) { return c.name; })]).setFontWeight('bold');
      add.forEach(function (c, i) {
        var range = sh.getRange(2, have + 1 + i, Math.max(1, sh.getMaxRows() - 1), 1);
        if (c.type === 's') range.setNumberFormat('@');
        if (c.type === 'n') range.setNumberFormat('0');
      });
    }

    function sheetOf(name) {
      var sh = ss.getSheetByName(name);
      if (sh) { ensureHeaders(sh, name); return sh; }
      // Новый лист из схемы (появился в новой версии) создаётся сам: заголовки, текстовые форматы, защита.
      var cols = Schema.SHEETS[name];
      if (!cols) throw new Error('Нет листа ' + name + ' — запустите setup()');
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c.name; })]).setFontWeight('bold');
      sh.setFrozenRows(1);
      cols.forEach(function (c, i) {
        var range = sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1);
        if (c.type === 's') range.setNumberFormat('@');
        if (c.type === 'n') range.setNumberFormat('0');
      });
      try { var pr = sh.protect().setDescription('Пишет только бот'); pr.removeEditors(pr.getEditors()); } catch (e) { /* защита не обязательна для работы */ }
      return sh;
    }

    function fromCell(v, type) {
      if (v === '' || v === null) return '';
      if (type === 'n') return Number(v);
      if (type === 'b') return v === true || v === 'TRUE';
      if (v instanceof Date) {
        return Utilities.formatDate(v, 'Asia/Almaty', "yyyy-MM-dd'T'HH:mm:ssXXX"); // страховка: колонки текстовые
      }
      return String(v);
    }

    function toCell(v) {
      return v === undefined || v === null ? '' : v;
    }

    /** Все строки листа как объекты (+ _row — номер строки в листе). */
    function load(name) {
      if (memo[name]) return memo[name];
      var cols = Schema.SHEETS[name];
      var sh = sheetOf(name);
      var last = sh.getLastRow();
      var out = [];
      if (last >= 2) {
        var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
        for (var i = 0; i < values.length; i++) {
          var obj = { _row: i + 2 };
          for (var j = 0; j < cols.length; j++) obj[cols[j].name] = fromCell(values[i][j], cols[j].type);
          out.push(obj);
        }
      }
      memo[name] = out;
      return out;
    }

    function strip(r) {
      var c = {};
      Object.keys(r).forEach(function (k) { if (k !== '_row') c[k] = r[k]; });
      return c;
    }

    function matches(row, match) {
      return Object.keys(match).every(function (k) { return row[k] === match[k]; });
    }

    return {
      spreadsheet: ss,
      rows: function (name) { return load(name).map(strip); },
      find: function (name, field, value) {
        return load(name).filter(function (r) { return r[field] === value; }).map(strip);
      },
      append: function (name, rows) {
        if (!rows.length) return;
        var headers = Schema.headers(name);
        rows.forEach(function (r) { Schema.check(name, r); });
        var values = rows.map(function (r) { return headers.map(function (h) { return toCell(r[h]); }); });
        var sh = sheetOf(name);
        var start = sh.getLastRow() + 1;
        sh.getRange(start, 1, values.length, headers.length).setValues(values);
        touched();
        var cached = load(name);
        rows.forEach(function (r, i) {
          var o = { _row: start + i };
          headers.forEach(function (h) { o[h] = r[h] === undefined ? '' : r[h]; });
          cached.push(o);
        });
      },
      update: function (name, match, set) {
        Schema.check(name, set);
        var headers = Schema.headers(name);
        var sh = sheetOf(name);
        load(name).forEach(function (r) {
          if (!matches(r, match)) return;
          Object.keys(set).forEach(function (k) { r[k] = set[k]; });
          sh.getRange(r._row, 1, 1, headers.length).setValues([headers.map(function (h) { return toCell(r[h]); })]);
          touched();
        });
      },
      withLock: function (fn) {
        var lock = LockService.getScriptLock();
        if (!lock.tryLock(10000)) {
          var e = new Error('Касса занята, нажмите ещё раз');
          e.code = 'BUSY';
          throw e;
        }
        try {
          inLock = true;
          dirty = false;
          memo = {}; // под блокировкой читаем свежие данные
          return fn();
        } finally {
          inLock = false;
          if (dirty) bump(); // версия меняется ДО снятия блокировки: читатели не увидят старый кэш после записи
          SpreadsheetApp.flush();
          lock.releaseLock();
        }
      },
      /** Сбросить кэш чтения (после чужих записей). */
      refresh: function () { memo = {}; }
    };
  }

  return { open: open, create: create };
})();
