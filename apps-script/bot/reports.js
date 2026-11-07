/**
 * Тексты отчётов для Telegram (HTML). Шаблон — ТЗ, «Шаблоны отчётов → Отчёт смены».
 * Строки с нулевыми суммами не показываются. Функции чистые: данные из Ops.shiftReport + справочники имён.
 */
var Reports = (function () {
  'use strict';

  function money(n) {
    var sign = n < 0 ? '−' : '';
    return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n); }
  function dateRu(iso) { var p = String(iso).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso; }

  /** «нал 23 000 ₸ · безнал 27 400 ₸» — только ненулевые части. */
  function parts(list) {
    return list.filter(function (x) { return x[1]; }).map(function (x) {
      return x[0] + ' ' + (typeof x[1] === 'number' && x[2] !== 'qty' ? money(x[1]) : x[1] + (x[2] === 'qty' ? ' шт' : ''));
    }).join(' · ');
  }

  /**
   * r — Ops.shiftReport; names — { items: {id: name}, staff: {id: name} }.
   */
  function shiftText(r, names) {
    var item = function (id) { return esc((names.items || {})[id] || id); };
    var person = function (id) { return esc((names.staff || {})[id] || id); };
    var L = [];
    L.push('<b>Смена №' + r.shift_no + '</b> · ' + dateRu(r.shift_date) + ' · ' + r.florists.map(esc).join(', ') +
      (r.corrected ? ' · <b>ИСПРАВЛЕНО</b> (' + r.corrected + ')' : ''));
    L.push('');
    L.push('<b>ВЫРУЧКА: ' + money(r.revenue) + '</b> (чеков: ' + r.receipts_count + ')');
    var rev = parts([['нал', r.sales_cash], ['безнал', r.sales_card], ['в долг', r.sales_debt], ['предзаказы к доплате', r.preorder_unpaid]]);
    if (rev) L.push('  ' + rev);
    var extra = parts([['скидки', r.discounts]]);
    if (r.cancelled_count) extra = (extra ? extra + ' · ' : '') + 'отменено чеков ' + r.cancelled_count;
    if (extra) L.push('  ' + extra);
    var prior = parts([['нал', r.prior_cash], ['безнал', r.prior_card]]);
    if (prior) L.push('ПОСТУПИЛО ПО ПРОШЛЫМ ДОЛГАМ И ЗАКАЗАМ: ' + prior);
    var refunds = parts([['нал', r.refunds_cash], ['безнал', r.refunds_card], ['замены', r.replaced_qty, 'qty']]);
    if (refunds) L.push('ВОЗВРАТЫ: ' + refunds);

    L.push('');
    L.push('<b>КАССА</b>');
    var start = 'на начало ' + money(r.open_cash) + (r.open_diff ? ' (расхождение при приёме ' + money(r.open_diff) + ')' : '');
    L.push('  ' + start + ' → расчёт ' + money(r.calc_cash) + ' → пересчёт ' + money(r.counted_cash));
    var diffWord = r.cash_diff > 0 ? ' (излишек)' : r.cash_diff < 0 ? ' (недостача)' : '';
    L.push('  <b>РАСХОЖДЕНИЕ: ' + money(r.cash_diff) + diffWord + '</b>');
    L.push('  остаток на следующую смену (после ЗП и изъятия): ' + money(r.next_cash));
    if (r.card_total) L.push('<b>БЕЗНАЛ ДЛЯ СВЕРКИ С KASPI: ' + money(r.card_total) + '</b>');

    L.push('');
    L.push('<b>ЗАРПЛАТА</b>');
    r.payroll.forEach(function (p) {
      var line = '  ' + person(p.staff_id) + ': ставка ' + money(p.rate) + ' + % ' + money(p.pct) + ' = ' + money(p.total);
      if (p.unpaid > 0) line += ' — <b>к доплате ' + money(p.unpaid) + '</b>';
      if (p.unpaid < 0) line += ' — <b>переплачено ' + money(-p.unpaid) + '</b> (решает владелица)';
      L.push(line);
    });
    var exp = parts([['доставка', r.delivery], ['прочее', r.other], ['доплаты ЗП', r.pay_adjust]]);
    if (exp) L.push('РАСХОДЫ: ' + exp);
    if (r.withdrawal) L.push('ИЗЪЯТИЕ: ' + money(r.withdrawal));

    var goods = [];
    r.income.forEach(function (m) { goods.push('  приход: ' + item(m.item_id) + ' +' + m.qty + ' (' + money(m.cost_sum) + ')'); });
    r.defects.forEach(function (m) { goods.push('  брак: ' + item(m.item_id) + ' ' + signed(m.qty) + ' (' + money(m.cost) + ' по закупке)'); });
    r.adjustments.forEach(function (m) { goods.push('  инвентаризация: ' + item(m.item_id) + ' ' + signed(m.qty) + ' (' + money(m.cost) + ')'); });
    r.below_min.forEach(function (b) { goods.push('  ниже минимума: ' + item(b.item_id) + ' — ' + b.qty + ' / ' + b.min); });
    if (goods.length) { L.push(''); L.push('<b>ТОВАР</b>'); L.push.apply(L, goods); }
    return L.join('\n');
  }

  return { shiftText: shiftText, money: money };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Reports;
