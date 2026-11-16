// Хранилище на Google Таблице (infra/sheets.js) на поддельной таблице: чтение одним вызовом на лист,
// старые листы без новых колонок, запись в правильные строки, счётчик обращений к Google.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.Schema = require('../apps-script/infra/schema.js');

function fakeSpreadsheet(init) {
  const calls = { n: 0 };
  const hit = () => { calls.n += 1; };
  function makeSheet(name, grid) {
    const g = grid.map((r) => r.slice());
    const lastRow = () => { for (let i = g.length - 1; i >= 0; i--) if (g[i].some((v) => v !== '')) return i + 1; return 0; };
    const lastCol = () => g.reduce((m, r) => { let c = 0; r.forEach((v, j) => { if (v !== '') c = j + 1; }); return Math.max(m, c); }, 0);
    const range = (r, c, nr, nc) => ({
      getValues: () => { hit(); const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((g[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
      setValues: (v) => { hit(); v.forEach((row, i) => { while (g.length < r + i) g.push([]); row.forEach((x, j) => { g[r - 1 + i][c - 1 + j] = x; }); }); return range(r, c, nr, nc); },
      setFontWeight: () => range(r, c, nr, nc),
      setNumberFormat: () => range(r, c, nr, nc)
    });
    return {
      grid: g,
      getName: () => name,
      getLastRow: () => { hit(); return lastRow(); },
      getLastColumn: () => { hit(); return lastCol(); },
      getMaxRows: () => 1000,
      getDataRange: () => { hit(); const lr = lastRow(), lc = lastCol(); return { getValues: () => { const out = []; for (let i = 0; i < lr; i++) { const row = []; for (let j = 0; j < lc; j++) row.push(g[i][j] ?? ''); out.push(row); } return out; } }; },
      getRange: (r, c, nr, nc) => range(r, c, nr || 1, nc || 1),
      setFrozenRows: () => {},
      protect: () => ({ setDescription: () => ({ removeEditors: () => {}, getEditors: () => [] }), getEditors: () => [] })
    };
  }
  const sheets = {};
  Object.keys(init).forEach((k) => { sheets[k] = makeSheet(k, init[k]); });
  return {
    calls, sheets,
    getSheetByName: (n) => { hit(); return sheets[n] || null; },
    insertSheet: (n) => { sheets[n] = makeSheet(n, []); return sheets[n]; }
  };
}

function load(ss) {
  global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  global.SpreadsheetApp = { flush: () => {} };
  global.PropertiesService = { getScriptProperties: () => ({ setProperty: () => {}, getProperty: () => null }) };
  global.Utilities = { formatDate: (d) => d.toISOString() };
  delete require.cache[require.resolve('../apps-script/infra/sheets.js')];
  return require('../apps-script/infra/sheets.js').create(ss);
}

const H = Schema.headers('settings');

test('чтение: один вызов Google на лист; лист без новых колонок читается, недостающие поля пустые', () => {
  const old = H.slice(0, H.indexOf('shop_address')); // старый лист: колонок адреса и контакта ещё нет
  const ss = fakeSpreadsheet({ settings: [old, old.map((h) => ({ client_id: 'c1', point_id: 'p1', change_fund: 5000, op_id: 'seed' }[h] ?? ''))] });
  const store = load(ss);
  const rows = store.rows('settings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].change_fund, 5000);
  assert.equal(rows[0].shop_address, '', 'нет колонки — пусто, а не «undefined»');
  assert.ok(ss.calls.n <= 2, 'имя листа + данные, без отдельных getLastRow/getLastColumn: ' + ss.calls.n);
  store.rows('settings');
  assert.ok(ss.calls.n <= 2, 'повторное чтение — из памяти');
});

test('запись: новая колонка дописывается в заголовок, строки встают после последней, под блокировкой без лишних вызовов', () => {
  const old = H.slice(0, H.indexOf('shop_address'));
  const ss = fakeSpreadsheet({ settings: [old, old.map((h) => ({ client_id: 'c1', point_id: 'p1', change_fund: 5000, op_id: 'seed' }[h] ?? ''))] });
  const store = load(ss);
  store.withLock(() => {
    store.rows('settings');
    store.update('settings', { client_id: 'c1', point_id: 'p1' }, { shop_address: 'ул. Абая 10' });
    store.append('settings', [{ client_id: 'c1', point_id: 'p2', change_fund: 3000, op_id: 'x' }]);
    store.append('settings', [{ client_id: 'c1', point_id: 'p3', change_fund: 1000, op_id: 'y' }]);
  });
  const g = ss.sheets.settings.grid;
  assert.deepEqual(g[0], H, 'заголовок дописан до полной схемы');
  assert.equal(g[1][H.indexOf('shop_address')], 'ул. Абая 10');
  assert.equal(g[2][H.indexOf('point_id')], 'p2');
  assert.equal(g[3][H.indexOf('point_id')], 'p3', 'вторая пачка — в следующую строку, ничего не затёрто');
  const fresh = load(ss);
  assert.deepEqual(fresh.rows('settings').map((r) => r.point_id), ['p1', 'p2', 'p3']);
  assert.equal(fresh.rows('settings')[0].shop_address, 'ул. Абая 10');
});

test('вне блокировки строка для дописывания берётся свежей (журнал ошибок из двух запусков не затирает друг друга)', () => {
  const A = Schema.headers('audit');
  const ss = fakeSpreadsheet({ audit: [A] });
  const s1 = load(ss);
  const s2 = load(ss);
  s1.rows('audit'); s2.rows('audit'); // оба прочитали пустой журнал
  s1.append('audit', [{ ts: '1', actor_telegram_id: '', action: 'error', details_json: 'a' }]);
  s2.append('audit', [{ ts: '2', actor_telegram_id: '', action: 'error', details_json: 'b' }]);
  assert.deepEqual(load(ss).rows('audit').map((r) => r.ts), ['1', '2']);
});
