/* Флора·Учёт — касса (Mini App). Экраны: главная и продажа/букет.
 * Суммы считаются той же формулой, что и на сервере (js/calc.js = apps-script/core/calc.js).
 * Каждая продажа несёт op_id: повторное нажатие или повтор после обрыва связи не создаёт дубль.
 */
(function () {
  'use strict';

  var tg = window.Telegram && window.Telegram.WebApp;
  var app = document.getElementById('app');
  var DRAFT_KEY = 'flora.sale.draft.v1';
  var CATS = { flowers: 'Цветы', greens: 'Зелень', toys: 'Игрушки', baskets: 'Корзины', packaging: 'Упаковка' };

  var state = { data: null, screen: 'main', sending: false, cat: 'all', query: '', draft: null };

  // ---------- общие ----------

  function money(n) {
    var sign = n < 0 ? '−' : '';
    return sign + String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₸';
  }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'onclick' || k === 'oninput') e[k] = attrs[k];
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    });
  }
  function toast(text, isError) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.className = 'toast' + (isError ? ' toast--error' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, isError ? 5000 : 2500);
  }
  function haptic(kind) {
    try { if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(kind); } catch (e) { /* не важно */ }
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
    return null;
  }

  // ---------- сервер ----------

  function api(body) {
    body.initData = tg ? tg.initData : '';
    return fetch(window.FLORA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // простой запрос — без CORS-предзапроса
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); }).then(function (res) {
      if (!res.ok) {
        var e = new Error(res.error && res.error.message || 'Ошибка');
        e.code = res.error && res.error.code;
        e.details = res.error && res.error.details;
        throw e;
      }
      return res.data;
    });
  }

  function load() {
    return api({ action: 'bootstrap' }).then(function (data) {
      state.data = data;
      // Ссылка «Закрыть смену в кассе» из чата (передача смены) открывает сразу закрытие.
      if (location.hash === '#close' && data.shift && data.shift.on_shift) { history.replaceState(null, '', location.pathname); openClose(); return; }
      render();
    })
      .catch(function (e) { renderMessage(e.code ? e.message : 'Нет связи с сервером. Проверьте интернет и откройте кассу заново.'); });
  }

  // ---------- черновик продажи (живёт на телефоне до «Проведено») ----------

  function newDraft() {
    return { op_id: uuid(), type: 'sale', cart: {}, price: null, disc: 'none', discVal: '', pay: 'cash', cashPart: '' };
  }
  function draft() {
    if (!state.draft) state.draft = store(DRAFT_KEY) || newDraft();
    return state.draft;
  }
  function saveDraft() { store(DRAFT_KEY, state.draft); }

  function catalogSum(d) {
    return state.data.catalog.reduce(function (s, c) { return s + (d.cart[c.item_id] || 0) * c.price; }, 0);
  }
  function intOf(v) {
    var s = String(v == null ? '' : v).replace(/[\s ₸]/g, '');
    return /^\d{1,9}$/.test(s) ? Number(s) : null;
  }

  /** Всё, что нужно для кнопки «Провести»: итог или причина, почему нельзя. */
  function summary(d) {
    var items = Object.keys(d.cart).filter(function (id) { return d.cart[id] > 0; })
      .map(function (id) { return { item_id: id, qty: d.cart[id] }; });
    var sum = catalogSum(d);
    var price = d.price == null ? sum : intOf(d.price);
    var out = { items: items, sum: sum, price: price, total: 0, error: '', payload: null };
    if (!items.length) { out.error = 'Выберите позиции'; return out; }
    if (!price) { out.error = 'Введите цену'; return out; }
    var discount = d.disc === 'none' ? { kind: 'none' }
      : { kind: d.disc, value: d.disc === 'pct' ? Math.round((parseFloat(String(d.discVal).replace(',', '.')) || 0) * 100) : (intOf(d.discVal) || 0) };
    try {
      out.total = Calc.receiptTotal(price, discount).total;
    } catch (e) { out.error = e.message; return out; }
    var payments;
    if (d.pay === 'cash') payments = [{ method: 'cash', amount: out.total }];
    else if (d.pay === 'card') payments = [{ method: 'card', amount: out.total }];
    else {
      var cash = intOf(d.cashPart);
      if (!cash || cash >= out.total) { out.error = 'Наличные — больше нуля и меньше итога'; return out; }
      payments = [{ method: 'cash', amount: cash }, { method: 'card', amount: out.total - cash }];
    }
    out.payload = { items: items, price: price, discount: discount, payments: payments };
    return out;
  }

  // ---------- главная кнопка Telegram ----------

  var mainHandler = null;
  function mainButton(text, enabled, onClick) {
    if (!tg) return;
    var mb = tg.MainButton;
    if (mainHandler) mb.offClick(mainHandler);
    mainHandler = null;
    if (!text) { mb.hide(); return; }
    mb.setText(text);
    if (enabled) mb.enable(); else mb.disable();
    mainHandler = onClick;
    mb.onClick(mainHandler);
    mb.show();
  }
  function backButton(on) {
    if (!tg) return;
    tg.BackButton.offClick(goMain);
    if (on) { tg.BackButton.onClick(goMain); tg.BackButton.show(); } else tg.BackButton.hide();
  }
  function goMain() { state.screen = 'main'; render(); }

  // ---------- экраны ----------

  function renderMessage(text) {
    mainButton(null);
    backButton(false);
    app.replaceChildren(el('div', { class: 'card card--note' }, [el('div', { text: text })]));
  }

  function render() {
    if (!state.data) return;
    if (state.screen === 'sale') return renderSale();
    if (state.screen === 'close') return renderClose();
    renderMain();
  }

  function renderMain() {
    backButton(false);
    mainButton(null);
    var d = state.data;
    var s = d.shift;
    var nodes = [];
    if (!s) {
      nodes.push(el('div', { class: 'card card--note' }, [el('div', { text: 'Смена не открыта. Откройте её в чате бота кнопкой «Открыть смену».' })]));
    } else {
      nodes.push(el('div', { class: 'row' }, [
        el('h1', { class: 'h1', text: 'Смена №' + s.shift_no }),
        el('div', { class: 'muted', text: s.florists.join(', ') + ' · с ' + String(s.opened_at).slice(11, 16) })
      ]));
      var cards = [el('div', { class: 'card card--accent' }, [
        el('div', { class: 'muted', text: 'Выручка смены' }),
        el('div', { class: 'big num', text: money(s.revenue) }),
        el('div', { class: 'muted', text: 'чеков: ' + s.receipts_count })
      ])];
      if (s.my_pay) {
        cards.push(el('div', { class: 'card' }, [
          el('div', { class: 'muted', text: 'Мой заработок' }),
          el('div', { class: 'big num copper', text: money(s.my_pay.total) }),
          el('div', { class: 'muted num', text: money(s.my_pay.rate) + ' + ' + money(s.my_pay.pct) })
        ]));
      }
      nodes.push(el('div', { class: 'grid2' }, cards));
      if (s.on_shift) {
        nodes.push(el('button', { class: 'btn btn--primary btn--action', onclick: function () { state.screen = 'sale'; render(); } }, [
          el('span', { class: 'big', text: 'Продажа / букет' }),
          el('span', { text: 'Позиции, цена, скидка, оплата' })
        ]));
        nodes.push(el('button', { class: 'btn', onclick: function () { openClose(); } }, ['Закрыть смену']));
        nodes.push(el('div', { class: 'muted center', text: 'Предзаказы, приход, брак и возвраты — на следующем шаге.' }));
      } else {
        nodes.push(el('div', { class: 'card card--note' }, [el('div', { text: 'Вы не работаете в этой смене.' })]));
      }
    }
    app.replaceChildren.apply(app, nodes);
  }

  function renderSale() {
    backButton(true);
    var d = draft();
    var cats = ['all'].concat(Object.keys(CATS).filter(function (k) {
      return state.data.catalog.some(function (c) { return c.category === k; });
    }));
    var q = state.query.trim().toLowerCase();
    var list = state.data.catalog.filter(function (c) {
      return (state.cat === 'all' || c.category === state.cat) && (!q || c.name.toLowerCase().indexOf(q) >= 0);
    });

    var typeChips = el('div', { class: 'chips' }, [['sale', 'Продажа'], ['bouquet', 'Букет']].map(function (t) {
      return el('button', { class: 'chip', 'aria-pressed': String(d.type === t[0]), onclick: function () { d.type = t[0]; saveDraft(); renderSale(); } }, [t[1]]);
    }));
    var catChips = el('div', { class: 'chips' }, cats.map(function (k) {
      return el('button', { class: 'chip', 'aria-pressed': String(state.cat === k), onclick: function () { state.cat = k; renderSale(); } }, [k === 'all' ? 'Все' : CATS[k]]);
    }));
    var search = el('input', { class: 'search', type: 'search', placeholder: 'Поиск позиции', value: state.query,
      oninput: function (e) { state.query = e.target.value; renderTilesOnly(); } });

    var tiles = el('div', { class: 'tiles', id: 'tiles' });
    function renderTilesOnly() {
      var qq = state.query.trim().toLowerCase();
      var l = state.data.catalog.filter(function (c) {
        return (state.cat === 'all' || c.category === state.cat) && (!qq || c.name.toLowerCase().indexOf(qq) >= 0);
      });
      tiles.replaceChildren.apply(tiles, l.map(tile));
      if (!l.length) tiles.replaceChildren(el('div', { class: 'muted', text: 'Ничего не найдено' }));
    }
    function tile(c) {
      var qty = d.cart[c.item_id] || 0;
      var low = c.stock < c.min;
      return el('div', { class: 'tile' + (qty ? ' tile--on' : '') }, [
        el('div', { class: 'tile__name', text: c.name }),
        el('div', { class: 'tile__meta num' + (low ? ' tile__meta--low' : ''), text: money(c.price) + ' · остаток ' + c.stock }),
        el('div', { class: 'stepper' }, [
          el('button', { 'aria-label': 'Убрать ' + c.name, disabled: qty === 0, onclick: function () { change(c, -1); } }, ['−']),
          el('span', { class: 'stepper__qty num', text: String(qty) }),
          el('button', { 'aria-label': 'Добавить ' + c.name, disabled: qty >= c.stock, onclick: function () { change(c, 1); } }, ['+'])
        ])
      ]);
    }
    function change(c, delta) {
      var next = (d.cart[c.item_id] || 0) + delta;
      if (next < 0 || next > c.stock) return;
      if (next) d.cart[c.item_id] = next; else delete d.cart[c.item_id];
      saveDraft();
      renderTilesOnly();
      renderBottom();
    }
    renderTilesOnly();

    var bottom = el('div', { class: 'card', id: 'bottom' });
    function renderBottom() {
      var sm = summary(d);
      var priceInput = el('input', { class: 'input num', inputmode: 'numeric', value: d.price == null ? (sm.sum || '') : d.price,
        oninput: function (e) { d.price = e.target.value; saveDraft(); updateTotals(); } });
      var discChips = el('div', { class: 'chips' }, [['none', 'Без скидки'], ['amount', 'Скидка ₸'], ['pct', 'Скидка %']].map(function (t) {
        return el('button', { class: 'chip', 'aria-pressed': String(d.disc === t[0]), onclick: function () { d.disc = t[0]; d.discVal = ''; saveDraft(); renderBottom(); } }, [t[1]]);
      }));
      var discInput = d.disc === 'none' ? null : el('input', { class: 'input num', inputmode: 'decimal', placeholder: d.disc === 'pct' ? '10' : '500', value: d.discVal,
        oninput: function (e) { d.discVal = e.target.value; saveDraft(); updateTotals(); } });
      var payChips = el('div', { class: 'chips' }, [['cash', 'Нал'], ['card', 'Безнал'], ['mixed', 'Нал + безнал']].map(function (t) {
        return el('button', { class: 'chip', 'aria-pressed': String(d.pay === t[0]), onclick: function () { d.pay = t[0]; saveDraft(); renderBottom(); } }, [t[1]]);
      }));
      var cashInput = d.pay !== 'mixed' ? null : el('div', { class: 'field' }, [
        el('label', { text: 'Наличными (остальное — безнал)' }),
        el('input', { class: 'input num', inputmode: 'numeric', value: d.cashPart, oninput: function (e) { d.cashPart = e.target.value; saveDraft(); updateTotals(); } })
      ]);
      var totals = el('div', { id: 'totals' });
      bottom.replaceChildren(
        el('div', { class: 'sum' }, [el('span', { class: 'muted', text: 'По каталогу' }), el('span', { class: 'num', text: money(sm.sum) })]),
        el('div', { class: 'field' }, [el('label', { text: 'Цена (можно поставить свою)' }), priceInput]),
        discChips, discInput, payChips, cashInput, totals
      );
      updateTotals();
    }
    function updateTotals() {
      var sm = summary(d);
      var t = document.getElementById('totals');
      var nodes = [];
      if (sm.total) nodes.push(el('div', { class: 'sum' }, [el('span', { text: 'Итого' }), el('span', { class: 'big num', text: money(sm.total) })]));
      if (d.pay === 'mixed' && sm.payload) nodes.push(el('div', { class: 'muted num', text: 'Безнал: ' + money(sm.payload.payments[1].amount) }));
      if (sm.error && sm.items.length) nodes.push(el('div', { class: 'error', text: sm.error }));
      if (t) t.replaceChildren.apply(t, nodes);
      var label = state.sending ? 'Проводим…' : (sm.payload ? 'Провести ' + money(sm.total) : 'Провести');
      mainButton(label, !!sm.payload && !state.sending, submit);
      if (!tg) {
        var fb = document.getElementById('fallback');
        if (fb) { fb.textContent = label; fb.disabled = !sm.payload || state.sending; }
      }
    }
    renderBottom();

    var nodes = [typeChips, catChips, search, tiles, bottom];
    if (!tg) nodes.push(el('button', { class: 'btn btn--primary fallback-main', id: 'fallback', onclick: submit }, ['Провести']));
    app.replaceChildren.apply(app, nodes);
    updateTotals();
  }

  // ---------- закрытие смены (ТЗ: инвентаризация → расходы → пересчёт вслепую → расхождение → ЗП → изъятие) ----------

  var CLOSE_KEY = 'flora.close.v1';

  function openClose() {
    var saved = store(CLOSE_KEY);
    var s = state.data.shift;
    if (saved && saved.shift_no === s.shift_no) state.close = saved;
    else state.close = { shift_no: s.shift_no, step: 'inv', op_id: uuid(), counted: '', withdrawal: '', preview: null, facts: null };
    if (state.close.step === 'inv' && s.inventory_done) state.close.step = 'exp';
    state.screen = 'close';
    render();
  }
  function saveClose() { store(CLOSE_KEY, state.close); }
  function goStep(step) { state.close.step = step; saveClose(); render(); window.scrollTo(0, 0); }

  function busy(promise) {
    state.sending = true;
    if (tg) tg.MainButton.showProgress(false);
    render();
    return promise.catch(function (e) {
      haptic('error');
      toast(e.code ? e.message : 'Нет связи. Ничего не потеряно — нажмите ещё раз.', true);
      throw e;
    }).then(function (v) { return v; }, function () { return null; }).then(function (v) {
      state.sending = false;
      if (tg) tg.MainButton.hideProgress();
      render();
      return v;
    });
  }
  function postOp(kind, payload, opId) {
    return api({ action: 'post', kind: kind, op_id: opId || uuid(), payload: payload });
  }
  function stepTitle(n, text) {
    return el('div', {}, [el('div', { class: 'muted', text: 'Закрытие смены · шаг ' + n + ' из 4' }), el('h1', { class: 'h1', text: text })]);
  }

  function renderClose() {
    backButton(true);
    var c = state.close;
    if (c.step === 'inv') return closeInventory(c);
    if (c.step === 'exp') return closeExpenses(c);
    if (c.step === 'count') return closeCount(c);
    if (c.step === 'result') return closeResult(c);
    return closeDone(c);
  }

  // Шаг 1. Инвентаризация: расчёт по каждой позиции, флорист вводит факт или жмёт «Всё верно».
  function closeInventory(c) {
    var items = state.data.catalog;
    if (!c.facts) { c.facts = {}; items.forEach(function (i) { c.facts[i.item_id] = String(i.stock); }); }
    var changed = function () { return items.some(function (i) { return intOf(c.facts[i.item_id]) !== i.stock; }); };
    var rows = items.map(function (i) {
      return el('div', { class: 'sum' }, [
        el('div', {}, [el('div', { text: i.name }), el('div', { class: 'muted num', text: 'по расчёту ' + i.stock })]),
        el('input', { class: 'input num', style: 'max-width:110px', inputmode: 'numeric', value: c.facts[i.item_id],
          'aria-label': 'Факт: ' + i.name,
          oninput: function (e) { c.facts[i.item_id] = e.target.value; saveClose(); updateMain(); } })
      ]);
    });
    function updateMain() {
      var bad = items.some(function (i) { return intOf(c.facts[i.item_id]) === null; });
      mainButton(state.sending ? 'Проводим…' : (changed() ? 'Провести инвентаризацию' : 'Всё верно'), !bad && !state.sending, submit);
    }
    function submit() {
      var facts = {};
      items.forEach(function (i) { facts[i.item_id] = intOf(c.facts[i.item_id]); });
      busy(postOp('inventory', { facts: facts })).then(function (res) {
        if (!res) return;
        state.data = res.state;
        var adj = res.result.adjustments || [];
        toast(adj.length ? 'Расхождений: ' + adj.length + ' — записаны' : 'Остатки сошлись');
        goStep('exp');
      });
    }
    app.replaceChildren(stepTitle(1, 'Инвентаризация'),
      el('div', { class: 'muted', text: 'Пересчитайте товар. Если сходится — «Всё верно», если нет — впишите факт.' }),
      el('div', { class: 'card' }, rows));
    updateMain();
  }

  // Шаг 2. Все ли расходы и изъятия внесены.
  function closeExpenses(c) {
    var e = state.data.shift.expenses;
    var form = c.exp || (c.exp = { type: 'delivery', amount: '', comment: '' });
    var list = el('div', { class: 'card' }, [
      el('div', { class: 'sum' }, [el('span', { text: 'Доставка' }), el('span', { class: 'num', text: money(e.delivery) })]),
      el('div', { class: 'sum' }, [el('span', { text: 'Прочие расходы' }), el('span', { class: 'num', text: money(e.other) })]),
      el('div', { class: 'sum' }, [el('span', { text: 'Владелица забрала' }), el('span', { class: 'num', text: money(e.withdrawal) })])
    ]);
    var chips = el('div', { class: 'chips' }, [['delivery', 'Доставка'], ['other', 'Прочее'], ['withdrawal', 'Владелица забрала']].map(function (t) {
      return el('button', { class: 'chip', 'aria-pressed': String(form.type === t[0]), onclick: function () { form.type = t[0]; saveClose(); render(); } }, [t[1]]);
    }));
    var amount = el('input', { class: 'input num', inputmode: 'numeric', placeholder: 'Сумма', value: form.amount, oninput: function (ev) { form.amount = ev.target.value; saveClose(); } });
    var comment = form.type === 'withdrawal' ? null : el('input', { class: 'search', placeholder: 'Комментарий (необязательно)', value: form.comment, oninput: function (ev) { form.comment = ev.target.value; saveClose(); } });
    var add = el('button', { class: 'btn', disabled: state.sending, onclick: function () {
      var sum = intOf(form.amount);
      if (!sum) return toast('Введите сумму', true);
      var op = form.type === 'withdrawal' ? postOp('withdrawal', { amount: sum }) : postOp('cash_out', { type: form.type, amount: sum, comment: form.comment });
      busy(op).then(function (res) {
        if (!res) return;
        state.data = res.state;
        c.exp = null; saveClose();
        toast('Добавлено: ' + money(sum));
        render();
      });
    } }, ['Добавить']);
    app.replaceChildren(stepTitle(2, 'Расходы и изъятия'),
      el('div', { class: 'muted', text: 'Проверьте: все доставки, прочие расходы и деньги, которые забрала владелица, внесены?' }),
      list, el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Добавить, если что-то забыли' }), chips, amount, comment, add]));
    mainButton(state.sending ? 'Проводим…' : 'Да, всё внесено', !state.sending, function () { goStep('count'); });
  }

  // Шаг 3. Пересчёт вслепую: расчётная сумма не показывается.
  function closeCount(c) {
    var input = el('input', { class: 'input num', inputmode: 'numeric', placeholder: 'Например, 32 498', value: c.counted, 'aria-label': 'Наличные в кассе',
      oninput: function (e) { c.counted = e.target.value; saveClose(); upd(); } });
    function upd() { mainButton(state.sending ? 'Считаем…' : 'Дальше', intOf(c.counted) !== null && !state.sending, next); }
    function next() {
      busy(api({ action: 'close_preview', counted: intOf(c.counted), close_withdrawal: 0 })).then(function (pv) {
        if (!pv) return;
        c.preview = pv; c.counted_sent = intOf(c.counted); goStep('result');
      });
    }
    app.replaceChildren(stepTitle(3, 'Пересчёт наличных'),
      el('div', { class: 'card card--note' }, [el('div', { text: 'Пересчитайте все наличные в кассе, включая размен, и впишите сумму. Сколько должно быть — бот покажет после.' })]),
      el('div', { class: 'field' }, [el('label', { text: 'Наличные в кассе' }), input]));
    upd();
    setTimeout(function () { input.focus(); }, 50);
  }

  // Шаг 4. Расхождение, зарплата, изъятие и закрытие.
  function closeResult(c) {
    var pv = c.preview;
    var counted = c.counted_sent;
    var paid = pv.payroll.reduce(function (s, p) { return s + p.paid; }, 0);
    var diffText = pv.cash_diff === 0 ? 'Касса сошлась' : (pv.cash_diff > 0 ? 'Излишек ' : 'Недостача ') + money(Math.abs(pv.cash_diff));
    var pay = pv.payroll.map(function (p) {
      return el('div', {}, [
        el('div', { class: 'sum' }, [el('span', { text: p.name }), el('span', { class: 'big num copper', text: money(p.paid) })]),
        p.unpaid ? el('div', { class: 'error', text: 'Не хватило наличных — к доплате ' + money(p.unpaid) + ' (владелица увидит в отчёте)' }) : null
      ]);
    });
    var hint = el('div', {});
    var wInput = el('input', { class: 'input num', inputmode: 'numeric', placeholder: '0', value: c.withdrawal,
      oninput: function (e) { c.withdrawal = e.target.value; saveClose(); upd(); } });
    function withdrawal() { return c.withdrawal === '' ? 0 : intOf(c.withdrawal); }
    function upd() {
      var w = withdrawal();
      var bad = w === null || w > pv.max_withdrawal;
      hint.replaceChildren(bad
        ? el('div', { class: 'error', text: w === null ? 'Сумма цифрами' : 'Больше, чем есть в кассе после зарплаты (' + money(pv.max_withdrawal) + ')' })
        : el('div', { class: 'sum' }, [el('span', { text: 'Останется на следующую смену' }), el('span', { class: 'num', text: money(counted - paid - w) })]));
      mainButton(state.sending ? 'Закрываем…' : 'Закрыть смену', !bad && !state.sending, submitClose);
    }
    function submitClose() {
      var w = withdrawal();
      busy(postOp('close_shift', { counted: counted, close_withdrawal: w || 0, expenses_confirmed: true }, c.op_id)).then(function (res) {
        if (!res) return;
        haptic('success');
        c.done = { next_cash: res.result.next_cash, shift_no: res.result.shift_no };
        state.data = res.state;
        goStep('done');
      });
    }
    app.replaceChildren(stepTitle(4, 'Итог смены'),
      el('div', { class: 'card ' + (pv.cash_diff === 0 ? '' : 'card--note') }, [
        el('div', { class: 'big', text: diffText, style: 'color:' + (pv.cash_diff < 0 ? 'var(--danger)' : 'var(--ok)') }),
        el('div', { class: 'muted num', text: 'Пересчитано: ' + money(counted) })
      ]),
      el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Возьмите из кассы зарплату:' })].concat(pay)),
      el('div', { class: 'card' }, [
        el('div', { class: 'muted', text: 'Владелица забирает сейчас (если нет — оставьте пустым)' }),
        wInput,
        el('div', { class: 'muted num', text: 'Можно забрать, чтобы остался размен: ' + money(pv.can_take_above_change_fund) }),
        hint
      ]));
    upd();
  }

  function closeDone(c) {
    store(CLOSE_KEY, null);
    backButton(false);
    app.replaceChildren(
      el('div', { class: 'card card--accent' }, [
        el('div', { class: 'big', text: 'Смена №' + c.done.shift_no + ' закрыта' }),
        el('div', { class: 'muted num', text: 'Оставлено в кассе на следующую смену: ' + money(c.done.next_cash) })
      ]),
      el('div', { class: 'muted center', text: 'Отчёт отправлен владелице.' }));
    mainButton('Готово', true, function () { state.close = null; state.screen = 'main'; render(); });
  }

  // ---------- проведение ----------

  function submit() {
    var d = draft();
    var sm = summary(d);
    if (!sm.payload || state.sending) return;
    state.sending = true;
    if (tg) tg.MainButton.showProgress(false);
    render();
    api({ action: 'post', kind: d.type, op_id: d.op_id, payload: sm.payload })
      .then(function (res) {
        state.data = res.state;
        state.draft = newDraft();
        store(DRAFT_KEY, null);
        haptic('success');
        toast((res.status === 'already' ? 'Уже было проведено: ' : 'Проведено: ') + money(res.result.total));
        state.screen = 'main';
      })
      .catch(function (e) {
        haptic('error');
        if (!e.code) toast('Нет связи. Продажа сохранена на телефоне — нажмите «Провести» ещё раз.', true);
        else toast(e.message, true);
        if (e.code === 'OP_FAILED') { d.op_id = uuid(); saveDraft(); }
      })
      .then(function () {
        state.sending = false;
        if (tg) tg.MainButton.hideProgress();
        render();
      });
  }

  // ---------- старт ----------

  if (tg) {
    tg.ready();
    tg.expand();
    document.documentElement.setAttribute('data-theme', tg.colorScheme === 'dark' ? 'dark' : 'light');
    tg.onEvent('themeChanged', function () {
      document.documentElement.setAttribute('data-theme', tg.colorScheme === 'dark' ? 'dark' : 'light');
    });
  }
  if (!tg || !tg.initData) {
    renderMessage('Откройте кассу из бота: кнопка «Касса» в меню @flora_uchet_bot.');
    return;
  }
  load();
})();
