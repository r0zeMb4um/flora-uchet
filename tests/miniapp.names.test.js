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
