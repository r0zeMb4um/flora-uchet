// Кэш чтения сервера (D36): ключ зависит от версии данных, человека и параметров; большие ответы не кэшируются.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
global.Summary = require('../apps-script/core/summary.js');
global.Reports = require('../apps-script/bot/reports.js');
const MiniApi = require('../apps-script/api/miniapp.js');

const fakeCache = () => { const m = {}; return { m, get: (k) => (k in m ? m[k] : null), put: (k, v) => { m[k] = v; } }; };

test('ключ кэша: другая версия данных, другой человек, другой месяц — другой ключ; лишние поля запроса не влияют', () => {
  const base = MiniApi.cacheKey('v1', 777, { action: 'owner_expenses', month: '2026-11', initData: 'x' });
  assert.notEqual(base, MiniApi.cacheKey('v2', 777, { action: 'owner_expenses', month: '2026-11' }), 'запись в таблицу меняет версию');
  assert.notEqual(base, MiniApi.cacheKey('v1', 888, { action: 'owner_expenses', month: '2026-11' }), 'у каждого свой кэш');
  assert.notEqual(base, MiniApi.cacheKey('v1', 777, { action: 'owner_expenses', month: '2026-10' }));
  assert.equal(base, MiniApi.cacheKey('v1', 777, { action: 'owner_expenses', month: '2026-11', initData: 'другая подпись', op_id: 'z' }));
});

test('чтение через кэш: второй раз без пересчёта; после смены версии — заново; большой ответ не кладётся; битая запись игнорируется', () => {
  const cache = fakeCache();
  let calls = 0;
  const compute = () => { calls += 1; return { n: calls }; };
  assert.deepEqual(MiniApi.readThrough(cache, 'k1', compute), { value: { n: 1 }, cached: false });
  assert.deepEqual(MiniApi.readThrough(cache, 'k1', compute), { value: { n: 1 }, cached: true });
  assert.equal(calls, 1);
  assert.equal(MiniApi.readThrough(cache, 'k2', compute).value.n, 2, 'новая версия данных — новый расчёт');
  const big = { text: 'я'.repeat(95000) };
  MiniApi.readThrough(cache, 'big', () => big);
  assert.equal(cache.m.big, undefined, 'ответ больше 90 КБ в кэш не идёт');
  cache.m.broken = '{не json';
  assert.deepEqual(MiniApi.readThrough(cache, 'broken', () => ({ ok: 1 })), { value: { ok: 1 }, cached: false });
});
