/**
 * Схема листов Google Таблицы — единственный источник колонок (docs/DATA_MODEL.md).
 * Тип: s — текст (формат «@», чтобы Таблица не превращала даты и ID в числа), n — целое число, b — да/нет.
 * Тесты прогоняют симуляцию через хранилище, которое сверяет каждую запись с этой схемой.
 */
var Schema = (function () {
  'use strict';

  function cols(spec) {
    return spec.split(/\s+/).filter(Boolean).map(function (c) {
      var p = c.split(':');
      return { name: p[0], type: p[1] || 's' };
    });
  }
  var META = ' op_id created_at';

  var SHEETS = {
    clients: cols('client_id name tariff paid_until timezone admin_finance_access:b' + META),
    points: cols('point_id client_id name address' + META),
    settings: cols('client_id point_id change_fund:n reminder_time cash_tolerance:n expense_items' + META),
    catalog: cols('item_id client_id code category name unit sale_price:n last_cost:n min_stock:n status created_by' + META),
    staff: cols('staff_id client_id point_id telegram_id name role shift_rate:n pct_bp:n consent_at consent_version active:b' + META + ' works_shifts:b'),
    invites: cols('token client_id point_id staff_id expires_at status used_by_telegram_id' + META),
    customers: cols('customer_id client_id name note phone phone_consent_at anonymized:b' + META),
    ops_log: cols('op_id client_id point_id shift_id kind actor_staff_id status created_at posted_at plan_json result_json'),
    shifts: cols('shift_id shift_no:n client_id point_id shift_date florist_ids opened_at closed_at prev_next_cash:n open_cash:n open_diff:n ' +
      'calc_cash:n counted_cash:n cash_diff:n payroll_total:n payroll_unpaid:n close_withdrawal:n next_cash:n status' + META),
    shift_staff: cols('shift_id staff_id client_id point_id shift_rate:n pct_bp:n' + META),
    receipts: cols('receipt_id receipt_no:n client_id point_id shift_id type price:n discount_kind discount_value:n discount_amount:n ' +
      'total:n debt_amount:n customer_id pickup_date assembly_status status reservation_id created_by' + META),
    reservations: cols('reservation_id client_id point_id shift_id customer_id pickup_date price:n discount_kind discount_value:n ' +
      'discount_amount:n total:n status receipt_id created_by' + META),
    payments: cols('payment_id client_id point_id shift_id receipt_id customer_id kind method amount:n' + META),
    debt_moves: cols('debt_move_id client_id point_id shift_id customer_id type amount:n receipt_id since_date comment' + META),
    stock_moves: cols('move_id client_id point_id shift_id type item_id qty:n cost_sum:n supplier_or_reason receipt_id' + META),
    stock_balance: cols('client_id point_id item_id qty:n last_op_id updated_at'),
    cash_ops: cols('cash_id client_id point_id shift_id type amount:n staff_id comment' + META),
    owner_expenses: cols('expense_id client_id point_id month item amount:n comment created_by' + META),
    schedule: cols('entry_id client_id point_id date staff_id note status' + META),
    bouquet_templates: cols('template_id client_id name items_json price:n status created_by' + META),
    audit: cols('ts actor_telegram_id action details_json')
  };

  function headers(sheet) {
    var c = SHEETS[sheet];
    if (!c) throw new Error('Нет такого листа в схеме: ' + sheet);
    return c.map(function (x) { return x.name; });
  }

  /** Проверка строки перед записью: только известные колонки, числа — целые, да/нет — boolean. */
  function check(sheet, row) {
    var c = SHEETS[sheet];
    if (!c) throw new Error('Нет такого листа в схеме: ' + sheet);
    var byName = {};
    c.forEach(function (x) { byName[x.name] = x.type; });
    Object.keys(row).forEach(function (k) {
      var t = byName[k];
      var v = row[k];
      if (!t) throw new Error('Колонки «' + k + '» нет в листе ' + sheet);
      if (v === '' || v === null || v === undefined) return;
      if (t === 'n' && !Number.isSafeInteger(v)) throw new Error(sheet + '.' + k + ' — должно быть целое число: ' + v);
      if (t === 'b' && typeof v !== 'boolean') throw new Error(sheet + '.' + k + ' — должно быть да/нет: ' + v);
      if (t === 's' && typeof v !== 'string') throw new Error(sheet + '.' + k + ' — должен быть текст: ' + v);
    });
  }

  return { SHEETS: SHEETS, headers: headers, check: check };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Schema;
