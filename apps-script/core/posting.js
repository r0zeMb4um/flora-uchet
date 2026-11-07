/**
 * Флора·Учёт — проведение операций.
 *
 * Работает с любым хранилищем, у которого есть:
 *   rows(sheet) → массив строк-объектов
 *   find(sheet, field, value) → строки, где field === value
 *   append(sheet, rows)        — дописать пачкой (одна пачка = одна запись на лист)
 *   update(sheet, match, set)  — поменять поля во всех строках, подходящих под match
 *   withLock(fn)               — выполнить fn под блокировкой
 * На этапе 1 это Google Таблица (infra/), в тестах — хранилище в памяти.
 *
 * Порядок (docs/ARCHITECTURE.md, раздел 4):
 *   1. повтор? posted → прежний ответ; failed → отказ; pending → дописать по сохранённому плану;
 *   2. построить план (core/ops.js) по проведённым данным;
 *   3. ops_log = pending + сам план (plan_json);
 *   4. факты — пачкой на лист (лист, где уже есть строки этой операции, пропускается);
 *   5. состояния (update) — повторное применение безопасно;
 *   6. остатки затронутых позиций — пересчёт по журналу, а не прибавка (безопасно при повторе);
 *   7. ops_log = posted ПОСЛЕДНИМ.
 */
var Posting = (function () {
  'use strict';

  var O = typeof Ops !== 'undefined' ? Ops : require('./ops.js');

  /**
   * Провести операцию.
   * ctx: { client_id, point_id, staff_id, role, now } — только из проверенного Telegram ID, не из запроса.
   * req: { op_id, kind, payload }
   * hooks.step(name) — для тестов: имитация сбоя на любом шаге.
   */
  function post(store, ctx, req, hooks) {
    var step = (hooks && hooks.step) || function () {};
    return store.withLock(function () {
      var existing = store.find('ops_log', 'op_id', req.op_id)[0];
      if (existing) {
        if (existing.client_id !== ctx.client_id || existing.kind !== req.kind) {
          throw O.opsError('OP_ID_CONFLICT', 'Этот ID операции уже использован для другой операции');
        }
        if (existing.status === 'posted') {
          return { status: 'already', op_id: req.op_id, result: JSON.parse(existing.result_json || '{}'), notify: [] };
        }
        if (existing.status === 'failed') {
          throw O.opsError('OP_FAILED', 'Операция не прошла — оформите её заново');
        }
        return apply(store, ctx, JSON.parse(existing.plan_json), step); // pending: дописываем
      }
      var plan = O.build(O.makeView(store, ctx), req.kind, req.op_id, req.payload);
      store.append('ops_log', [{
        op_id: plan.op_id, client_id: plan.client_id, point_id: plan.point_id, shift_id: plan.shift_id,
        kind: plan.kind, actor_staff_id: ctx.staff_id, status: 'pending',
        created_at: ctx.now, posted_at: '', plan_json: JSON.stringify(plan), result_json: ''
      }]);
      step('logged');
      return apply(store, ctx, plan, step);
    });
  }

  function apply(store, ctx, plan, step) {
    Object.keys(plan.facts).forEach(function (sheet) {
      if (!store.find(sheet, 'op_id', plan.op_id).length) store.append(sheet, plan.facts[sheet]);
      step('facts:' + sheet);
    });
    plan.updates.forEach(function (u) { store.update(u.sheet, u.match, u.set); });
    step('updates');
    recomputeStock(store, plan.client_id, plan.point_id, plan.stock_items, plan.op_id, ctx.now);
    step('stock');
    store.update('ops_log', { op_id: plan.op_id }, {
      status: 'posted', posted_at: ctx.now, result_json: JSON.stringify(plan.result)
    });
    return { status: 'posted', op_id: plan.op_id, result: plan.result, notify: plan.notify };
  }

  /** Остаток позиции = сумма движений проведённых операций (+ проводимой сейчас). */
  function recomputeStock(store, clientId, pointId, items, includeOpId, now) {
    if (!items.length) return;
    var posted = {};
    store.rows('ops_log').forEach(function (o) { if (o.status === 'posted') posted[o.op_id] = true; });
    if (includeOpId) posted[includeOpId] = true;
    var qty = {};
    items.forEach(function (id) { qty[id] = 0; });
    store.rows('stock_moves').forEach(function (m) {
      if (m.client_id === clientId && m.point_id === pointId && qty[m.item_id] !== undefined && posted[m.op_id]) {
        qty[m.item_id] += m.qty;
      }
    });
    items.forEach(function (id) {
      var match = { client_id: clientId, point_id: pointId, item_id: id };
      var set = { qty: qty[id], last_op_id: includeOpId || '', updated_at: now };
      var exists = store.rows('stock_balance').some(function (b) {
        return b.client_id === clientId && b.point_id === pointId && b.item_id === id;
      });
      if (exists) store.update('stock_balance', match, set);
      else store.append('stock_balance', [Object.assign({}, match, set)]);
    });
  }

  /**
   * Зависшая операция (D14): pending дольше часа → failed.
   * Состояния откатываются, если их с тех пор никто не менял; остатки пересчитываются без неё.
   */
  function failStale(store, now, maxAgeMs) {
    var failed = [];
    store.withLock(function () {
      store.rows('ops_log').filter(function (o) {
        return o.status === 'pending' && Date.parse(now) - Date.parse(o.created_at) > maxAgeMs;
      }).forEach(function (o) {
        var plan = JSON.parse(o.plan_json);
        plan.updates.forEach(function (u) {
          var rows = store.rows(u.sheet).filter(function (r) { return matches(r, u.match); });
          var untouched = rows.every(function (r) {
            return Object.keys(u.set).every(function (k) { return r[k] === u.set[k]; });
          });
          if (rows.length && untouched) store.update(u.sheet, u.match, u.before);
        });
        store.update('ops_log', { op_id: o.op_id }, { status: 'failed', posted_at: '' });
        recomputeStock(store, plan.client_id, plan.point_id, plan.stock_items, null, now);
        failed.push(o.op_id);
      });
    });
    return failed;
  }

  /** Ночная сверка: остатки в stock_balance против журнала. Возвращает расхождения и исправляет их. */
  function reconcileStock(store, now) {
    var diffs = [];
    store.withLock(function () {
      var groups = {};
      store.rows('stock_balance').forEach(function (b) {
        var k = b.client_id + '|' + b.point_id;
        (groups[k] = groups[k] || { c: b.client_id, p: b.point_id, items: {} }).items[b.item_id] = b.qty;
      });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k];
        var ids = Object.keys(g.items);
        var before = Object.assign({}, g.items);
        recomputeStock(store, g.c, g.p, ids, null, now);
        store.rows('stock_balance').forEach(function (b) {
          if (b.client_id === g.c && b.point_id === g.p && before[b.item_id] !== b.qty) {
            diffs.push({ client_id: g.c, point_id: g.p, item_id: b.item_id, was: before[b.item_id], now: b.qty });
          }
        });
      });
    });
    return diffs;
  }

  function matches(row, match) {
    return Object.keys(match).every(function (k) { return row[k] === match[k]; });
  }

  return { post: post, failStale: failStale, reconcileStock: reconcileStock, matches: matches };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Posting;
