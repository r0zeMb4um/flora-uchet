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

    if (r.control) {
      L.push('');
      if (r.control.clean) L.push('🔎 <b>Контроль:</b> замечаний нет');
      else {
        L.push('🔎 <b>КОНТРОЛЬ</b> (что стоит глянуть)');
        r.control.items.slice(0, 12).forEach(function (c) { L.push('  ' + esc(c.text)); });
        if (r.control.items.length > 12) L.push('  …и ещё ' + (r.control.items.length - 12));
      }
    }
    var goods = [];
    r.income.forEach(function (m) { goods.push('  приход: ' + item(m.item_id) + ' +' + m.qty + ' (' + money(m.cost_sum) + ')'); });
    r.defects.forEach(function (m) { goods.push('  брак: ' + item(m.item_id) + ' ' + signed(m.qty) + ' (' + money(m.cost) + ' по закупке)'); });
    r.adjustments.forEach(function (m) { goods.push('  инвентаризация: ' + item(m.item_id) + ' ' + signed(m.qty) + ' (' + money(m.cost) + ')'); });
    r.below_min.forEach(function (b) { goods.push('  ниже минимума: ' + item(b.item_id) + ' — ' + b.qty + ' / ' + b.min); });
    if (goods.length) { L.push(''); L.push('<b>ТОВАР</b>'); L.push.apply(L, goods); }
    return L.join('\n');
  }

  var CATS = { flowers: 'ЦВЕТЫ', greens: 'ЗЕЛЕНЬ', toys: 'ИГРУШКИ', baskets: 'КОРЗИНЫ', packaging: 'УПАКОВКА' };

  function pct(cur, prev) {
    if (!prev) return cur ? 'новое' : '—';
    var v = Math.round((cur - prev) / Math.abs(prev) * 100);
    return (v >= 0 ? '↑ ' : '↓ ') + Math.abs(v) + '%';
  }
  /** «1 выдача, 2 выдачи, 5 выдач». */
  function plural(n, one, few, many) {
    var m = Math.abs(n) % 100, d = m % 10;
    return n + ' ' + (m > 10 && m < 20 ? many : d === 1 ? one : d > 1 && d < 5 ? few : many);
  }

  /** Сводка за период — шаблон ТЗ. names.staff — имена флористов; extra: { prev: сводка прошлого периода, top: [...] }. */
  function periodText(s, names, extra) {
    var person = function (id) { return esc((names.staff || {})[id] || id); };
    var L = [];
    L.push('<b>Сводка ' + dateRu(s.from) + ' — ' + dateRu(s.to) + '</b>' + (s.corrected_shifts ? ' · исправленных смен: ' + s.corrected_shifts : ''));
    L.push('');
    L.push('Выручка <b>' + money(s.revenue) + '</b> (смен ' + s.shifts + ', чеков ' + s.receipts + ', средний чек ' + money(s.avg_check) + ')');
    L.push('Деньги получены: нал ' + money(s.cash) + ' · безнал ' + money(s.card));
    var sup = Object.keys(s.by_supplier).map(function (k) { return esc(k) + ' ' + money(s.by_supplier[k]); }).join(', ');
    L.push('Закупки ' + money(s.purchases) + (sup ? ' (' + sup + ')' : ''));
    L.push('ЗП ' + money(s.payroll));
    s.payroll_by.forEach(function (p) {
      L.push('  ' + person(p.staff_id) + ': смен ' + p.shifts + ', ставка ' + money(p.rate) + ', % ' + money(p.pct));
    });
    var exp = [['Доставки', s.delivery], ['Прочее', s.other], ['Возвраты', s.refunds]]
      .map(function (x) { return x[0] + ' ' + money(x[1]); });
    Object.keys(s.owner_by_item).forEach(function (k) { exp.push(esc(k) + ' ' + money(s.owner_by_item[k])); });
    L.push(exp.join(' · '));
    L.push('<b>ПРИБЫЛЬ ' + money(s.profit) + '</b>');
    L.push('Потери: брак ' + money(s.losses.defects) + ' · замены ' + money(s.losses.replaces) +
      ' · недостачи товара ' + money(s.losses.shortage) + ' · расхождения кассы ' + money(s.losses.cash_diff));
    var disc = Object.keys(s.discounts_by).map(function (k) { return person(k) + ' ' + money(s.discounts_by[k]); }).join(', ');
    L.push('Скидки ' + money(s.discounts) + (disc ? ' (' + disc + ')' : ''));
    L.push('Изъято владелицей ' + money(s.withdrawal));
    L.push('Стоимость остатка на складе: на начало ' + money(s.stock_value_start) + ' · на конец ' + money(s.stock_value_end));
    L.push('Не получено: долги ' + money(s.not_received.debts) + ' (старше 30 дней ' + money(s.not_received.debts_old) +
      ') · предзаказы к доплате ' + money(s.not_received.preorders));
    if (extra && extra.prev) {
      L.push('');
      L.push('К прошлому периоду: выручка ' + pct(s.revenue, extra.prev.revenue) + ' · прибыль ' + pct(s.profit, extra.prev.profit));
    }
    if (extra && extra.top && extra.top.length) {
      L.push('Топ: ' + extra.top.map(function (t) { return esc(t.name) + ' ' + t.qty + ' шт'; }).join(' · '));
    }
    return L.join('\n');
  }

  /** Утреннее сообщение владелице: вчера, ниже минимума, что закупить. */
  function morningText(day, below, restock) {
    var cash = !day.all_closed ? 'смена не закрыта' : day.cash_diff === 0 ? 'касса сошлась' : 'расхождение кассы ' + money(day.cash_diff);
    var L = ['🌸 Доброе утро! Вчера: <b>' + money(day.revenue) + '</b> · чеков ' + day.receipts + ' · прибыль ' + money(day.profit) + ' · ' + cash +
      (day.top_item ? ' · лучшая позиция — ' + esc(day.top_item.name) : '') + '.'];
    if (below.length) L.push('Ниже минимума: ' + below.slice(0, 6).map(function (b) { return esc(b.name) + ' ' + b.qty + '/' + b.min; }).join(', ') + '.');
    if (restock.length) L.push('Закупить: ' + restock.slice(0, 6).map(function (x) { return esc(x.name) + ' ' + x.buy; }).join(', ') + '.');
    L.push('Подробности — в «Кассе» → «Сегодня».');
    return L.join('\n');
  }

  function restockText(list) {
    if (!list.length) return 'Запасов хватает: закупать ничего не нужно.';
    var L = ['<b>Закупка на неделю</b>', 'Считаем так: продано за 7 дней + минимум − есть сейчас.', ''];
    list.forEach(function (x) {
      L.push(esc(x.name) + ' — есть ' + x.stock + ' (мин. ' + x.min + ')' + (x.weekly ? ', за неделю продано ' + x.weekly : '') +
        (x.days_left !== null && x.days_left < 7 ? ', хватит на ' + plural(x.days_left, 'день', 'дня', 'дней') : '') + ' → <b>закупить ' + x.buy + '</b>');
    });
    L.push('', '<b>Закупить:</b> ' + list.map(function (x) { return esc(x.name) + ' ' + x.buy; }).join(', '));
    return L.join('\n');
  }

  /** Напоминание о выдачах на день: label — «Сегодня» или «Завтра». Пустая строка, если выдач нет. */
  function pickupsText(p, label) {
    if (!p.total && !p.overdue) return '';
    var L = [];
    if (p.total) {
      var notReady = p.waiting + p.reservations;
      L.push('📦 ' + label + ' ' + plural(p.total, 'выдача', 'выдачи', 'выдач') + (notReady ? ': не собрано ' + notReady + ' — проверьте сборку' : ': всё собрано') + '.');
      p.items.slice(0, 8).forEach(function (i) {
        L.push('  ' + esc(i.customer) + ' · ' + money(i.total) + (i.reservation ? ' · бронь без аванса' : i.assembled ? ' · собран' : ' · НЕ СОБРАН'));
      });
    }
    if (p.overdue) L.push('⚠️ Просрочено выдач: ' + p.overdue + ' — проверьте, забрали ли заказ.');
    return L.join('\n');
  }

  function stockText(st, nowIso) {
    var L = ['<b>Остатки на ' + dateRu(String(nowIso).slice(0, 10)) + ', ' + String(nowIso).slice(11, 16) + '</b>'];
    if (st.below.length) {
      L.push('', '<b>НИЖЕ МИНИМУМА:</b>');
      st.below.forEach(function (i) { L.push('  ' + esc(i.name) + ' — ' + i.qty + ' / ' + i.min); });
    }
    Object.keys(CATS).forEach(function (cat) {
      var list = st.items.filter(function (i) { return i.category === cat; });
      if (!list.length) return;
      L.push('', '<b>' + CATS[cat] + ':</b>');
      list.forEach(function (i) { L.push('  ' + esc(i.name) + ' — ' + i.qty); });
    });
    return L.join('\n');
  }

  function debtorsText(list) {
    if (!list.length) return 'Должников нет.';
    var L = ['<b>Должники</b>'];
    list.forEach(function (d) {
      L.push(esc(d.name) + (d.note ? ' · ' + esc(d.note) : '') + ' · долг ' + money(d.debt) + (d.since ? ' · с ' + dateRu(d.since) : ''));
    });
    L.push('', '<b>Итого долгов: ' + money(list.reduce(function (a, d) { return a + d.debt; }, 0)) + '</b>');
    return L.join('\n');
  }

  return { shiftText: shiftText, periodText: periodText, stockText: stockText, debtorsText: debtorsText, money: money,
    morningText: morningText, restockText: restockText, pickupsText: pickupsText, plural: plural, pct: pct };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Reports;
