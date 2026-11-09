// Защита от случайной потери кода при правках кассы: все вызываемые функции должны быть объявлены.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'miniapp', 'js', 'app.js'), 'utf8');
const declared = new Set([...src.matchAll(/function\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]));

test('функции, которые вызывает касса, объявлены в app.js', () => {
  const must = ['shareImage', 'drawReceipt', 'drawDayCard', 'donut', 'lineChart', 'delta', 'shortMoney', 'smoothPath',
    'svgEl', 'loadImg', 'brandCanvas', 'artName', 'countUpAll', 'pump', 'applyQueue', 'friendly', 'doSubmit'];
  const lost = must.filter((n) => !declared.has(n));
  assert.deepStrictEqual(lost, []);
});

test('все экраны кассы на месте (защита от случайной потери блока при правках)', () => {
  const screens = ['stock', 'more', 'income', 'defect', 'refund', 'cancel', 'cashout', 'withdraw', 'repay', 'preorders', 'schedule', 'owner_day', 'open',
    'owner_today', 'owner_shift', 'owner_period', 'owner_debtors', 'owner_manage', 'owner_catalog', 'owner_typical', 'owner_item', 'owner_item_new', 'owner_import',
    'owner_team', 'owner_staff', 'owner_staff_new', 'owner_invite', 'owner_expenses', 'owner_settings', 'owner_work', 'owner_start_stock', 'owner_start_debt',
    'owner_preorders', 'owner_preorder'];
  const lost = screens.filter((n) => !new RegExp('SCREENS(_EARLY)?\.' + n + ' = function').test(src));
  assert.deepEqual(lost, []);
  const helpers = ['positionsWord', 'parseImport', 'dayLabel', 'pctBp', 'signedInt', 'liteToggle', 'prefetchOwner', 'draftGet', 'askOk', 'formField', 'ocRead', 'drawCatalogAdd'];
  assert.deepEqual(helpers.filter((n) => !declared.has(n)), []);
});

test('el() принимает детей и массивом, и одной строкой, и одним элементом (без этого экран ссылки-приглашения не рисовался)', () => {
  const m = /function el\(tag, attrs, children\) \{[\s\S]*?\n  \}\n/.exec(src);
  assert.ok(m, 'функция el найдена');
  const node = (tag) => ({ tag, kids: [], attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.kids.push(c); return c; } });
  const document = { createElement: node, createTextNode: (t) => ({ text: t }) };
  const el = new Function('document', m[0] + '\nreturn el;')(document);
  assert.deepEqual(el('button', {}, 'Готово').kids, [{ text: 'Готово' }]);
  const inner = el('i');
  assert.deepEqual(el('div', {}, inner).kids, [inner]);
  assert.deepEqual(el('div', {}, ['a', inner, null]).kids, [{ text: 'a' }, inner]);
  assert.deepEqual(el('div').kids, []);
});
