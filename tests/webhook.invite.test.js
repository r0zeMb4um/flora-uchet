// Вход по ссылке-приглашению через бота: «Согласен» (callback_data ≤ 64 байт), привязка Telegram, инструкция по роли.
// Webhook загружается как в Apps Script (глобальные имена), Telegram и Google — подставные.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { memoryStore } = require('./helpers/memory-store.js');

function bot(storeSetup) {
  const store = memoryStore();
  store.seed('clients', [{ client_id: 'c1', name: 'Цветы', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('staff', [
    { staff_id: 'own1', client_id: 'c1', point_id: 'p1', telegram_id: '', name: 'Анна', role: 'owner', shift_rate: 0, pct_bp: 0, active: true },
    { staff_id: 'fl1', client_id: 'c1', point_id: 'p1', telegram_id: '', name: 'Мария', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true }
  ]);
  storeSetup(store);
  const sent = [];
  const props = { WEBHOOK_KEY: 'k', ADMIN_TELEGRAM_ID: '1', BOT_USERNAME: 'flora_uchet_bot', LAST_UPDATE_ID: '0' };
  const ctx = vm.createContext({
    console, Date, JSON, Math, Object, Array, String, Number,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    HtmlService: { createHtmlOutput: (t) => t },
    SheetsStore: { open: () => store },
    nowIso: () => '2026-11-11T10:00:00+05:00',
    MINIAPP_URL: 'https://example.test/app/',
    CONSENT_VERSION: 'v1',
    Utilities: { getUuid: () => 'x' },
    Calc: require('../apps-script/core/calc.js'),
    Ops: require('../apps-script/core/ops.js'),
    Posting: require('../apps-script/core/posting.js'),
    Summary: require('../apps-script/core/summary.js'),
    Reports: require('../apps-script/bot/reports.js'),
    Tg: {
      esc: (s) => String(s), money: (n) => String(n),
      send: (chatId, text, extra) => { sent.push({ chatId, text, extra }); },
      sendAnimation: () => true,
      call: () => ({})
    }
  });
  for (const f of ['core/guide.js', 'bot/flows.js', 'bot/open-shift.js', 'bot/webhook.js']) {
    const p = path.join(__dirname, '..', 'apps-script', f);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
  let uid = 0;
  const send = (update) => { sent.length = 0; ctx.Webhook.handle({ parameter: { k: 'k' } }, { update_id: ++uid + 1000, ...update }); return sent.slice(); };
  const from = (id) => ({ id, username: 'u' + id });
  const text = (id, t) => send({ message: { chat: { id, type: 'private' }, from: from(id), text: t } });
  const press = (id, data) => send({ callback_query: { id: 'cb', data, from: from(id), message: { message_id: 1, chat: { id, type: 'private' } } } });
  return { store, text, press };
}

for (const [label, token] of [['короткий токен (24 символа, как у inviteOwner)', 'a1b2c3d4e5f6a1b2c3d4e5f6'], ['длинный токен (64 символа, как было в кассе)', 'f'.repeat(32) + 'e'.repeat(32)]]) {
  test('вход по ссылке: ' + label + ' — кнопка «Согласен» помещается в 64 байта, после согласия человек подключён и получает инструкцию', () => {
    const b = bot((store) => store.seed('invites', [{ token, client_id: 'c1', point_id: 'p1', staff_id: 'fl1', expires_at: '2026-11-13T10:00:00+05:00', status: 'active', used_by_telegram_id: '' }]));
    const first = b.text(500, '/start ' + token);
    const btn = first.find((m) => m.extra && m.extra.reply_markup && m.extra.reply_markup.inline_keyboard);
    assert.ok(btn, 'бот показал согласие с кнопкой');
    const data = btn.extra.reply_markup.inline_keyboard[0][0].callback_data;
    assert.ok(Buffer.byteLength(data) <= 64, 'callback_data ' + Buffer.byteLength(data) + ' байт — Telegram отвергнет (BUTTON_DATA_INVALID)');
    const after = b.press(500, data);
    const staff = b.store.tables.staff.find((s) => s.staff_id === 'fl1');
    assert.equal(staff.telegram_id, '500', 'флорист привязан к своему Telegram');
    assert.ok(staff.consent_at, 'согласие записано');
    assert.equal(b.store.tables.invites[0].status, 'used', 'ссылка одноразовая');
    const texts = after.map((m) => m.text).join('\n');
    assert.ok(texts.includes('Инструкция для флориста'), 'пришла инструкция флориста');
    assert.ok(texts.includes('@kirillST_tpq'), 'в инструкции есть поддержка');
    // вторая попытка по той же ссылке — отказ
    const again = b.text(501, '/start ' + token).map((m) => m.text).join('\n');
    assert.ok(again.includes('недействительна'));
  });
}

test('владелица входит по своей ссылке и получает свою инструкцию; кнопки «Как пользоваться» и «Поддержка» отвечают', () => {
  const token = 'abcdefabcdefabcdefabcdef';
  const b = bot((store) => store.seed('invites', [{ token, client_id: 'c1', point_id: 'p1', staff_id: 'own1', expires_at: '2026-11-13T10:00:00+05:00', status: 'active', used_by_telegram_id: '' }]));
  const data = b.text(700, '/start ' + token).find((m) => m.extra && m.extra.reply_markup).extra.reply_markup.inline_keyboard[0][0].callback_data;
  const texts = b.press(700, data).map((m) => m.text).join('\n');
  assert.ok(texts.includes('Инструкция для владелицы'));
  assert.ok(!texts.includes('Инструкция для флориста'));
  assert.ok(b.text(700, 'Как пользоваться').map((m) => m.text).join('\n').includes('Инструкция для владелицы'));
  assert.ok(b.text(700, 'Поддержка').map((m) => m.text).join('\n').includes('@kirillST_tpq'));
  // чужой Telegram без доступа видит подсказку про поддержку
  assert.ok(b.text(999, 'привет').map((m) => m.text).join('\n').includes('@kirillST_tpq'));
});
