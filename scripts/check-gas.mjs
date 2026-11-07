// Проверка перед выкладкой: все файлы apps-script загружаются вместе, как их склеит Apps Script.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const root = 'apps-script';
const first = ['core/calc.js', 'core/ops.js', 'core/posting.js', 'infra/schema.js', 'infra/sheets.js'];
const all = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) all.push(path.relative(root, p).split(path.sep).join('/'));
  }
})(root);
const files = [...first, ...all.filter((f) => !first.includes(f)).sort()];
const ctx = vm.createContext({ console });
for (const f of files) vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
const need = ['ChatFlows', 'Reports', 'Auth', 'MiniApi', 'Calc', 'Ops', 'Posting', 'Schema', 'SheetsStore', 'Tg', 'Webhook', 'OpenShiftFlow', 'Notify', 'doPost', 'doGet', 'setup', 'connectBot', 'nowIso'];
const missing = need.filter((n) => vm.runInContext('typeof ' + n, ctx) === 'undefined');
if (missing.length) { console.error('Не определены:', missing.join(', ')); process.exit(1); }
console.log('OK: загружено файлов', files.length, '— все глобальные имена на месте');
