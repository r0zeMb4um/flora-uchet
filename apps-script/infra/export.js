/**
 * Выгрузка в Excel (xlsx), только Apps Script.
 * Данные собирает чистая Summary.exportTables по «виду» одного клиента и точки — чужое в файл не попадает.
 * Файл делается через временную Google Таблицу, которую сразу убираем в корзину.
 * Если xlsx не получился (нет прав на Диск и т. п.) — шлём запасной вариант: CSV, который открывается в Excel.
 */
var ExportExcel = (function () {
  'use strict';

  function ownerView(store, ctx) {
    return Ops.makeView(store, { client_id: ctx.client_id, point_id: ctx.point_id, staff_id: ctx.staff_id, role: 'owner', now: nowIso() });
  }

  function xlsxBlob(tables, title) {
    var ss = SpreadsheetApp.create(title);
    var id = ss.getId();
    try {
      tables.forEach(function (t, i) {
        var sh = i === 0 ? ss.getSheets()[0].setName(t.name) : ss.insertSheet(t.name);
        var width = Math.max.apply(null, t.rows.map(function (r) { return r.length; }));
        var values = t.rows.map(function (r) { var c = r.slice(); while (c.length < width) c.push(''); return c; });
        sh.getRange(1, 1, values.length, width).setValues(values);
        sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#fde3ec');
        sh.setFrozenRows(1);
        sh.autoResizeColumns(1, width);
      });
      SpreadsheetApp.flush();
      var res = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx', {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) throw new Error('экспорт xlsx: код ' + res.getResponseCode());
      return res.getBlob().setName(title + '.xlsx');
    } finally {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { /* корзина не обязательна для результата */ }
    }
  }

  /** Построить и отправить файл в чат chatId. */
  function sendTo(store, ctx, chatId, from, to) {
    var view = ownerView(store, ctx);
    var tables = Summary.exportTables(view, from, to);
    var title = 'Флора-Учёт ' + from + ' — ' + to;
    var caption = 'Отчёт за ' + from.split('-').reverse().join('.') + ' — ' + to.split('-').reverse().join('.') + ': сводка, смены, чеки, должники, остатки.';
    try {
      Tg.sendDocument(chatId, xlsxBlob(tables, title), caption);
    } catch (err) {
      Logger.log('xlsx не получился, шлём CSV: ' + err.message);
      ['Сводка', 'Чеки'].forEach(function (name) {
        var t = tables.filter(function (x) { return x.name === name; })[0];
        var blob = Utilities.newBlob(Summary.toCsv(t.rows), 'text/csv', title + ' — ' + name + '.csv');
        Tg.sendDocument(chatId, blob, name === 'Сводка' ? caption + ' (CSV: откроется в Excel)' : '');
      });
    }
  }

  return { sendTo: sendTo };
})();
