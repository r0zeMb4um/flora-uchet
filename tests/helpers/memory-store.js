// Хранилище в памяти для тестов: тот же интерфейс, что у адаптера Google Таблицы.
'use strict';
const Schema = require('../../apps-script/infra/schema.js');

function memoryStore() {
  const tables = {};
  const t = (sheet) => (tables[sheet] = tables[sheet] || []);
  const matches = (row, match) => Object.keys(match).every((k) => row[k] === match[k]);
  return {
    tables,
    rows: (sheet) => t(sheet).map((r) => ({ ...r })), // копии: снаружи данные не меняются
    find: (sheet, field, value) => t(sheet).filter((r) => r[field] === value).map((r) => ({ ...r })),
    // Каждая запись сверяется со схемой листов — как это будет в Google Таблице.
    append: (sheet, rows) => rows.forEach((r) => { Schema.check(sheet, r); t(sheet).push(JSON.parse(JSON.stringify(r))); }),
    update: (sheet, match, set) => { Schema.check(sheet, set); t(sheet).forEach((r) => { if (matches(r, match)) Object.assign(r, set); }); },
    withLock: (fn) => fn(),
    /** Справочники «как после setup()»: строки с op_id 'seed', проведённые. */
    seed(sheet, rows) {
      if (!t('ops_log').some((o) => o.op_id === 'seed')) {
        t('ops_log').push({ op_id: 'seed', client_id: '*', status: 'posted', kind: 'seed' });
      }
      rows.forEach((r) => { const row = { op_id: 'seed', ...r }; Schema.check(sheet, row); t(sheet).push(row); });
    }
  };
}

module.exports = { memoryStore };
