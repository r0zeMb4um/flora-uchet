// Сценарии кнопок чата: расход, «Владелица забрала», погашение долга, отмена продажи, передача смены.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Posting = require('../apps-script/core/posting.js');
const Ops = require('../apps-script/core/ops.js');
const ChatFlows = require('../apps-script/bot/flows.js');
const { memoryStore } = require('./helpers/memory-store.js');

const NOW = '2026-11-08T10:00:00+05:00';

function shop() {
  const store = memoryStore();
  store.seed('settings', [{ client_id: 'c1', point_id: 'p1', change_fund: 5000 }]);
  store.seed('staff', [
    { staff_id: 's_anna', client_id: 'c1', point_id: 'p1', name: 'Анна', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_mira', client_id: 'c1', point_id: 'p1', name: 'Мира', role: 'florist', shift_rate: 5000, pct_bp: 300, active: true },
    { staff_id: 's_owner', client_id: 'c1', point_id: 'p1', name: 'Владелица', role: 'owner', shift_rate: 0, pct_bp: 0, active: true }
  ]);
  store.seed('catalog', [{ item_id: 'bear', client_id: 'c1', name: 'Мишка', category: 'toys', sale_price: 4500, last_cost: 2500, min_stock: 1, status: 'active' }]);
  const owner = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW };
  const anna = { client_id: 'c1', point_id: 'p1', staff_id: 's_anna', role: 'florist', now: NOW, tg: '777' };
  Posting.post(store, owner, { op_id: 'start-00001', kind: 'stock_start', payload: { lines: [{ item_id: 'bear', qty: 5 }] } });
  Posting.post(store, owner, { op_id: 'debt-000001', kind: 'debt_opening', payload: { customer: { new_customer: { name: 'Ерлан', note: 'сосед' } }, amount: 3000, since_date: '2026-10-01' } });
  Posting.post(store, anna, { op_id: 'open-000001', kind: 'open_shift', payload: { florist_ids: ['s_anna'], open_cash: 15000 } });
  return { store, anna };
}

/** Имитация чата: что бот отправил и состояние сценария. */
// Номера обновлений Telegram у бота не повторяются — общий счётчик на все чаты теста.
let updSeq = 1000;
function chat(store, ctx) {
  let st = null;
  const sent = [];
  const notified = [];
  const deps = {
    store, miniAppUrl: 'https://example.test/kassa/', botUsername: 'test_bot',
    newToken: () => 'tok' + String(++updSeq).padStart(29, '0'),
    reportText: (id) => 'ОТЧЁТ ' + id,
    send: (text, rows) => { sent.push({ text, rows: rows || [] }); },
    state: { get: () => (st ? JSON.parse(JSON.stringify(st)) : null), set: (v) => { st = JSON.parse(JSON.stringify(v)); }, clear: () => { st = null; } },
    notify: (list) => notified.push(...list)
  };
  const say = (text) => ChatFlows.handle(ctx, { text, data: '', update_id: ++updSeq }, deps);
  const press = (data) => ChatFlows.handle(ctx, { text: '', data, update_id: ++updSeq }, deps);
  const last = () => sent[sent.length - 1];
  const buttons = () => last().rows.flat().map((b) => b.callback_data || b.web_app && b.web_app.url);
  return { say, press, last, buttons, sent, notified, state: () => st };
}
const view = (store) => Ops.makeView(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW });
const cashOf = (store) => Ops.shiftReport(view(store), view(store).openShift().shift_id).calc_cash;

test('расход: тип → сумма → комментарий → «Проверьте» → проведено; до подтверждения ничего не пишется', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Расход');
  assert.deepEqual(c.buttons(), ['f:t:delivery', 'f:t:other', 'f:x']);
  c.press('f:t:delivery');
  c.say('две с половиной');
  assert.match(c.last().text, /цифрами/);
  c.say('2 500');
  c.say('Курьер до ТЦ');
  assert.match(c.last().text, /Проверьте и подтвердите/);
  assert.match(c.last().text, /Доставка из кассы: <b>2 500 ₸<\/b>/);
  assert.equal(cashOf(store), 15000, 'до подтверждения касса не изменилась');
  c.press('f:ok');
  assert.match(c.last().text, /^✅ Проведено/);
  assert.equal(cashOf(store), 12500);
  // Повторное нажатие «Провести» — ничего.
  c.press('f:ok');
  assert.match(c.last().text, /уже не действует/);
  assert.equal(cashOf(store), 12500);
  assert.equal(store.tables.cash_ops.length, 1);
});

test('расход без комментария и отмена сценария на любом шаге', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Расход'); c.press('f:t:other'); c.say('700'); c.press('f:nc'); c.press('f:ok');
  assert.equal(cashOf(store), 14300);
  c.say('Расход'); c.press('f:t:other'); c.say('900'); c.press('f:x');
  assert.match(c.last().text, /Отменено/);
  c.press('f:ok');
  assert.equal(cashOf(store), 14300);
  c.say('Владелица забрала'); c.say('Отмена');
  assert.equal(c.state(), null);
});

test('владелица забрала: уведомление владелице, касса уменьшилась', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Владелица забрала'); c.say('10000');
  assert.match(c.last().text, /Владелица забрала из кассы: <b>10 000 ₸/);
  c.press('f:ok');
  assert.equal(cashOf(store), 5000);
  assert.deepEqual(c.notified.map((n) => n.kind), ['withdrawal']);
});

test('погашение долга: выбор должника, «весь долг» или сумма, способ; больше долга — нельзя', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Погашение долга');
  const erlan = view(store).rows('customers')[0].customer_id;
  assert.deepEqual(c.buttons(), ['f:c:' + erlan, 'f:x']);
  assert.match(c.last().rows[0][0].text, /Ерлан \(сосед\) — 3 000 ₸/);
  c.press('f:c:' + erlan);
  c.say('3500');
  assert.match(c.last().text, /больше долга/);
  c.say('1000');
  c.press('f:m:card');
  assert.match(c.last().text, /Останется долг: 2 000/);
  c.press('f:ok');
  assert.equal(view(store).debtOf(erlan), 2000);
  assert.equal(cashOf(store), 15000, 'безнал не попадает в наличные');
  c.say('Погашение долга'); c.press('f:c:' + erlan); c.press('f:all'); c.press('f:m:cash'); c.press('f:ok');
  assert.equal(view(store).debtOf(erlan), 0);
  assert.equal(cashOf(store), 17000);
  c.say('Погашение долга');
  assert.match(c.last().text, /Должников нет/);
});

test('отмена продажи: только чеки этой смены, причина, товар вернулся, владелице сообщение', () => {
  const { store, anna } = shop();
  const sale = Posting.post(store, anna, { op_id: 'sale-000001', kind: 'sale', payload: { items: [{ item_id: 'bear', qty: 1 }], price: 4500, payments: [{ method: 'cash', amount: 4500 }] } });
  const c = chat(store, anna);
  c.say('Отменить продажу');
  assert.deepEqual(c.buttons(), ['f:r:' + sale.result.receipt_id, 'f:x']);
  assert.match(c.last().rows[0][0].text, /^№1 · 4 500 ₸/);
  c.press('f:r:' + sale.result.receipt_id);
  c.say('Покупатель передумал');
  assert.match(c.last().text, /Товар вернётся на склад/);
  c.press('f:ok');
  assert.equal(view(store).stock('bear'), 5);
  assert.equal(cashOf(store), 15000);
  assert.deepEqual(c.notified.map((n) => n.kind), ['cancel']);
  c.say('Отменить продажу');
  assert.match(c.last().text, /нет чеков/);
});

test('передача смены ведёт в закрытие в кассе; без смены и не своей смены — понятный отказ', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Передать смену');
  assert.deepEqual(c.buttons(), ['https://example.test/kassa/#close']);
  const mira = chat(store, { ...anna, staff_id: 's_mira', tg: '888' });
  mira.say('Расход');
  assert.match(mira.last().text, /не работаете в открытой смене/);
  const owner = chat(store, { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW, tg: '1' });
  owner.say('Владелица забрала');
  assert.match(owner.last().text, /для флориста/);
});

test('старые кнопки другого сценария не срабатывают', () => {
  const { store, anna } = shop();
  const c = chat(store, anna);
  c.say('Расход');
  c.say('Владелица забрала'); // начат новый сценарий — старые кнопки не действуют
  c.press('f:t:delivery');
  assert.match(c.last().text, /уже не действует/);
  assert.equal(store.tables.cash_ops, undefined);
});

// ---------- меню владелицы ----------

const ownerCtx = { client_id: 'c1', point_id: 'p1', staff_id: 's_owner', role: 'owner', now: NOW, tg: '1' };

test('сотрудники: добавить флориста → ссылка; новая ссылка гасит старую; отключить — доступ пропал сразу', () => {
  const { store, anna } = shop();
  const o = chat(store, ownerCtx);
  o.say('Сотрудники');
  assert.ok(o.buttons().includes('o:add'));
  assert.match(o.last().rows[0][0].text, /Анна · 5 000 ₸ \+ 3% ·/);
  o.press('o:add'); o.say('Сауле'); o.say('пять'); o.say('4500'); o.say('2,5');
  assert.match(o.last().text, /Новый флорист: <b>Сауле<\/b>\nСтавка 4 500 ₸ \+ 2.5% от продаж/);
  o.press('f:ok');
  const link = o.sent.find((m) => m.text.includes('t.me/test_bot?start='));
  assert.ok(link, 'бот дал ссылку');
  const saule = store.tables.staff.find((s) => s.name === 'Сауле');
  assert.deepEqual([saule.shift_rate, saule.pct_bp, saule.role, saule.active, saule.point_id], [4500, 250, 'florist', true, 'p1']);
  const firstToken = store.tables.invites.find((i) => i.staff_id === saule.staff_id).token;

  o.say('Сотрудники'); o.press('o:s:' + saule.staff_id); o.press('o:inv'); o.press('f:ok');
  const inv = store.tables.invites.filter((i) => i.staff_id === saule.staff_id);
  assert.deepEqual(inv.map((i) => i.status), ['revoked', 'active']);
  assert.notEqual(inv[1].token, firstToken);

  o.say('Сотрудники'); o.press('o:s:s_anna'); o.press('o:off');
  assert.match(o.last().text, /Доступ пропадёт сразу/);
  o.press('f:ok');
  const a = chat(store, anna);
  a.say('Расход'); a.press('f:t:other'); a.say('100'); a.press('f:nc'); a.press('f:ok');
  assert.match(a.last().text, /Доступ отключён/);
  o.say('Сотрудники'); o.press('o:s:s_anna'); o.press('o:on'); o.press('f:ok');
  assert.equal(store.tables.staff.find((s) => s.staff_id === 's_anna').active, true);
});

test('процент флориста: «3», «2,5», «2.75» — да; «abc», «101», «2,555» — переспросить', () => {
  const { store } = shop();
  const o = chat(store, ownerCtx);
  for (const [txt, ok] of [['abc', false], ['101', false], ['2,555', false], ['2.75', true]]) {
    o.say('Сотрудники'); o.press('o:add'); o.say('Тест'); o.say('5000'); o.say(txt);
    if (ok) assert.match(o.last().text, /\+ 2.75% от продаж/);
    else assert.match(o.last().text, /Процент числом/);
  }
});

test('расходы месяца: статья → месяц → сумма (подсказка прошлого месяца) → не в кассе', () => {
  const { store } = shop();
  const o = chat(store, ownerCtx);
  o.say('Расходы месяца'); o.press('o:ei:new'); o.say('Аренда'); o.press('o:mo:2026-10'); o.say('120000'); o.press('f:ok');
  o.say('Расходы месяца');
  o.press('o:ei:new'); o.say('Аренда'); o.press('o:mo:2026-11');
  assert.ok(o.buttons().includes('o:am:120000'), 'подсказка «как в прошлом месяце»');
  o.press('o:am:120000');
  assert.match(o.last().text, /Не из кассы/);
  o.press('f:ok');
  assert.deepEqual(store.tables.owner_expenses.map((e) => [e.month, e.item, e.amount]), [['2026-10', 'Аренда', 120000], ['2026-11', 'Аренда', 120000]]);
  assert.equal(cashOf(store), 15000);
});

test('предзаказы владелицы: отменить с возвратом аванса на карту и букетом на склад', () => {
  const { store, anna } = shop();
  const pre = Posting.post(store, anna, { op_id: 'pre-0000001', kind: 'preorder', payload: { customer: { new_customer: { name: 'Дана' } }, pickup_date: '2026-11-09', price: 9000, payments: [{ method: 'cash', amount: 2000 }] } });
  Posting.post(store, anna, { op_id: 'asm-0000001', kind: 'preorder_assemble', payload: { receipt_id: pre.result.receipt_id, items: [{ item_id: 'bear', qty: 2 }] } });
  const o = chat(store, ownerCtx);
  o.say('Предзаказы');
  o.press('o:p:' + pre.result.receipt_id);
  assert.ok(o.buttons().includes('o:rf:cash'), 'смена открыта — можно наличными');
  o.press('o:rf:card'); o.press('o:rs:1'); o.say('клиент уехал');
  assert.match(o.last().text, /Аванс 2 000 ₸ вернуть на карту\nБукет: вернуть на склад\nПричина: клиент уехал/);
  o.press('f:ok');
  assert.equal(view(store).stock('bear'), 5);
  assert.equal(store.tables.receipts[0].assembly_status, 'cancelled');
  o.say('Предзаказы');
  assert.match(o.last().text, /Активных предзаказов нет/);
});

test('отчёт за смену по кнопке; флорист не может открыть меню владелицы', () => {
  const { store, anna } = shop();
  const o = chat(store, ownerCtx);
  o.say('Отчёт за смену');
  assert.match(o.last().text, /Закрытых смен пока нет/);
  Posting.post(store, anna, { op_id: 'inv-0000001', kind: 'inventory', payload: { facts: { bear: 5 } } });
  Posting.post(store, anna, { op_id: 'close-000001', kind: 'close_shift', payload: { counted: 15000, expenses_confirmed: true } });
  o.say('Отчёт за смену');
  assert.match(o.last().text, /^ОТЧЁТ sh-/);
  const a = chat(store, anna);
  a.say('Сотрудники');
  assert.match(a.last().text, /меню владелицы/);
});

test('владелица: остатки, должники и сводка за период в чате', () => {
  const { store } = shop();
  const o = chat(store, ownerCtx);
  o.say('Остатки');
  assert.match(o.last().text, /ИГРУШКИ:<\/b>\n  Мишка — 5/);
  o.say('Должники');
  assert.match(o.last().text, /Ерлан · сосед · долг 3 000 ₸ · с 01\.10\.2026/);
  o.say('Отчёт за период');
  assert.deepEqual(o.buttons(), ['o:pd:7', 'o:pd:cur', 'o:pd:prev', 'f:x']);
  o.press('o:pd:cur');
  assert.match(o.last().text, /^<b>Сводка 01\.11\.2026 — 08\.11\.2026<\/b>/);
  o.say('Отчёт за период'); o.press('o:pd:prev');
  assert.match(o.last().text, /^<b>Сводка 01\.10\.2026 — 31\.10\.2026<\/b>/);
  o.say('Отчёт за период'); o.press('o:pd:7');
  assert.match(o.last().text, /^<b>Сводка 02\.11\.2026 — 08\.11\.2026<\/b>/);
});

test('каталог владелицы: позиция «на проверке» сверху → подтвердить; цена, минимум, скрыть и вернуть', () => {
  const { store, anna } = shop();
  Posting.post(store, anna, { op_id: 'new-item-0001', kind: 'new_item', payload: { category: 'toys', name: 'Зайка', sale_price: 3000, confirm_new: true } });
  const o = chat(store, ownerCtx);
  o.say('Каталог');
  assert.match(o.last().text, /на проверке: 1/);
  assert.match(o.last().rows[0][0].text, /^⚠️ Зайка/);
  const zid = o.buttons()[0].slice(5);
  o.press('o:ci:' + zid); o.press('o:ca:active'); o.press('f:ok');
  assert.equal(view(store).item(zid).status, 'active');
  o.say('Каталог'); o.press('o:ci:bear'); o.press('o:ca:price'); o.say('5000'); o.press('f:ok');
  o.say('Каталог'); o.press('o:ci:bear'); o.press('o:ca:min'); o.say('0'); o.press('f:ok');
  assert.deepEqual([view(store).item('bear').sale_price, view(store).item('bear').min_stock], [5000, 0]);
  o.say('Каталог'); o.press('o:ci:bear'); o.press('o:ca:hidden');
  assert.match(o.last().text, /Скрыть из продажи: <b>Мишка<\/b>/);
  o.press('f:ok');
  assert.throws(() => Posting.post(store, anna, { op_id: 'sale-hidden-01', kind: 'sale', payload: { items: [{ item_id: 'bear', qty: 1 }], price: 5000, payments: [{ method: 'cash', amount: 5000 }] } }), { code: 'UNKNOWN_ITEM' });
  o.say('Каталог'); o.press('o:ci:bear'); o.press('o:ca:active'); o.press('f:ok');
  assert.equal(view(store).item('bear').status, 'active');
});

test('настройки владелицы: размен, время напоминания, статьи расходов; неверный ввод — переспросить', () => {
  const { store } = shop();
  const o = chat(store, ownerCtx);
  o.say('Настройки');
  assert.match(o.last().text, /Размен \(всегда в кассе\): 5 000 ₸/);
  o.press('o:se:change_fund'); o.say('7 000'); o.press('f:ok');
  o.say('Настройки'); o.press('o:se:reminder_time'); o.say('25:00');
  assert.match(o.last().text, /ЧЧ:ММ/);
  o.say('21:30'); o.press('f:ok');
  o.say('Настройки'); o.press('o:se:expense_items'); o.say('Аренда, Коммуналка, Налоги'); o.press('f:ok');
  const s = view(store).settings();
  assert.deepEqual([s.change_fund, s.reminder_time, s.expense_items], [7000, '21:30', 'Аренда;Коммуналка;Налоги']);
  o.say('Расходы месяца');
  assert.deepEqual(o.buttons().slice(0, 3), ['o:ei:0', 'o:ei:1', 'o:ei:2']);
});
