// Решения автоматизации: когда напоминать о смене, какие резервные копии удалять.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../apps-script/maintenance.js');

const shift = { shift_id: 'sh1', status: 'open' };

test('напоминание: после времени из настроек, один раз за день, только об открытой смене', () => {
  assert.equal(M.shouldRemind('2026-11-08T21:59:00+05:00', '22:00', shift, null), false);
  assert.equal(M.shouldRemind('2026-11-08T22:00:00+05:00', '22:00', shift, null), true);
  assert.equal(M.shouldRemind('2026-11-08T23:30:00+05:00', '22:00', shift, 'sh1@2026-11-08'), false, 'сегодня уже напоминали');
  assert.equal(M.shouldRemind('2026-11-09T22:15:00+05:00', '22:00', shift, 'sh1@2026-11-08'), true, 'новый день — снова');
  assert.equal(M.shouldRemind('2026-11-08T23:00:00+05:00', '22:00', { shift_id: 'sh1', status: 'closed' }, null), false);
  assert.equal(M.shouldRemind('2026-11-08T21:00:00+05:00', '20:30', shift, null), true, 'своё время точки');
  assert.equal(M.shouldRemind('2026-11-08T21:00:00+05:00', 'мусор', shift, null), false, 'неверная настройка → 22:00');
});

test('копии: удаляются только старше 30 дней и только наши', () => {
  const names = ['Флора·Учёт копия 2026-10-08', 'Флора·Учёт копия 2026-10-09', 'Флора·Учёт копия 2026-11-08', 'Чужой файл', 'Флора·Учёт копия 2026-09-01'];
  assert.deepEqual(M.backupsToDelete(names, '2026-11-08T03:00:00+05:00', 30), ['Флора·Учёт копия 2026-10-08', 'Флора·Учёт копия 2026-09-01']);
});

test('заполненность таблицы', () => {
  assert.equal(M.fillRatio(5000000), 0.5);
});

test('чистка тестовых данных: остаётся владелица, её приглашения, настройки и записи журнала, на которые они ссылаются', () => {
  const plan = M.planReset({
    clients: [{ client_id: 'c1', op_id: 'seed' }], points: [{ point_id: 'p1', op_id: 'seed' }], settings: [{ client_id: 'c1', op_id: 'seed' }],
    staff: [
      { staff_id: 'o', role: 'owner', op_id: 'seed' }, { staff_id: 'o2', role: 'owner', op_id: 'op-inv-owner' },
      { staff_id: 'a', role: 'florist', op_id: 'op-staff-a' }
    ],
    invites: [{ token: 't1', staff_id: 'o2', op_id: 'op-inv-owner' }, { token: 't2', staff_id: 'a', op_id: 'op-staff-a' }],
    ops_log: [{ op_id: 'seed' }, { op_id: 'op-inv-owner' }, { op_id: 'op-staff-a' }, { op_id: 'op-sale-1' }]
  });
  assert.deepEqual(plan.keepStaff.map((s) => s.staff_id), ['o', 'o2']);
  assert.deepEqual(plan.keepInvites.map((i) => i.token), ['t1']);
  assert.deepEqual(plan.keepOps.map((o) => o.op_id), ['seed', 'op-inv-owner']);
  assert.ok(plan.wipeSheets.includes('receipts') && plan.wipeSheets.includes('catalog') && plan.wipeSheets.includes('stock_balance'));
  assert.ok(!plan.wipeSheets.includes('clients') && !plan.wipeSheets.includes('settings') && !plan.wipeSheets.includes('staff'));
});

test('чистка с именем владелицы: остаётся одна владелица, переименованная и без Telegram, без старых ссылок; флористы и лишние владельцы уходят', () => {
  const data = {
    staff: [
      { staff_id: 'own-1', role: 'owner', name: 'Кирилл-тест', telegram_id: '111', consent_at: 'x', consent_version: '1', active: true, op_id: 'seed' },
      { staff_id: 'own-2', role: 'owner', name: 'Вторая', telegram_id: '222', active: true, op_id: 'o2' },
      { staff_id: 'st-1', role: 'florist', name: 'Анна', telegram_id: '333', active: true, op_id: 'o3' }
    ],
    invites: [{ token: 't1', staff_id: 'own-1', op_id: 'o4' }, { token: 't2', staff_id: 'st-1', op_id: 'o5' }],
    ops_log: [{ op_id: 'seed' }, { op_id: 'o2' }, { op_id: 'o3' }, { op_id: 'o4' }],
    clients: [], points: [], settings: []
  };
  const plan = M.planReset(data, 'Айгуль');
  assert.equal(plan.keepStaff.length, 1);
  assert.equal(plan.keepStaff[0].staff_id, 'own-1');
  assert.equal(plan.keepStaff[0].name, 'Айгуль');
  assert.equal(plan.keepStaff[0].telegram_id, '');
  assert.equal(plan.keepStaff[0].consent_at, '');
  assert.deepEqual(plan.keepInvites, []);
  // без имени — прежнее поведение: все владельцы и их приглашения остаются
  const same = M.planReset(data);
  assert.deepEqual(same.keepStaff.map((s) => s.staff_id), ['own-1', 'own-2']);
  assert.deepEqual(same.keepInvites.map((i) => i.token), ['t1']);
});
