// Закупка, выдачи, выгрузка, утренняя сводка, недельный отчёт администратору, новые кнопки владелицы.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.Calc = require('../apps-script/core/calc.js');
global.Ops = require('../apps-script/core/ops.js');
global.Posting = require('../apps-script/core/posting.js');
global.Summary = require('../apps-script/core/summary.js');
global.Reports = require('../apps-script/bot/reports.js');
const MiniApi = require('../apps-script/api/miniapp.js');
const ChatFlows = require('../apps-script/bot/flows.js');
const Maintenance = require('../apps-script/maintenance.js');
const { memoryStore } = require('./helpers/memory-store.js');

const NOW = '2026-11-08T10:00:00+05:00';
const nbsp = (s) => s.replace(/ /g, ' ');

function shop() {
  const store = memoryStore();
  store.seed('clients', [{ client_id: 'c1', name: 'Цветы у Айгуль', timezone: 'Asia/Almaty', admin_finance_access: true }]);
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', telegram_id: '777', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', telegram_id: '1', name: 'Айгуль', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [
    { item_id: 'rose', client_id: 'c1', name: 'Роза', category: 'flowers', sale_price: 1200, last_cost: 650, min_stock: 20, status: 'active' },
    { item_id: 'euc', client_id: 'c1', name: 'Эвкалипт', category: 'greens', sale_price: 500, last_cost: 300, min_stock: 20, status: 'active' },
    { item_id: 'kraft', client_id: 'c1', name: 'Крафт', category: 'packaging', sale_price: 300, last_cost: 100, min_stock: 10, status: 'active' }
  ]);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  const anna = { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW };
  let n = 0;
  const post = (ctx, kind, payload) => Posting.post(store, ctx, { op_id: 'op-feat-' + String(++n).padStart(6, '0'), kind, payload });
  post(owner, 'stock_start', { lines: [{ item_id: 'rose', qty: 100 }, { item_id: 'euc', qty: 43 }, { item_id: 'kraft', qty: 50 }] });
  post(anna, 'open_shift', { florist_ids: ['s_anna'], open_cash: 0 });
  const cash = (qty, item, price) => ({ items: [{ item_id: item, qty }], price, payments: [{ method: 'cash', amount: price }] });
  post(anna, 'sale', cash(60, 'rose', 72000));
  post(anna, 'sale', cash(31, 'euc', 15500));
  post(anna, 'sale', cash(3, 'kraft', 900));
  const view = () => Ops.makeView(store, owner);
  return { store, owner, anna, post, view };
}

test('закупка: «продано за 7 дней + минимум − есть сейчас», вверх до кратного 5; ниже минимума — первыми', () => {
  const { view } = shop();
  const list = Summary.restock(view());
  assert.deepEqual(list.map((x) => [x.name, x.stock, x.weekly, x.buy]), [['Эвкалипт', 12, 31, 40], ['Роза', 40, 60, 40]]);
  assert.equal(list[0].days_left, 2); // 12 шт при 31 в неделю
  const t = nbsp(Reports.restockText(list));
  assert.ok(t.includes('Эвкалипт — есть 12 (мин. 20), за неделю продано 31, хватит на 2 дня → <b>закупить 40</b>'));
  assert.ok(t.includes('<b>Закупить:</b> Эвкалипт 40, Роза 40'));
  assert.equal(Reports.restockText([]), 'Запасов хватает: закупать ничего не нужно.');
});

test('закупка: отмена продажи уменьшает «продано за неделю»; скрытые позиции не предлагаются', () => {
  const { store, anna, post, view } = shop();
  const sale = post(anna, 'sale', { items: [{ item_id: 'kraft', qty: 40 }], price: 12000, payments: [{ method: 'cash', amount: 12000 }] });
  assert.ok(Summary.restock(view()).some((x) => x.item_id === 'kraft'), 'остаток 7 < минимума 10');
  post(anna, 'cancel', { receipt_id: sale.result.receipt_id, reason: 'ошибка' });
  assert.ok(!Summary.restock(view()).some((x) => x.item_id === 'kraft'));
  store.update('catalog', { item_id: 'euc' }, { status: 'hidden' });
  assert.ok(!Summary.restock(view()).some((x) => x.item_id === 'euc'));
});

test('выдачи: на дату, не собрано / собрано, брони, просроченные; напоминание «проверьте сборку»', () => {
  const { anna, post, view } = shop();
  const pre = (date, name, adv) => post(anna, 'preorder', { customer: { new_customer: { name, confirm_new: true } }, pickup_date: date, price: 10000, payments: [{ method: 'cash', amount: adv }] });
  const a = pre('2026-11-09', 'Дана', 3000);
  pre('2026-11-09', 'Бек', 3000);
  post(anna, 'preorder_assemble', { receipt_id: a.result.receipt_id, items: [{ item_id: 'rose', qty: 1 }] });
  post(anna, 'reserve', { customer: { new_customer: { name: 'Сауле' } }, pickup_date: '2026-11-09', price: 5000 });
  // Просроченный заказ: оформлен давно (раньше дату выдачи в прошлом поставить нельзя — D28/аудит).
  post({ ...anna, now: '2026-11-04T10:00:00+05:00' }, 'preorder', { customer: { new_customer: { name: 'Старый', confirm_new: true } }, pickup_date: '2026-11-05', price: 10000, payments: [{ method: 'cash', amount: 1000 }] });
  const p = Summary.pickups(view(), '2026-11-09');
  assert.deepEqual([p.total, p.waiting, p.assembled, p.reservations, p.overdue], [3, 1, 1, 1, 1]);
  const t = Reports.pickupsText(p, 'Завтра');
  assert.ok(t.startsWith('📦 Завтра 3 выдачи: не собрано 2 — проверьте сборку.'));
  assert.ok(t.includes('Бек · 10 000 ₸ · НЕ СОБРАН'.replace(' ', ' ').replace('10 000', '10 000')) || nbsp(t).includes('Бек · 10 000 ₸ · НЕ СОБРАН'));
  assert.ok(nbsp(t).includes('Сауле · 5 000 ₸ · бронь без аванса'));
  assert.ok(t.includes('⚠️ Просрочено выдач: 1'));
  assert.equal(Reports.pickupsText({ total: 0, overdue: 0, items: [] }, 'Сегодня'), '');
  assert.deepEqual([1, 2, 5, 11, 21].map((n) => Reports.plural(n, 'выдача', 'выдачи', 'выдач')), ['1 выдача', '2 выдачи', '5 выдач', '11 выдач', '21 выдача']);
});

test('выгрузка: пять листов, цифры сходятся со сводкой; CSV для Excel с BOM и кавычками', () => {
  const { view } = shop();
  const tables = Summary.exportTables(view(), '2026-11-08', '2026-11-08');
  assert.deepEqual(tables.map((t) => t.name), ['Сводка', 'Смены', 'Чеки', 'Должники', 'Остатки']);
  const sum = Object.fromEntries(tables[0].rows.slice(1).map((r) => [r[0], r[1]]));
  assert.equal(sum['Выручка, ₸'], 88400);
  assert.equal(sum['Чеков'], 3);
  assert.equal(tables[2].rows.length, 4, 'шапка + 3 чека');
  assert.equal(tables[2].rows.slice(1).reduce((a, r) => a + r[6], 0), 88400, 'сумма «Итого» по чекам = выручка');
  assert.deepEqual(tables[4].rows.slice(1).map((r) => [r[0], r[1]]), [['Крафт', 47], ['Роза', 40], ['Эвкалипт', 12]]);
  const csv = Summary.toCsv([['Имя', 'Сумма'], ['Айгуль; "соседка"', 1500], ['Ж', null]]);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.slice(1), 'Имя;Сумма\r\n"Айгуль; ""соседка""";1500\r\nЖ;');
});

test('утренняя сводка: вчера, прибыль дня, касса, ниже минимума и что закупить', () => {
  const day = { revenue: 69900, receipts: 5, profit: 24358, all_closed: true, cash_diff: 0, top_item: { name: 'Роза красная 60 см' } };
  const t = nbsp(Reports.morningText(day, [{ name: 'Эвкалипт', qty: 12, min: 20 }], [{ name: 'Эвкалипт', buy: 40 }, { name: 'Роза', buy: 50 }]));
  assert.ok(t.includes('Вчера: <b>69 900 ₸</b> · чеков 5 · прибыль 24 358 ₸ · касса сошлась · лучшая позиция — Роза красная 60 см.'));
  assert.ok(t.includes('Ниже минимума: Эвкалипт 12/20.'));
  assert.ok(t.includes('Закупить: Эвкалипт 40, Роза 50.'));
  const quiet = Reports.morningText({ ...day, all_closed: false }, [], []);
  assert.ok(quiet.includes('смена не закрыта') && !quiet.includes('Закупить') && !quiet.includes('Ниже минимума'));
});

test('сводка периода в чате: сравнение с прошлым периодом и топ позиций', () => {
  const { view } = shop();
  const v = view();
  const pr = Summary.prevRange('2026-11-02', '2026-11-08');
  assert.deepEqual(pr, ['2026-10-26', '2026-11-01']);
  const t = nbsp(Reports.periodText(Summary.period(v, '2026-11-02', '2026-11-08'), { staff: {} },
    { prev: Summary.period(v, pr[0], pr[1]), top: Summary.top(v, '2026-11-02', '2026-11-08', 5) }));
  assert.ok(t.includes('К прошлому периоду: выручка новое · прибыль'));
  assert.ok(t.includes('Топ: Роза 60 шт · Эвкалипт 31 шт · Крафт 3 шт'));
  assert.equal(Reports.pct(112, 100), '↑ 12%');
  assert.equal(Reports.pct(90, 100), '↓ 10%');
  assert.equal(Reports.pct(0, 0), '—');
});

test('недельный отчёт администратору: неделя считается с понедельника, вердикт и причины', () => {
  assert.equal(Maintenance.weekKey('2026-11-08'), '2026-11-02'); // воскресенье → его понедельник
  assert.equal(Maintenance.weekKey('2026-11-02'), '2026-11-02');
  assert.equal(Maintenance.weekKey('2026-11-03T12:00:00+05:00'), '2026-11-02');
  const fine = { from: '02.11.2026', to: '08.11.2026', errors: 0, failed_ops: 0, perf: { n: 120, sum: 180000, max: 4100, slow: 0 }, fill: 0.012,
    last_backup: '08.11.2026', backup_age_days: 0, backups: 7, webhook_problem: '', stale_open_shifts: 0, shifts: 7, receipts: 45 };
  assert.deepEqual(Maintenance.digestProblems(fine), []);
  const ok = Maintenance.digestText(fine);
  assert.ok(ok.startsWith('✅ Неделя 02.11.2026 — 08.11.2026: всё спокойно'));
  assert.ok(ok.includes('Скорость кассы: в среднем 1500 мс, самый долгий 4100 мс'));
  assert.ok(ok.includes('Таблица заполнена на 1.2%'));
  const bad = Maintenance.digestText({ ...fine, errors: 2, failed_ops: 1, perf: { n: 10, sum: 50000, max: 9000, slow: 3 }, fill: 0.6, last_backup: '', backups: 0, backup_age_days: 999, webhook_problem: 'очередь 4', stale_open_shifts: 1 });
  assert.ok(bad.startsWith('⚠️ Неделя'));
  for (const piece of ['ошибок бота: 2', 'операций «не прошла»: 1', 'касса отвечает медленно: в среднем 5000 мс, медленных запросов (дольше 5 с) 3',
    'таблица заполнена на 60%', 'резервной копии нет уже совсем', 'вебхук Telegram: очередь 4', 'смен открыто больше суток: 1']) {
    assert.ok(bad.includes(piece), 'нет: ' + piece + '\n' + bad);
  }
});

// ---------- кнопки владелицы и API ----------

function chat(store, ctx) {
  let st = null;
  const sent = [];
  const exports = [];
  const deps = {
    store, miniAppUrl: 'x', botUsername: 'b', newToken: () => 't'.repeat(32), reportText: () => '',
    exportExcel: (from, to) => exports.push([from, to]),
    send: (text, rows) => sent.push({ text, rows: rows || [] }),
    state: { get: () => (st ? JSON.parse(JSON.stringify(st)) : null), set: (v) => { st = JSON.parse(JSON.stringify(v)); }, clear: () => { st = null; } },
    notify: () => {}
  };
  let u = 9000;
  return {
    say: (text) => ChatFlows.handle(ctx, { text, data: '', update_id: ++u }, deps),
    press: (data) => ChatFlows.handle(ctx, { text: '', data, update_id: ++u }, deps),
    last: () => sent[sent.length - 1], sent, exports
  };
}

test('владелица в чате: «Закупка», «Выгрузка в Excel», сводка с сравнением; флорист — нет', () => {
  const { store, owner } = shop();
  const o = chat(store, { ...owner, tg: '1' });
  o.say('Закупка');
  assert.ok(nbsp(o.last().text).includes('Закупить:</b> Эвкалипт 40, Роза 40'));
  o.say('Выгрузка в Excel');
  assert.deepEqual(o.last().rows.flat().map((b) => b.callback_data), ['o:xp:7', 'o:xp:cur', 'o:xp:prev', 'f:x']);
  o.press('o:xp:cur');
  assert.deepEqual(o.exports, [['2026-11-01', '2026-11-08']]);
  assert.match(o.last().text, /Готовлю файл за 01\.11\.2026 — 08\.11\.2026/);
  o.say('Отчёт за период'); o.press('o:pd:7');
  assert.match(o.last().text, /К прошлому периоду: выручка новое/);
  assert.match(o.last().text, /Топ: Роза 60 шт/);
  const f = chat(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW, tg: '777' });
  f.say('Закупка');
  assert.match(f.last().text, /меню владелицы/);
});

test('API: «Сегодня» владелицы с закупкой; выгрузка — только владелице и за верный период', () => {
  const { store } = shop();
  const owner = (body) => MiniApi.dispatch(store, 1, body, NOW);
  const today = owner({ action: 'owner_today' }).data;
  assert.deepEqual(today.restock.map((x) => [x.name, x.buy]), [['Эвкалипт', 40], ['Роза', 40]]);
  const ex = owner({ action: 'owner_export', from: '2026-11-01', to: '2026-11-08' });
  assert.deepEqual([ex.export.from, ex.export.to, ex.export.staff.staff_id], ['2026-11-01', '2026-11-08', 's_owner']);
  assert.throws(() => owner({ action: 'owner_export', from: 'вчера', to: '2026-11-08' }), { code: 'BAD_INPUT' });
  assert.throws(() => owner({ action: 'owner_export', from: '2026-11-09', to: '2026-11-01' }), { code: 'BAD_INPUT' });
  assert.throws(() => MiniApi.dispatch(store, 777, { action: 'owner_export', from: '2026-11-01', to: '2026-11-08' }, NOW), { code: 'FORBIDDEN' });
});
