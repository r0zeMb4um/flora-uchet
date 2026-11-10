// Выкладка одной командой: npm run deploy
// тесты → формулы в Mini App → проверка загрузки → clasp push → обновление ТОГО ЖЕ развёртывания → проверка бота.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const DEPLOYMENT_ID = /DEPLOYMENT_ID = '([^']+)'/.exec(fs.readFileSync('apps-script/config.js', 'utf8'))[1];
const clasp = process.platform === 'win32' ? 'npx.cmd --yes @google/clasp@3.4.1' : 'npx --yes @google/clasp@3.4.1';
const run = (cmd) => { console.log('› ' + cmd); execSync(cmd, { stdio: 'inherit', shell: true }); };

fs.copyFileSync('apps-script/core/calc.js', 'miniapp/js/calc.js');
fs.copyFileSync('apps-script/core/guide.js', 'miniapp/js/guide.js');
run('npm test');
run('node scripts/check-gas.mjs');
run(`${clasp} push --force`);
run(`${clasp} redeploy ${DEPLOYMENT_ID} --description "npm run deploy ${new Date().toISOString().slice(0, 16)}"`);

const res = await fetch(`https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec?health=1`);
const h = await res.json();
console.log('Состояние:', JSON.stringify(h));
if (!h.webhook || !h.webhook.connected || h.webhook.pending > 0 || h.webhook.error) {
  console.error('⚠️ С вебхуком что-то не так — проверьте connectBot()');
  process.exit(1);
}
console.log('✅ Выложено. Mini App публикуется GitHub при git push в main.');
