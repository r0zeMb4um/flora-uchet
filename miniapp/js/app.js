/* Флора·Учёт — касса (Mini App). Экраны: главная и продажа/букет.
 * Суммы считаются той же формулой, что и на сервере (js/calc.js = apps-script/core/calc.js).
 * Каждая продажа несёт op_id: повторное нажатие или повтор после обрыва связи не создаёт дубль.
 */
(function () {
  'use strict';

  // replaceChildren превращает null/undefined/false в текст «null». Пропускаем пустые места — тогда в списках можно писать «условие ? элемент : null».
  (function () {
    var orig = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function () {
      return orig.apply(this, Array.prototype.slice.call(arguments).filter(function (x) { return x !== null && x !== undefined && x !== false; }));
    };
  })();

  var tg = window.Telegram && window.Telegram.WebApp;
  var app = document.getElementById('app');
  var DRAFT_KEY = 'flora.sale.draft.v1';
  var CATS = { flowers: 'Цветы', greens: 'Зелень', toys: 'Игрушки', baskets: 'Корзины', packaging: 'Упаковка' };
  var LAST_KEY = 'flora.last.v1';
  var QUEUE_KEY = 'flora.queue.v1'; // продажи, ещё не принятые сервером
  var OC_KEY = 'flora.oc.v1'; // последние данные экранов владелицы — открываются мгновенно, обновляются в фоне
  var LITE_KEY = 'flora.lite';
  var CACHE_KEY = 'flora.cache.v1'; // последние данные кассы (каталог, остатки) — касса открывается мгновенно
  var LARGE_SUM = 50000; // с этой суммы «Провести» просит подтвердить
  var CAT_ICON = { flowers: 'flower', greens: 'leaf', toys: 'gift', baskets: 'basket', packaging: 'package' };

  /** Интерфейс владелицы (кабинет), а не режим смены: владелица, вышедшая в смену, видит экраны флориста. */
  /** Лёгкий вид: без размытия стекла, лепестков и анимаций. Включается сам на слабых телефонах или вручную. */
  function liteOn() {
    var v = null;
    try { v = localStorage.getItem('flora.lite'); } catch (e) { /* нет хранилища */ }
    if (v === '1') return true;
    if (v === '0') return false;
    return (navigator.deviceMemory || 8) <= 2; // сам включается только на совсем слабых телефонах; остальным — кнопка в «Ещё»
  }
  function applyLite() { document.body.classList.toggle('lite', liteOn()); }
  function liteToggle() {
    return el('button', { class: 'btn', onclick: function () {
      try { localStorage.setItem('flora.lite', liteOn() ? '0' : '1'); } catch (e) { /* ничего */ }
      applyLite(); render();
    } }, [icon('bolt'), liteOn() ? 'Лёгкий вид включён · вернуть красивый' : 'Включить лёгкий вид (быстрее на слабом телефоне)']);
  }

  function ownerUI(d) { var x = d || state.data; return !!x && x.me.role === 'owner' && state.mode !== 'shift'; }
  var state = { mode: 'owner', data: null, screen: 'main', sending: false, cat: 'all', query: '', draft: null, mb: false,
    offline: typeof navigator !== 'undefined' && navigator.onLine === false, fromCache: false, fieldError: null };
  var SCREENS_EARLY = {};

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
  function icon(name, cls) { return el('i', { class: 'ti ti-' + name + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }); }
  function catIcon(category) { return el('span', { class: 'ico', 'aria-hidden': 'true' }, [icon(CAT_ICON[category] || 'flower')]); }
  /** Рисунок позиции: цветы — по названию (роза, тюльпан, пион, ранункулюс), зелень — эвкалипт, остальное — значок. */
  function itemArt(c) {
    var n = String(c.name || '').toLowerCase();
    var art = null;
    if (c.category === 'greens') art = 'eucalyptus';
    else if (c.category === 'flowers') art = /роз/.test(n) ? 'rose' : /тюльпан/.test(n) ? 'tulip' : /пион/.test(n) ? 'peony' : 'ranunculus';
    if (!art) return catIcon(c.category);
    return el('span', { class: 'ico ico--art', 'aria-hidden': 'true' }, [el('img', { src: 'img/flowers/' + art + '.svg', width: '34', height: '34', alt: '' })]);
  }
  function firstName(name) { return String(name || '').replace(/\s*\(.*\)\s*$/, ''); }
  function greeting() {
    var h = new Date(Date.now() + 5 * 3600000).getUTCHours(); // время Алматы
    return h >= 5 && h < 12 ? 'Доброе утро' : h < 18 && h >= 12 ? 'Добрый день' : 'Добрый вечер';
  }
  /** Пустое состояние: рисунок, заголовок, пояснение, необязательная кнопка. */
  function emptyState(titleText, text, action) {
    // Ранункулюс — фирменный цветок кассы (img/ranunculus.svg, тот же, что на аватаре бота).
    var pic = el('div', { class: 'empty__pic' }, [el('img', { src: 'img/ranunculus.svg', width: '112', height: '112', alt: '' })]);
    return el('div', { class: 'card empty' }, [
      pic,
      el('div', { class: 'empty__title script', text: titleText }),
      text ? el('div', { class: 'muted', text: text }) : null,
      action ? el('button', { class: 'btn btn--primary', onclick: action.onclick }, [action.label]) : null
    ]);
  }

  /** Скелетон: серые «пустые карточки», пока данные загружаются. */
  function skeleton(kind) {
    var line = function (w) { return el('div', { class: 'sk sk--line', style: 'width:' + w }); };
    var card = function () { return el('div', { class: 'card sk-card' }, [line('40%'), el('div', { class: 'sk sk--big' }), line('60%')]); };
    var nodes = [el('div', { class: 'sk sk--title' })];
    if (kind === 'list') {
      for (var i = 0; i < 5; i++) nodes.push(el('div', { class: 'card sk-card sk-row' }, [el('div', { class: 'sk sk--ico' }), el('div', { style: 'flex:1' }, [line('70%'), line('45%')])]));
    } else {
      nodes.push(el('div', { class: 'grid2' }, [card(), card(), card(), card()]));
      nodes.push(el('div', { class: 'sk sk--btn' }));
    }
    return el('div', { class: 'sk-wrap', 'aria-busy': 'true', 'aria-label': 'Загрузка' }, nodes);
  }

  /** Цифры «набегают» от нуля при входе на экран. */
  function countUpAll(root) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    root.querySelectorAll('[data-count]').forEach(function (node) {
      var target = Number(node.getAttribute('data-count'));
      var isMoney = node.getAttribute('data-money') === '1';
      if (!isFinite(target) || target === 0) return;
      var t0 = null;
      var dur = 700;
      function step(t) {
        if (t0 === null) t0 = t;
        var k = Math.min(1, (t - t0) / dur);
        var v = Math.round(target * (1 - Math.pow(1 - k, 3)));
        node.textContent = isMoney ? money(v) : String(v);
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }
  function numEl(value, isMoney, cls) {
    return el('div', { class: 'big num' + (cls ? ' ' + cls : ''), 'data-count': String(value), 'data-money': isMoney ? '1' : '0',
      text: isMoney ? money(value) : String(value) });
  }

  /** Праздничные лепестки — когда касса сошлась до тенге. */
  function petalBurst() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var box = el('div', { class: 'burst', 'aria-hidden': 'true' });
    for (var i = 0; i < 26; i++) {
      var p = el('span', { class: 'burst__p' });
      var a = Math.random() * Math.PI * 2;
      var d = 120 + Math.random() * 160;
      p.style.setProperty('--x', Math.round(Math.cos(a) * d) + 'px');
      p.style.setProperty('--y', Math.round(Math.sin(a) * d - 80) + 'px');
      p.style.setProperty('--r', Math.round(Math.random() * 540 - 270) + 'deg');
      p.style.animationDelay = Math.round(Math.random() * 120) + 'ms';
      if (i % 3 === 0) p.style.background = '#fcd6e2';
      if (i % 5 === 0) p.style.background = '#9fe8c0';
      box.appendChild(p);
    }
    document.body.appendChild(box);
    setTimeout(function () { box.remove(); }, 1800);
  }

  /**
   * Клавиатура кассы: крупные клавиши, быстрые суммы, «Готово». Открывается поверх экрана снизу.
   * opts: { title, value, quick: [суммы], add: true — быстрые суммы прибавляются, иначе заменяют; onDone(value) }
   */
  function keypad(opts) {
    var val = String(opts.value == null ? '' : opts.value).replace(/\D/g, '');
    var sheet = el('div', { class: 'kp', role: 'dialog', 'aria-label': opts.title || 'Ввод суммы' });
    var shown = el('div', { class: 'kp__val num' });
    var hint = el('div', { class: 'kp__hint muted' });
    function draw() {
      shown.textContent = val ? money(Number(val)) : '0 ₸';
      hint.textContent = opts.hint ? opts.hint(val ? Number(val) : 0) : '';
    }
    function press(k) {
      haptic('light');
      if (k === '⌫') val = val.slice(0, -1);
      else if (k === 'C') val = '';
      else if (val.length < 9) val = (val === '0' ? '' : val) + k;
      draw();
    }
    function close(ok) {
      sheet.classList.add('kp--out');
      setTimeout(function () { sheet.remove(); }, 180);
      if (ok) opts.onDone(val === '' ? '' : String(Number(val)));
    }
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(function (k) {
      return el('button', { class: 'kp__key' + (k === 'C' || k === '⌫' ? ' kp__key--fn' : ''), 'aria-label': k === '⌫' ? 'Стереть' : k === 'C' ? 'Очистить' : k,
        onclick: function () { press(k); } }, [k]);
    });
    var quick = (opts.quick || []).map(function (q) {
      return el('button', { class: 'chip', onclick: function () {
        haptic('light');
        val = String(opts.add ? (Number(val) || 0) + q : q);
        draw();
      } }, [(opts.add ? '+' : '') + money(q)]);
    });
    sheet.appendChild(el('div', { class: 'kp__panel' }, [
      el('div', { class: 'sum' }, [el('div', { class: 'muted', text: opts.title || 'Сумма' }),
        el('button', { class: 'kp__x', 'aria-label': 'Закрыть', onclick: function () { close(false); } }, [icon('x')])]),
      shown, hint,
      quick.length ? el('div', { class: 'chips' }, quick) : null,
      el('div', { class: 'kp__grid' }, keys),
      el('button', { class: 'btn btn--primary btn--action', onclick: function () { close(true); } }, [icon('check'), 'Готово'])
    ]));
    sheet.addEventListener('click', function (e) { if (e.target === sheet) close(false); });
    document.body.appendChild(sheet);
    draw();
  }

  /** Поле суммы, которое открывает клавиатуру кассы вместо системной. */
  function amountField(label, value, opts) {
    var btn = el('button', { class: 'input num amount', type: 'button' }, [value ? money(Number(value)) : el('span', { class: 'muted', text: opts.placeholder || 'нажмите, чтобы ввести' })]);
    btn.onclick = function () {
      keypad({ title: label, value: value, quick: opts.quick, add: opts.add, hint: opts.hint, onDone: opts.onDone });
    };
    return el('div', { class: 'field' }, [el('label', { text: label }), btn]);
  }

  /** Экран «Принято / Проведено» на секунду. Возвращает элементы, чтобы дописать «Проведено», когда сервер подтвердит. */
  function showDone(amount, line, already, pending) {
    var title = el('div', { class: 'done__title script', text: already ? 'Уже было проведено' : pending ? 'Принято' : 'Проведено' });
    var note = el('div', { class: 'muted', text: pending ? 'отправляем…' : '' });
    var box = el('div', { class: 'done', role: 'status' }, [
      el('div', { class: 'done__check' }, [icon('check')]),
      title,
      el('div', { class: 'done__sum num', text: money(amount) }),
      line ? el('div', { class: 'muted', text: line }) : null,
      note
    ]);
    box.onclick = function () { box.remove(); };
    document.body.appendChild(box);
    setTimeout(function () { box.classList.add('done--out'); }, 1300);
    setTimeout(function () { box.remove(); }, 1600);
    return { title: title, note: note };
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
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (kind === 'light' || kind === 'heavy') tg.HapticFeedback.impactOccurred(kind);
      else tg.HapticFeedback.notificationOccurred(kind);
    } catch (e) { /* не важно */ }
  }
  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
    return null;
  }

  // ---------- картинки для пересылки: чек клиенту и карточка дня ----------

  function loadImg(src) {
    return new Promise(function (ok, fail) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = fail; i.src = src; });
  }
  function rrect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  var SCRIPT = 'italic 600 {px}px "Cormorant Garamond", Georgia, serif';
  var SANS = '{w} {px}px Manrope, Arial, sans-serif';
  function font(tpl, px, w) { return tpl.replace('{px}', px).replace('{w}', w || 600); }

  /** Фон и шапка в фирменном стиле. Возвращает canvas и контекст. */
  function brandCanvas(h, shopName, logo) {
    var c = document.createElement('canvas');
    c.width = 1080; c.height = h;
    var g = c.getContext('2d');
    var bg = g.createLinearGradient(0, 0, 1080, h);
    bg.addColorStop(0, '#163940'); bg.addColorStop(.55, '#24545d'); bg.addColorStop(1, '#4f8790');
    g.fillStyle = bg; g.fillRect(0, 0, 1080, h);
    [[960, 140, 360, 'rgba(247,168,196,.95)'], [60, h - 80, 460, 'rgba(242,182,201,.9)'], [1040, h * 0.62, 220, 'rgba(252,214,226,.7)']].forEach(function (b) {
      var rg = g.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
      rg.addColorStop(0, b[3]); rg.addColorStop(.45, 'rgba(224,80,126,.45)'); rg.addColorStop(1, 'rgba(224,80,126,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 1080, h);
    });
    g.drawImage(logo, 64, 52, 132, 132);
    g.fillStyle = '#fff'; g.font = font(SCRIPT, 76); g.textBaseline = 'alphabetic';
    g.fillText(shopName, 214, 132);
    g.font = font(SANS, 22, 600); g.globalAlpha = .85;
    g.fillText('Ц В Е Т О Ч Н А Я   К А С С А', 218, 172); g.globalAlpha = 1;
    return { c: c, g: g };
  }
  function glass(g, x, y, w, h) {
    rrect(g, x, y, w, h, 44);
    g.fillStyle = 'rgba(18,48,54,.38)'; g.fill();
    g.fillStyle = 'rgba(255,255,255,.14)'; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#fff'; // текст после стекла — снова белый
  }
  function fit(g, text, maxW) {
    var t = String(text);
    while (t.length > 3 && g.measureText(t).width > maxW) t = t.slice(0, -2);
    return t === String(text) ? t : t.slice(0, -1) + '…';
  }
  function ready() {
    var f = document.fonts;
    return Promise.all([f ? f.load(font(SCRIPT, 60)) : 0, f ? f.load(font(SANS, 40, 700)) : 0, f ? f.load(font(SANS, 30, 500)) : 0,
      loadImg('img/ranunculus.svg')]).then(function (x) { return x[3]; });
  }

  /** Чек для покупателя (не фискальный). */
  function drawReceipt(sale) {
    return ready().then(function (logo) {
      var lines = sale.items.slice(0, 8);
      var h = 1350;
      var k = brandCanvas(h, sale.shop, logo);
      var g = k.g;
      glass(g, 64, 230, 952, 1000);
      g.fillStyle = '#fff'; g.font = font(SCRIPT, 72); g.fillText('Спасибо за покупку!', 112, 340);
      g.font = font(SANS, 30, 500); g.globalAlpha = .85; g.fillText(sale.when + (sale.type === 'bouquet' ? ' · букет' : ''), 116, 392); g.globalAlpha = 1;
      var y = 470;
      g.font = font(SANS, 36, 600);
      lines.forEach(function (l) {
        g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(fit(g, l.name, 720), 116, y);
        g.textAlign = 'right'; g.fillStyle = 'rgba(255,255,255,.85)'; g.fillText('× ' + l.qty, 964, y);
        y += 58;
      });
      if (sale.items.length > lines.length) { g.textAlign = 'left'; g.fillText('и ещё ' + (sale.items.length - lines.length) + ' поз.', 116, y); y += 58; }
      g.textAlign = 'left';
      g.strokeStyle = 'rgba(255,255,255,.3)'; g.setLineDash([10, 10]); g.beginPath(); g.moveTo(116, y); g.lineTo(964, y); g.stroke(); g.setLineDash([]);
      y += 64;
      g.font = font(SANS, 32, 500); g.fillStyle = 'rgba(255,255,255,.85)';
      if (sale.discount) { g.fillText('Скидка', 116, y); g.textAlign = 'right'; g.fillText('− ' + money(sale.discount), 964, y); g.textAlign = 'left'; y += 56; }
      g.fillStyle = '#fff'; g.font = font(SANS, 40, 700); g.fillText('Итого', 116, y + 40);
      g.textAlign = 'right'; g.font = font(SANS, 92, 700); g.fillText(money(sale.total), 964, y + 50); g.textAlign = 'left';
      y += 120;
      g.font = font(SANS, 32, 500); g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillText('Оплата: ' + sale.how, 116, y);
      g.font = font(SCRIPT, 56); g.fillStyle = '#fcd6e2'; g.fillText('Ждём вас снова!', 116, 1150);
      g.font = font(SANS, 22, 500); g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText('Это не кассовый чек — фискальный чек выдаёт касса магазина.', 116, 1300);
      g.drawImage(logo, 840, 1040, 150, 150);
      return k.c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
  }

  /** Карточка дня для владелицы. */
  function drawDayCard(day, shop) {
    return Promise.all([ready(), day.top_item ? loadImg('img/flowers/' + artName(day.top_item) + '.svg').catch(function () { return null; }) : null]).then(function (x) {
      var logo = x[0], topArt = x[1];
      var k = brandCanvas(1350, shop, logo);
      var g = k.g;
      var d = day.date.split('-').reverse().join('.');
      g.fillStyle = '#fff'; g.font = font(SCRIPT, 84); g.fillText('Вчера, ' + d.slice(0, 5), 96, 330);
      glass(g, 64, 380, 952, 330);
      g.font = font(SANS, 34, 600); g.globalAlpha = .85; g.fillText('Выручка', 116, 460); g.globalAlpha = 1;
      g.font = font(SANS, 132, 700); g.fillText(money(day.revenue), 112, 600);
      g.font = font(SANS, 32, 500); g.globalAlpha = .85; g.fillText('чеков ' + day.receipts + ' · средний чек ' + money(day.avg_check), 116, 670); g.globalAlpha = 1;
      glass(g, 64, 740, 952, 150);
      var clean = day.all_closed && day.cash_diff === 0;
      g.font = font(SANS, 44, 700); g.fillStyle = clean ? '#9fe8c0' : '#ffd27a';
      g.fillText(!day.all_closed ? 'Смена не закрыта' : clean ? '✓ Касса сошлась до тенге' : 'Расхождение кассы ' + money(day.cash_diff), 116, 832);
      if (day.top_item) {
        glass(g, 64, 920, 952, 230);
        if (topArt) g.drawImage(topArt, 100, 950, 170, 170);
        g.fillStyle = '#fff'; g.font = font(SANS, 30, 600); g.globalAlpha = .85; g.fillText('Лучшая позиция дня', 300, 1010); g.globalAlpha = 1;
        g.font = font(SCRIPT, 64); g.fillText(fit(g, day.top_item.name, 680), 300, 1080);
        g.font = font(SANS, 30, 500); g.fillText(day.top_item.qty + ' шт', 300, 1126);
      }
      g.font = font(SCRIPT, 54); g.fillStyle = '#fcd6e2'; g.fillText('Хорошего дня!', 96, 1260);
      return k.c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
  }
  function artName(c) {
    var n = String(c.name || '').toLowerCase();
    if (c.category === 'greens') return 'eucalyptus';
    return /роз/.test(n) ? 'rose' : /тюльпан/.test(n) ? 'tulip' : /пион/.test(n) ? 'peony' : 'ranunculus';
  }

  /** Нарисовать и прислать себе в чат с ботом. */
  function shareImage(draw, caption, okText) {
    toast('Рисуем картинку…');
    return draw().then(function (b64) { return api({ action: 'send_image', image: b64, caption: caption }); })
      .then(function () { haptic('success'); toast(okText); })
      .catch(function (e) { haptic('error'); toast(e && e.message ? e.message : 'Не получилось отправить картинку', true); });
  }

  // ---------- графики ----------

  var SVGNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    return e;
  }
  /** Плавная линия через точки (Catmull-Rom → кривые Безье). */
  function smoothPath(pts) {
    if (!pts.length) return '';
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      var c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ' ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d;
  }
  function shortMoney(n) {
    var a = Math.abs(n), sign = n < 0 ? '−' : '';
    return sign + (a >= 1000000 ? (Math.round(a / 100000) / 10) + 'м' : a >= 1000 ? Math.round(a / 1000) + 'к' : String(a));
  }

  /** График «Выручка / Прибыль» по дням с подсказкой при касании. */
  function lineChart(days) {
    var W = 320, H = 170, L = 34, R = 8, T = 12, B = 22;
    var rev = days.map(function (x) { return x.revenue; });
    var pro = days.map(function (x) { return x.profit; });
    var max = Math.max.apply(null, rev.concat(pro).concat([1]));
    var min = Math.min.apply(null, pro.concat([0]));
    var X = function (i) { return L + (days.length > 1 ? i * (W - L - R) / (days.length - 1) : (W - L - R) / 2); };
    var Y = function (v) { return T + (max - v) * (H - T - B) / (max - min || 1); };
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img',
      'aria-label': 'Выручка и прибыль по дням. Всего выручка ' + money(rev.reduce(function (a, v) { return a + v; }, 0)) });
    var defs = svgEl('defs');
    var gr = svgEl('linearGradient', { id: 'revFill', x1: 0, x2: 0, y1: 0, y2: 1 });
    gr.appendChild(svgEl('stop', { offset: 0, 'stop-color': '#f07ca0', 'stop-opacity': .45 }));
    gr.appendChild(svgEl('stop', { offset: 1, 'stop-color': '#f07ca0', 'stop-opacity': 0 }));
    defs.appendChild(gr); svg.appendChild(defs);
    [max, (max + min) / 2, min].forEach(function (v) {
      svg.appendChild(svgEl('line', { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: 'rgba(255,255,255,.15)', 'stroke-dasharray': '3 4' }));
      var t = svgEl('text', { x: L - 6, y: Y(v) + 4, 'text-anchor': 'end', fill: 'rgba(255,255,255,.75)', 'font-size': 10 });
      t.textContent = shortMoney(Math.round(v)); svg.appendChild(t);
    });
    var rp = rev.map(function (v, i) { return [X(i), Y(v)]; });
    var pp = pro.map(function (v, i) { return [X(i), Y(v)]; });
    svg.appendChild(svgEl('path', { d: smoothPath(rp) + ' L' + X(days.length - 1) + ' ' + Y(min) + ' L' + X(0) + ' ' + Y(min) + 'Z', fill: 'url(#revFill)' }));
    var line1 = svgEl('path', { d: smoothPath(rp), fill: 'none', stroke: '#f07ca0', 'stroke-width': 2.6, 'stroke-linecap': 'round', class: 'draw' });
    var line2 = svgEl('path', { d: smoothPath(pp), fill: 'none', stroke: '#7fd0e0', 'stroke-width': 2, 'stroke-linecap': 'round', class: 'draw' });
    svg.appendChild(line1); svg.appendChild(line2);
    var step = Math.max(1, Math.ceil(days.length / 7));
    days.forEach(function (x, i) {
      if (i % step && i !== days.length - 1) return;
      var t = svgEl('text', { x: X(i), y: H - 6, 'text-anchor': 'middle', fill: 'rgba(255,255,255,.75)', 'font-size': 10 });
      t.textContent = x.date.slice(8, 10) + '.' + x.date.slice(5, 7); svg.appendChild(t);
    });
    var guide = svgEl('line', { y1: T, y2: H - B, stroke: 'rgba(255,255,255,.5)', 'stroke-width': 1, visibility: 'hidden' });
    var dot1 = svgEl('circle', { r: 5, fill: '#fff', stroke: '#f07ca0', 'stroke-width': 2.5, visibility: 'hidden' });
    var dot2 = svgEl('circle', { r: 4, fill: '#fff', stroke: '#7fd0e0', 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(guide); svg.appendChild(dot1); svg.appendChild(dot2);
    var tip = el('div', { class: 'tip', hidden: true });
    var box = el('div', { class: 'chart' }, [svg, tip]);
    function show(clientX) {
      var rect = svg.getBoundingClientRect();
      var x = (clientX - rect.left) * W / rect.width;
      var i = Math.max(0, Math.min(days.length - 1, Math.round((x - L) / ((W - L - R) / Math.max(1, days.length - 1)))));
      [guide].forEach(function (g) { g.setAttribute('x1', X(i)); g.setAttribute('x2', X(i)); g.setAttribute('visibility', 'visible'); });
      dot1.setAttribute('cx', X(i)); dot1.setAttribute('cy', Y(rev[i])); dot1.setAttribute('visibility', 'visible');
      dot2.setAttribute('cx', X(i)); dot2.setAttribute('cy', Y(pro[i])); dot2.setAttribute('visibility', 'visible');
      tip.replaceChildren(el('div', { class: 'muted', text: days[i].date.split('-').reverse().join('.') }),
        el('div', { class: 'num' }, [el('span', { style: 'color:#f07ca0', text: '● ' }), money(rev[i])]),
        el('div', { class: 'num' }, [el('span', { style: 'color:#7fd0e0', text: '● ' }), money(pro[i])]));
      tip.hidden = false;
      var px = X(i) / W * rect.width;
      tip.style.left = Math.max(0, Math.min(rect.width - 130, px - 65)) + 'px';
      haptic('light');
    }
    svg.addEventListener('pointerdown', function (e) { show(e.clientX); });
    svg.addEventListener('pointermove', function (e) { if (e.buttons || e.pointerType === 'mouse') show(e.clientX); });
    return box;
  }

  /** Сравнение с прошлым периодом: «↑ 12%», «↓ 5%», «—». */
  function delta(cur, prev) {
    if (!prev) return el('span', { class: 'delta', text: cur ? 'новое' : '—' });
    var pct = Math.round((cur - prev) / Math.abs(prev) * 100);
    return el('span', { class: 'delta ' + (pct >= 0 ? 'delta--up' : 'delta--down'), text: (pct >= 0 ? '↑ ' : '↓ ') + Math.abs(pct) + '%' });
  }

  /** Изменение суммы в тенге (для прибыли: проценты от отрицательного числа сбивают с толку). */
  function deltaMoney(cur, prev) {
    if (prev === undefined || prev === null) return el('span', { class: 'delta', text: '—' });
    var diff = cur - prev;
    if (diff === 0) return el('span', { class: 'delta', text: 'без изменений' });
    return el('span', { class: 'delta ' + (diff > 0 ? 'delta--up' : 'delta--down'), text: (diff > 0 ? '↑ +' : '↓ −') + money(Math.abs(diff)) });
  }

  /** Кольцевая диаграмма: части с цветами, в центре — итог. */
  function donut(parts, centerTop, centerBottom) {
    var total = parts.reduce(function (a, x) { return a + x.value; }, 0);
    var size = 132, rr = 52, C = 2 * Math.PI * rr;
    var svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size, role: 'img',
      'aria-label': parts.map(function (x) { return x.label + ' ' + money(x.value); }).join(', ') });
    svg.appendChild(svgEl('circle', { cx: 66, cy: 66, r: rr, fill: 'none', stroke: 'rgba(255,255,255,.12)', 'stroke-width': 16 }));
    var off = 0;
    parts.forEach(function (x) {
      if (!x.value || !total) return;
      var len = x.value / total * C;
      svg.appendChild(svgEl('circle', { cx: 66, cy: 66, r: rr, fill: 'none', stroke: x.color, 'stroke-width': 16,
        'stroke-dasharray': Math.max(0, len - 2) + ' ' + (C - Math.max(0, len - 2)), 'stroke-dashoffset': -off, transform: 'rotate(-90 66 66)', 'stroke-linecap': 'butt', class: 'ring' }));
      off += len;
    });
    var t1 = svgEl('text', { x: 66, y: 64, 'text-anchor': 'middle', fill: '#fff', 'font-size': 17, 'font-weight': 700 }); t1.textContent = centerTop;
    var t2 = svgEl('text', { x: 66, y: 82, 'text-anchor': 'middle', fill: 'rgba(255,255,255,.75)', 'font-size': 11 }); t2.textContent = centerBottom;
    svg.appendChild(t1); svg.appendChild(t2);
    var legend = el('div', { class: 'legend' }, parts.filter(function (x) { return x.value; }).map(function (x) {
      return el('div', { class: 'legend__row' }, [el('span', { class: 'legend__dot', style: 'background:' + x.color }), el('span', { text: x.label }),
        el('b', { class: 'num', text: money(x.value) + (total ? ' · ' + Math.round(x.value / total * 100) + '%' : '') })]);
    }));
    return el('div', { class: 'donut' }, [svg, legend]);
  }

  // ---------- сервер ----------

  // ---------- связь: запросы с тайм-аутом ----------

  function netState(offline) { if (state.offline !== offline) { state.offline = offline; updateNet(); } }

  function api(body, timeoutMs) {
    body.initData = tg ? tg.initData : '';
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 25000) : null;
    return fetch(window.FLORA_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // простой запрос — без CORS-предзапроса
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) { return r.json(); }).then(function (res) {
      clearTimeout(timer);
      netState(false); // сервер ответил — связь есть, даже если ответ «нет»
      if (!res.ok) {
        var e = new Error(res.error && res.error.message || 'Ошибка');
        e.code = res.error && res.error.code;
        e.details = res.error && res.error.details;
        throw e;
      }
      return res.data;
    }, function (e) {
      clearTimeout(timer);
      netState(true); // не достучались: обрыв, тайм-аут или не-JSON ответ Google
      throw e;
    });
  }

  // ---------- данные кассы: кэш на телефоне ----------

  function uid() { try { return String(tg.initDataUnsafe.user.id); } catch (e) { return ''; } }
  function readCache() {
    var c = store(CACHE_KEY);
    return c && c.uid === uid() && c.data && c.data.me && Date.now() - c.at < 36 * 3600000 ? c : null;
  }
  function writeCache(d) { if (d && d.me) store(CACHE_KEY, { uid: uid(), at: Date.now(), data: d }); }
  /** Данные пришли с сервера (fromServer) или из кэша. В кэш кладём «чистые» данные — до вычета очереди. */
  function setData(d, fromServer) {
    if (fromServer) { writeCache(d); state.fromCache = false; state.cacheAt = Date.now(); }
    state.data = d;
    applyQueue();
  }

  // ---------- очередь продаж ----------

  function myQ() { var q = store(QUEUE_KEY); return (Array.isArray(q) ? q : []).filter(function (i) { return i.uid === uid(); }); }
  function saveMyQ(list) {
    var q = store(QUEUE_KEY);
    var others = (Array.isArray(q) ? q : []).filter(function (i) { return i.uid !== uid(); });
    store(QUEUE_KEY, others.concat(list).length ? others.concat(list) : null);
  }
  function pendingQ() { return myQ().filter(function (i) { return i.status !== 'failed'; }); }
  function failedQ() { return myQ().filter(function (i) { return i.status === 'failed'; }); }
  function queueItemTotals(list) {
    var by = {};
    list.forEach(function (i) { i.payload.items.forEach(function (x) { by[x.item_id] = (by[x.item_id] || 0) + x.qty; }); });
    return by;
  }
  /** Остатки и выручка на экране с учётом продаж, которые ещё в очереди. */
  function applyQueue() { applyList(pendingQ()); }
  function applyList(list) {
    if (!state.data || !state.data.catalog || !list.length) return;
    var by = queueItemTotals(list);
    state.data.catalog.forEach(function (c) { if (by[c.item_id]) c.stock = Math.max(0, c.stock - by[c.item_id]); });
    if (state.data.shift) {
      state.data.shift.revenue += list.reduce(function (a, i) { return a + i.total; }, 0);
      state.data.shift.receipts_count += list.length;
    }
  }

  /** Отказ сервера: вернуть на экран остаток и выручку, которые мы списали заранее. */
  function unapplyList(list) {
    if (!state.data || !state.data.catalog || !list.length) return;
    var by = queueItemTotals(list);
    state.data.catalog.forEach(function (c) { if (by[c.item_id]) c.stock += by[c.item_id]; });
    if (state.data.shift) {
      state.data.shift.revenue -= list.reduce(function (a, i) { return a + i.total; }, 0);
      state.data.shift.receipts_count -= list.length;
    }
  }

  var RETRY = [3000, 6000, 15000, 30000];
  var pumping = false, retryStep = 0, retryTimer = null;
  var FRIENDLY = {
    NO_OPEN_SHIFT: 'Смена закрыта. Откройте смену в чате бота и оформите продажу заново.',
    SHIFT_CHANGED: null, // у сервера уже понятный текст
    NOT_ON_SHIFT: 'Вы не работаете в открытой смене.',
    DISCOUNT_TOO_BIG: 'Скидка больше цены — уменьшите скидку.',
    ZERO_TOTAL: 'Итого получилось 0 ₸. Подарок оформляется как «Ещё → Брак → Подарок».',
    BALANCE_MISMATCH: 'Сумма оплат не сходится с итогом — проверьте способ оплаты.',
    AUTH: 'Вход в кассу устарел — закройте её и откройте снова из бота.',
    FORBIDDEN: 'Доступ отключён владелицей.'
  };
  function nameOf(id) {
    var c = state.data && state.data.catalog ? state.data.catalog.filter(function (x) { return x.item_id === id; })[0] : null;
    return c ? c.name : id;
  }
  function friendly(e) {
    if (e.code === 'NOT_ENOUGH_STOCK' && e.details) {
      return 'Не хватает на складе: ' + e.details.map(function (x) { return nameOf(x.item_id) + ' — есть ' + x.have + ', нужно ' + x.need; }).join('; ');
    }
    return FRIENDLY[e.code] || e.message || 'Не получилось провести';
  }

  /** Отправка очереди: строго по одной и по порядку; обрыв связи — повтор с теми же номерами операций. */
  function pump() {
    if (pumping) return;
    var q = myQ();
    var item = q.filter(function (i) { return i.status === 'pending' || i.status === 'sending'; })[0];
    if (!item || state.authExpired) { updateNet(); return; }
    pumping = true;
    clearTimeout(retryTimer);
    item.status = 'sending';
    saveMyQ(q);
    updateNet();
    api({ action: 'post', kind: item.kind, op_id: item.op_id, payload: item.payload }, 25000)
      .then(function (res) {
        pumping = false;
        retryStep = 0;
        saveMyQ(myQ().filter(function (i) { return i.id !== item.id; }));
        setData(res.state, true);
        if (state.doneBox && state.doneBox.id === item.id && document.body.contains(state.doneBox.title)) {
          state.doneBox.title.textContent = 'Проведено';
          state.doneBox.note.textContent = '';
        }
        if (['main', 'stock', 'preorders', 'more'].indexOf(state.screen) >= 0) render(); else updateNet();
        pump();
      })
      .catch(function (e) {
        pumping = false;
        var q2 = myQ();
        var it = q2.filter(function (i) { return i.id === item.id; })[0];
        if (!it) { pump(); return; }
        if (e.code === 'AUTH') { it.status = 'pending'; saveMyQ(q2); state.authExpired = true; updateNet(); return; }
        if (!e.code || e.code === 'BUSY' || e.code === 'SERVER') { // повторим позже, продажа не потеряна
          it.status = 'pending'; saveMyQ(q2); updateNet();
          retryTimer = setTimeout(pump, RETRY[Math.min(retryStep++, RETRY.length - 1)]);
          return;
        }
        if (e.code === 'OP_FAILED' && (it.tries || 0) < 2) { // ночная проверка отменила зависшую операцию — оформляем под новым номером
          it.op_id = uuid(); it.tries = (it.tries || 0) + 1; it.status = 'pending'; saveMyQ(q2); pump(); return;
        }
        it.status = 'failed'; it.code = e.code; it.error = friendly(e); it.details = e.details || null;
        saveMyQ(q2);
        unapplyList([it]);
        haptic('error');
        toast('Продажа на ' + money(it.total) + ' не проведена: ' + it.error, true);
        if (['main', 'stock', 'preorders', 'more'].indexOf(state.screen) >= 0) render(); else updateNet();
        pump();
      });
  }

  /** Полоска вверху: нет связи / отправляем / не проведено. */
  function updateNet() {
    var box = document.getElementById('net');
    if (!box) return;
    var failed = failedQ().length, pend = pendingQ().length;
    var text = '', cls = '';
    if (state.authExpired) { cls = 'net--bad'; text = 'Вход в кассу устарел — закройте её и откройте снова из бота. Продаж в очереди: ' + pend + '.'; }
    else if (failed) { cls = 'net--bad'; text = '⚠️ Не проведено продаж: ' + failed + ' — нажмите, чтобы разобраться'; }
    else if (pend && state.offline) { cls = 'net--off'; text = 'Нет связи — продаж сохранено: ' + pend + '. Отправятся сами, когда появится сеть.'; }
    else if (pend) { cls = 'net--sync'; text = 'Отправляем продаж: ' + pend + '…'; }
    else if (state.offline && state.fromCache) { cls = 'net--off'; text = 'Нет связи — остатки на ' + new Date((state.cacheAt || Date.now()) + 5 * 3600000).toISOString().slice(11, 16) + '. Продажи сохранятся и отправятся сами.'; }
    else if (state.offline) { cls = 'net--off'; text = 'Нет связи. Продажи сохранятся на телефоне и отправятся сами.'; }
    else { box.hidden = true; return; }
    box.className = 'net ' + cls;
    box.textContent = text;
    box.hidden = false;
    box.onclick = function () { if (myQ().length) openScreen('queue'); };
  }

  /** Вернуть не проведённую продажу в корзину — исправить и провести заново. */
  function restoreToDraft(item) {
    var d = newDraft();
    d.type = item.kind;
    item.payload.items.forEach(function (x) { d.cart[x.item_id] = x.qty; });
    d.price = String(item.payload.price);
    var disc = item.payload.discount || { kind: 'none' };
    d.disc = disc.kind;
    d.discVal = disc.kind === 'pct' ? String(disc.value / 100).replace('.', ',') : disc.kind === 'amount' ? String(disc.value) : '';
    var pays = item.payload.payments || [];
    var dc = item.payload.debt_customer;
    if (dc) {
      d.pay = 'debt';
      d.cashPart = pays[0] ? String(pays[0].amount) : '';
      d.cust = dc.customer_id ? { id: dc.customer_id } : { name: dc.new_customer.name, note: dc.new_customer.note, confirm: !!dc.new_customer.confirm_new };
    } else if (pays.length === 2) {
      d.pay = 'mixed';
      d.cashPart = String(pays.filter(function (x) { return x.method === 'cash'; })[0].amount);
    } else d.pay = pays[0] ? pays[0].method : 'cash';
    saveMyQ(myQ().filter(function (i) { return i.id !== item.id; }));
    state.draft = d;
    saveDraft();
    state.shortage = null;
    if (item.code === 'NOT_ENOUGH_STOCK' && item.details) {
      state.shortage = {};
      item.details.forEach(function (x) { state.shortage[x.item_id] = { need: x.need, have: x.have }; });
    }
    var where = { DISCOUNT_TOO_BIG: 'discount', ZERO_TOTAL: 'discount', BALANCE_MISMATCH: 'pay', UNKNOWN_CUSTOMER: 'customer', SIMILAR_CUSTOMERS: 'customer', NOT_ENOUGH_STOCK: 'stock' }[item.code] || 'general';
    state.fieldError = { where: where, text: item.error, code: item.code, details: item.details };
    state.screen = 'sale';
    render();
  }

  // ---------- загрузка ----------

  function load() {
    var cached = readCache();
    if (cached) { // касса открывается сразу из кэша, свежие данные подтянутся следом
      setData(cached.data, false);
      state.fromCache = true;
      state.cacheAt = cached.at;
      render();
    }
    return api({ action: 'bootstrap' }).then(function (data) {
      setData(data, true);
      // Ссылка «Закрыть смену в кассе» из чата (передача смены) открывает сразу закрытие.
      if (ownerUI(data)) { if (state.screen === 'main') openScreen('owner_today'); prefetchOwner(); return; }
      if (location.hash === '#close' && data.shift && data.shift.on_shift) { history.replaceState(null, '', location.pathname); openClose(); return; }
      render();
      pump();
    })
      .catch(function (e) {
        if (cached && !e.code) { render(); pump(); return; } // нет связи, но есть данные на телефоне — работаем
        renderMessage(e.code ? e.message : 'Нет связи с сервером. Проверьте интернет и откройте кассу заново.');
      });
  }

  /** Тихо обновить данные, когда касса снова на экране (не трогаем экран продажи). */
  var lastRefresh = 0;
  function silentRefresh() {
    if (!state.data || Date.now() - lastRefresh < 45000 || !state.data.me || state.data.me.role !== 'florist') return;
    lastRefresh = Date.now();
    api({ action: 'bootstrap' }).then(function (data) {
      setData(data, true);
      if (['main', 'stock', 'preorders', 'more'].indexOf(state.screen) >= 0) render();
      pump();
    }).catch(function () { /* связи нет — остаёмся на том, что есть */ });
  }

  /** Экран «Очередь»: что ждёт отправки и что не проведено. */
  SCREENS_EARLY.queue = function () {
    backButton(true);
    mainButton(null);
    var q = myQ();
    var nodes = [el('h1', { class: 'h1', text: 'Очередь продаж' }),
      el('div', { class: 'muted', text: 'Продажи, которые ещё не приняты сервером. Ничего не потеряно: пока нет связи, они хранятся на телефоне и отправляются сами.' })];
    if (!q.length) nodes.push(emptyState('Очередь пуста', 'Все продажи проведены.'));
    q.forEach(function (i) {
      var parts = i.payload.items.map(function (x) { return nameOf(x.item_id) + ' ×' + x.qty; }).join(', ');
      var when = new Date(i.created + 5 * 3600000).toISOString().slice(11, 16);
      var card = el('div', { class: 'card' + (i.status === 'failed' ? ' card--note' : '') }, [
        el('div', { class: 'sum' }, [el('b', { text: (i.kind === 'bouquet' ? 'Букет' : 'Продажа') + ' · ' + when }), el('b', { class: 'num', text: money(i.total) })]),
        el('div', { class: 'muted', text: parts }),
        i.status === 'failed'
          ? el('div', { class: 'error', text: 'НЕ ПРОВЕДЕНА: ' + i.error + '. В кассу эта продажа не записана.' })
          : el('div', { class: 'muted', text: i.status === 'sending' ? 'Отправляется…' : state.offline ? 'Ждёт связи' : 'Ждёт отправки' })
      ]);
      if (i.status === 'failed') {
        card.appendChild(el('button', { class: 'btn btn--primary', onclick: function () { restoreToDraft(i); } }, [icon('edit'), 'Исправить и провести заново']));
        card.appendChild(el('button', { class: 'btn', onclick: function () {
          if (!window.confirm('Убрать эту продажу? Она не записана в кассу, деньги по ней учитывать не нужно.')) return;
          saveMyQ(myQ().filter(function (x) { return x.id !== i.id; }));
          render();
        } }, ['Убрать (в кассу не записана)']));
      } else {
        card.appendChild(el('button', { class: 'btn', onclick: function () { clearTimeout(retryTimer); retryStep = 0; pump(); toast('Пробуем отправить…'); } }, [icon('refresh'), 'Отправить сейчас']));
      }
      nodes.push(card);
    });
    app.replaceChildren.apply(app, nodes);
  };

  // ---------- черновик продажи (живёт на телефоне до «Проведено») ----------

  function newDraft() {
    return { op_id: uuid(), type: 'sale', cart: {}, price: null, disc: 'none', discVal: '', pay: 'cash', cashPart: '' };
  }
  function draft() {
    if (!state.draft) state.draft = store(DRAFT_KEY) || newDraft();
    return state.draft;
  }
  function saveDraft() { state.fieldError = null; store(DRAFT_KEY, state.draft); }

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
    if (!items.length) { out.error = 'Выберите позиции'; out.where = 'items'; return out; }
    if (!price) { out.error = 'Введите цену'; out.where = 'price'; return out; }
    var discount = d.disc === 'none' ? { kind: 'none' }
      : { kind: d.disc, value: d.disc === 'pct' ? Math.round((parseFloat(String(d.discVal).replace(',', '.')) || 0) * 100) : (intOf(d.discVal) || 0) };
    try {
      out.total = Calc.receiptTotal(price, discount).total;
    } catch (e) { out.error = e.message; out.where = 'discount'; return out; }
    var payments;
    var debtCustomer;
    if (d.pay === 'cash') payments = [{ method: 'cash', amount: out.total }];
    else if (d.pay === 'card') payments = [{ method: 'card', amount: out.total }];
    else if (d.pay === 'debt') {
      debtCustomer = customerRef(d.cust || {});
      if (!debtCustomer) { out.error = 'Выберите должника из списка или впишите имя'; out.where = 'customer'; return out; }
      var now = d.cashPart === '' || d.cashPart == null ? 0 : intOf(d.cashPart);
      if (now === null || now >= out.total) { out.error = 'Оплачено сейчас должно быть меньше итога — остальное уйдёт в долг'; out.where = 'pay'; return out; }
      payments = now ? [{ method: 'cash', amount: now }] : [];
    } else {
      var cash = intOf(d.cashPart);
      if (!cash || cash >= out.total) { out.error = 'Наличные — больше нуля и меньше итога, остальное будет безналом'; out.where = 'pay'; return out; }
      payments = [{ method: 'cash', amount: cash }, { method: 'card', amount: out.total - cash }];
    }
    out.payload = { items: items, price: price, discount: discount, payments: payments };
    if (debtCustomer) out.payload.debt_customer = debtCustomer;
    return out;
  }

  // ---------- главная кнопка Telegram ----------

  var mainHandler = null;
  function mainButton(text, enabled, onClick) {
    if (!tg) { state.mb = !!text; renderNav(); return; }
    var mb = tg.MainButton;
    if (mainHandler) mb.offClick(mainHandler);
    mainHandler = null;
    state.mb = !!text;
    renderNav();
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
  (function () {
    var logo = document.querySelector('.top');
    if (!logo) return;
    logo.setAttribute('role', 'button');
    logo.setAttribute('tabindex', '0');
    logo.setAttribute('aria-label', 'На главную');
    function home() {
      if (!state.data) return;
      if (ownerUI()) { if (state.screen !== 'owner_today') openScreen('owner_today'); return; }
      if (state.screen !== 'main') { state.screen = 'main'; render(); } // шапка — всегда «на главную»; шаг назад — кнопка «Назад»
    }
    logo.addEventListener('click', home);
    logo.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); home(); } });
  })();
  // ---------- «Назад»: на шаг, откуда пришли ----------
  // Вкладки нижнего меню — корни: переход на них обнуляет «след». Вложенные экраны запоминают, откуда на них пришли,
  // поэтому из «Ещё → Сотрудники → Анна» назад идём в «Сотрудники», а из «Склад → Принять товар» — в «Склад».
  var ROOT_SCREENS = { main: 1, stock: 1, preorders: 1, more: 1, owner_today: 1, owner_history: 1, owner_period: 1, owner_catalog: 1, owner_manage: 1, sale: 1, close: 1 };
  var BACK_LABEL = { main: 'Главная', stock: 'Склад', preorders: 'Заказы', more: 'Ещё', owner_today: 'Сегодня', owner_history: 'История',
    owner_period: 'Сводка', owner_catalog: 'Склад', owner_manage: 'Ещё', owner_team: 'Сотрудники', owner_preorders: 'Предзаказы',
    schedule: 'График смен', owner_debtors: 'Должники', owner_expenses: 'Расходы месяца' };
  var trail = [];
  var lastScreen = null;
  function trackNav() {
    var s = state.screen;
    if (s === lastScreen) return;
    var from = lastScreen;
    lastScreen = s;
    if (ROOT_SCREENS[s]) { trail = []; return; }
    var i = trail.indexOf(s);
    if (i >= 0) { trail = trail.slice(0, i); return; } // вернулись назад
    if (from) trail.push(from);
  }
  /** Куда ведёт «Назад» с текущего экрана; null — это вкладка, назад некуда. */
  function backTarget() {
    var s = state.screen;
    if (ROOT_SCREENS[s]) return null;
    var t = trail.length ? trail[trail.length - 1] : (ownerUI() ? OWNER_BACK[s] : FLORIST_BACK[s]) || NAV_OF[s];
    return t && t !== s ? t : null;
  }
  function renderBackBar() {
    var bar = document.getElementById('backbar');
    if (!bar) {
      bar = el('div', { id: 'backbar', class: 'backbar', hidden: true });
      app.parentNode.insertBefore(bar, app);
    }
    var t = state.data ? backTarget() : null;
    if (!t) { bar.hidden = true; bar.replaceChildren(); return; }
    var name = BACK_LABEL[t];
    bar.replaceChildren(el('button', { class: 'chip backbar__btn', type: 'button', 'aria-label': 'Назад' + (name ? ' в «' + name + '»' : ''),
      onclick: function () { goMain(); } }, [icon('chevron-left'), 'Назад' + (name ? ' · ' + name : '')]));
    bar.hidden = false;
  }

  function goMain() {
    var back = backTarget();
    if (back) { openScreen(back); return; }
    // Владелица возвращается в свои разделы, флорист — на главную кассы.
    if (ownerUI()) {
      openScreen(OWNER_BACK[state.screen] || (state.screen === 'owner_shift' ? 'owner_history' : state.screen === 'owner_manage' ? 'owner_today' : 'owner_today'));
      return;
    }
    state.screen = FLORIST_BACK[state.screen] || 'main'; render();
  }
  var FLORIST_BACK = { schedule: 'more', income: 'more', defect: 'more', refund: 'more', cashout: 'more', withdraw: 'more', repay: 'more', cancel: 'more' };

  // ---------- нижнее меню ----------

  var NAV_OF = {
    main: 'main', queue: 'main', stock: 'stock', preorders: 'preorders', more: 'more',
    cashout: 'more', withdraw: 'more', repay: 'more', cancel: 'more', open: 'main',
    owner_today: 'owner_today', owner_history: 'owner_history', owner_shift: 'owner_history',
    owner_period: 'owner_period', owner_debtors: 'owner_period',
    owner_manage: 'owner_manage', owner_catalog: 'owner_catalog', owner_item: 'owner_catalog', owner_item_new: 'owner_catalog',
    owner_team: 'owner_manage', owner_staff: 'owner_manage', owner_staff_new: 'owner_manage', owner_invite: 'owner_manage',
    owner_expenses: 'owner_manage', owner_settings: 'owner_manage', owner_preorders: 'owner_manage', owner_preorder: 'owner_manage',
    owner_start_stock: 'owner_manage', owner_start_debt: 'owner_manage', schedule: 'more', owner_day: 'owner_manage', owner_work: 'owner_manage', owner_import: 'owner_catalog', owner_typical: 'owner_catalog'
  };
  // Куда ведёт «Назад» на экранах управления.
  var OWNER_BACK = {
    owner_item: 'owner_catalog', owner_item_new: 'owner_catalog', owner_typical: 'owner_catalog', owner_debtors: 'owner_period',
    owner_team: 'owner_manage', owner_staff: 'owner_team', owner_staff_new: 'owner_team', owner_invite: 'owner_team',
    owner_expenses: 'owner_manage', owner_settings: 'owner_manage', owner_preorders: 'owner_manage', owner_preorder: 'owner_preorders',
    owner_start_stock: 'owner_manage', owner_start_debt: 'owner_manage', owner_day: 'schedule', schedule: 'owner_manage', owner_work: 'owner_manage', owner_import: 'owner_catalog'
  };
  function renderNav() {
    var nav = document.getElementById('nav');
    if (!nav) return;
    var d = state.data;
    var cur = NAV_OF[state.screen];
    var isOwner = ownerUI();
    if (isOwner && cur === 'more') cur = 'owner_manage';
    var onShift = d && d.shift && d.shift.on_shift;
    if (!d || !cur || state.mb || (!isOwner && !onShift)) { nav.hidden = true; return; }
    var item = function (key, ic, label) {
      return el('button', { class: 'nav__item', 'aria-current': cur === key ? 'page' : false,
        onclick: function () { if (key === 'main') { state.screen = 'main'; render(); } else openScreen(key); } }, [icon(ic), label]);
    };
    var items = isOwner
      ? [item('owner_today', 'home', 'Сегодня'), item('owner_history', 'history', 'История'),
        item('owner_period', 'chart-line', 'Сводка'), item('owner_catalog', 'box', 'Склад'), item('owner_manage', 'dots', 'Ещё')]
      : [item('main', 'home', 'Главная'), item('stock', 'box', 'Склад'),
        el('button', { class: 'nav__plus', 'aria-label': 'Новая продажа', onclick: function () { state.screen = 'sale'; render(); } }, [icon('plus')]),
        item('preorders', 'calendar-heart', 'Заказы'), item('more', 'dots', 'Ещё')];
    nav.replaceChildren.apply(nav, items);
    nav.hidden = false;
  }

  // ---------- экраны ----------

  function renderMessage(text) {
    mainButton(null);
    backButton(false);
    app.replaceChildren(el('div', { class: 'card card--note' }, [el('div', { text: text })]));
  }

  /** Перерисовка с сохранением курсора: поле, в котором печатают, не должно терять фокус (клавиатура на телефоне не закрывается). */
  function render() {
    var ae = document.activeElement;
    var idx = -1, ss = null, se = null;
    if (ae && app.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      idx = Array.prototype.indexOf.call(app.querySelectorAll('input,textarea'), ae);
      try { ss = ae.selectionStart; se = ae.selectionEnd; } catch (e) { /* у type=time/number выделения нет */ }
    }
    renderNow();
    if (idx >= 0) {
      var again = app.querySelectorAll('input,textarea')[idx];
      if (again && again !== document.activeElement) {
        again.focus();
        try { if (ss !== null) again.setSelectionRange(ss, se); } catch (e) { /* не страшно */ }
      }
    }
  }

  /** Кнопка в шапке для владелицы: «Я в смене» ↔ «Кабинет». */
  function renderModeSwitch() {
    var top = document.querySelector('.top');
    if (!top) return;
    var btn = document.getElementById('modeSwitch');
    var d = state.data;
    if (!d || d.me.role !== 'owner') { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = el('button', { id: 'modeSwitch', class: 'chip modeswitch', type: 'button' });
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var w = state.data.owner_work;
        if (state.mode === 'shift') { state.mode = 'owner'; openScreen('owner_today'); return; }
        if (!w || !w.works) { openScreen('owner_work'); return; }
        state.mode = 'shift'; state.screen = 'main'; render();
      });
      top.appendChild(btn);
    }
    btn.textContent = state.mode === 'shift' ? 'Кабинет' : 'Я в смене';
  }

  function renderNow() {
    if (!state.data) return;
    trackNav();
    if (state.screen === 'sale') renderSale();
    else if (state.screen === 'close') renderClose();
    else if (SCREENS[state.screen]) SCREENS[state.screen]();
    else renderMain();
    renderNav();
    renderBackBar();
    updateNet();
    renderModeSwitch();
    // Экран продажи — спокойный: без анимаций и чуть мельче шрифт.
    document.body.classList.toggle('on-sale', state.screen === 'sale');
    // Плавное появление — только при переходе на другой экран, не при каждом нажатии.
    if (state.screen === 'sale') { app.setAttribute('data-shown', 'sale'); app.classList.remove('enter'); }
    else if (app.getAttribute('data-shown') !== state.screen) {
      app.setAttribute('data-shown', state.screen);
      app.classList.remove('enter');
      void app.offsetWidth;
      app.classList.add('enter');
      countUpAll(app);
      // Появление — только при входе на экран: потом класс снимается, чтобы перерисовки не мигали.
      clearTimeout(render._t);
      render._t = setTimeout(function () { app.classList.remove('enter'); }, 900);
    }
  }

  function renderMain() {
    if (ownerUI()) { openScreen('owner_today'); return; }
    backButton(false);
    mainButton(null);
    var d = state.data;
    var s = d.shift;
    var nodes = [el('div', {}, [
      el('div', { class: 'hello', text: greeting() + ', ' + firstName(d.me.name) + '!' }),
      el('div', { class: 'muted', text: s ? 'Смена №' + s.shift_no + ' · с ' + String(s.opened_at).slice(11, 16) + (s.florists.length > 1 ? ' · ' + s.florists.map(firstName).join(' и ') : '') : 'Пусть день будет полон красоты' })
    ])];
    if (!s) {
      nodes.push(emptyState('Смена ещё не открыта', d.open_info ? 'Примите кассу и откройте смену — касса сразу оживёт.' : 'Смену открывает флорист.',
        d.open_info ? { label: 'Открыть смену', onclick: function () { openScreen('open'); } } : null));
    } else if (!s.on_shift) {
      nodes.push(el('div', { class: 'card card--note' }, [el('div', { text: 'Вы не работаете в этой смене.' })]));
    } else {
      if (d.next_shift) {
        nodes.push(el('button', { class: 'card', style: 'font:inherit;color:inherit;cursor:pointer;text-align:left;width:100%', onclick: function () { openScreen('schedule'); } }, [
          el('div', { class: 'muted', text: 'Ваша ближайшая смена' }),
          el('b', { text: dayLabel(d.next_shift.date) + (d.next_shift.with.length ? ' · вместе с ' + d.next_shift.with.join(' и ') : '') })]));
      }
      var today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
      var tomorrow = new Date(Date.now() + 29 * 3600000).toISOString().slice(0, 10);
      var orders = d.preorders.concat(d.reservations);
      var soon = orders.filter(function (o) { return o.pickup_date === today || o.pickup_date === tomorrow; }).length;
      var low = d.catalog.filter(function (c) { return c.stock < c.min; });
      nodes.push(el('div', { class: 'grid2' }, [
        el('div', { class: 'card card--accent' }, [icon('chart-line'), el('div', { class: 'muted', text: 'Выручка смены' }),
          numEl(s.revenue, true), el('div', { class: 'muted', text: 'чеков: ' + s.receipts_count })]),
        s.my_pay ? el('div', { class: 'card' }, [icon('wallet'), el('div', { class: 'muted', text: 'Мой заработок' }),
          numEl(s.my_pay.total, true),
          el('div', { class: 'muted num', text: money(s.my_pay.rate) + ' + ' + money(s.my_pay.pct) })]) : null,
        el('button', { class: 'card btn--tile', style: 'font:inherit;color:inherit;cursor:pointer', onclick: function () { openScreen('preorders'); } }, [
          icon('calendar-heart'), el('div', { class: 'muted', text: 'Предзаказы' }), el('div', { class: 'big num', text: String(orders.length) }),
          el('div', { class: 'muted', text: soon ? soon + ' на сегодня-завтра' : 'ближайших нет' })]),
        el('button', { class: 'card btn--tile', style: 'font:inherit;color:inherit;cursor:pointer', onclick: function () { openScreen('stock'); } }, [
          icon('alert-triangle', 'gold'), el('div', { class: 'muted', text: 'Заканчиваются' }), el('div', { class: 'big num', text: String(low.length) }),
          el('div', { class: 'muted', text: low.length ? firstName(low[0].name) + ' · ' + low[0].stock : 'всё в порядке' })])
      ]));
      if (state.lastSale) {
        var ls = state.lastSale;
        nodes.push(el('div', { class: 'card' }, [
          el('div', { class: 'sum' }, [el('span', { class: 'muted', text: 'Последняя продажа' }), el('b', { class: 'num', text: money(ls.total) })]),
          el('button', { class: 'btn', onclick: function () {
            shareImage(function () { return drawReceipt(ls); }, 'Чек для покупателя · ' + money(ls.total), 'Чек пришёл вам в чат с ботом — перешлите клиенту');
          } }, [icon('photo'), 'Чек клиенту картинкой'])
        ]));
      }
    }
    app.replaceChildren.apply(app, nodes);
  }

  /** «Ещё»: редкие действия смены. */
  SCREENS_EARLY.more = function () {
    backButton(false);
    mainButton(null);
    var go = function (screen) { return function () { openScreen(screen); }; };
    var head = function (t) { return el('div', { class: 'script', style: 'font-size:22px;margin-top:6px', text: t }); };
    app.replaceChildren(
      el('h1', { class: 'h1', text: 'Ещё' }),
      head('Чеки и деньги'),
      el('div', { class: 'grid2' }, [
        el('button', { class: 'btn btn--tile', onclick: go('refund') }, [icon('receipt-refund'), 'Возврат']),
        el('button', { class: 'btn btn--tile', onclick: go('cancel') }, [icon('receipt-off'), 'Отмена продажи']),
        el('button', { class: 'btn btn--tile', onclick: go('cashout') }, [icon('cash-banknote'), 'Расход']),
        el('button', { class: 'btn btn--tile', onclick: go('repay') }, [icon('coin'), 'Погашение долга']),
        el('button', { class: 'btn btn--tile btn--wide', onclick: go('withdraw') }, [icon('wallet'), 'Владелица забрала из кассы'])
      ]),
      head('Смена'),
      el('div', { class: 'grid2' }, [
        el('button', { class: 'btn btn--tile', onclick: go('schedule') }, [icon('calendar-event'), 'График смен']),
        el('button', { class: 'btn btn--tile', onclick: go('stock') }, [icon('truck-delivery'), 'Приход и брак'])
      ]),
      liteToggle(),
      el('div', { class: 'more-end' }, [
        el('button', { class: 'btn btn--close', onclick: function () { openClose(); } }, [icon('lock'), 'Закрыть смену'])
      ]));
  };

  function renderSale() {
    backButton(true);
    var d = draft();
    var cats = ['all'].concat(Object.keys(CATS).filter(function (k) {
      return state.data.catalog.some(function (c) { return c.category === k; });
    }));
    var hits = state.data.hits || [];
    // Пока флорист сам не выбрал раздел, открываем «Частые» — если уже есть что показать.
    if (!state.catChosen && hits.length && state.cat === 'all') state.cat = 'hot';
    if (state.cat === 'hot' && !hits.length) state.cat = 'all';
    if (hits.length) cats.splice(1, 0, 'hot');
    function visible(c, qq) {
      if (qq) return c.name.toLowerCase().indexOf(qq) >= 0; // поиск идёт по всему каталогу
      return state.cat === 'all' || (state.cat === 'hot' ? hits.indexOf(c.item_id) >= 0 : c.category === state.cat);
    }

    var typeChips = el('div', { class: 'chips' }, [['sale', 'Продажа'], ['bouquet', 'Букет']].map(function (t) {
      return el('button', { class: 'chip', 'aria-pressed': String(d.type === t[0]), onclick: function () { d.type = t[0]; saveDraft(); renderSale(); } }, [t[1]]);
    }));
    var catChips = el('div', { class: 'chips' }, cats.map(function (k) {
      return el('button', { class: 'chip', 'aria-pressed': String(state.cat === k), onclick: function () { state.cat = k; state.catChosen = true; renderSale(); } },
        [k === 'all' ? 'Все' : k === 'hot' ? 'Частые' : CATS[k]]);
    }));
    var search = el('input', { class: 'search', type: 'search', placeholder: 'Поиск позиции', value: state.query,
      oninput: function (e) { state.query = e.target.value; renderTilesOnly(); } });

    var tiles = el('div', { class: 'tiles', id: 'tiles' });
    function renderTilesOnly() {
      var qq = state.query.trim().toLowerCase();
      var l = state.data.catalog.filter(function (c) { return visible(c, qq); });
      // «Частые» в порядке продаж.
      if (!qq && state.cat === 'hot') l.sort(function (a, b) { return hits.indexOf(a.item_id) - hits.indexOf(b.item_id); });
      tiles.replaceChildren.apply(tiles, l.map(tile));
      if (!l.length) tiles.replaceChildren(el('div', { class: 'muted', style: 'grid-column:1/-1;text-align:center;padding:18px 0', text: 'Ничего не нашлось — проверьте название или выберите «Все»' }));
    }
    function tile(c) {
      var qty = d.cart[c.item_id] || 0;
      var low = c.stock < c.min;
      var short = state.shortage && state.shortage[c.item_id];
      var badges = [];
      if (state.cat !== 'hot' && (state.data.hits || []).slice(0, 3).indexOf(c.item_id) >= 0) badges.push(el('span', { class: 'badge badge--hit', text: 'хит' }));
      if (low) badges.push(el('span', { class: 'badge badge--low', text: 'мало · ' + c.stock }));
      if (c.review) badges.push(el('span', { class: 'badge badge--new', text: 'новое' }));
      return el('div', { class: 'tile' + (qty ? ' tile--on' : '') + (short ? ' tile--short' : '') }, [
        el('div', { class: 'tile__head' }, [itemArt(c), el('div', { class: 'tile__name', text: c.name })]),
        badges.length ? el('div', { class: 'badges' }, badges) : null,
        el('div', { class: 'tile__meta num', text: money(c.price) + ' · остаток ' + c.stock }),
        short ? el('div', { class: 'short' }, [
          el('div', { text: 'Не хватает: нужно ' + short.need + ', есть ' + short.have }),
          el('button', { class: 'chip', onclick: function () { openScreen('income', { lines: [{ item_id: c.item_id, qty: '', cost: '' }] }); } }, [icon('truck-delivery'), ' Внести приход'])
        ]) : null,
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
      // Подсказка о нехватке гаснет, как только в корзине стало не больше, чем есть на складе.
      var sh = state.shortage && state.shortage[c.item_id];
      if (sh && next <= c.stock) {
        delete state.shortage[c.item_id];
        if (!Object.keys(state.shortage).length) state.shortage = null;
        return renderSale();
      }
      renderTilesOnly();
      renderBottom();
    }
    renderTilesOnly();

    var bottom = el('div', { class: 'card', id: 'bottom' });
    function renderBottom() {
      var sm = summary(d);
      // Сообщение у самого поля: серверный отказ (после «Исправить») или локальная проверка.
      var note = function (w) {
        var fe = state.fieldError;
        var txt = fe && fe.where === w ? fe.text : (sm.where === w && sm.error && sm.items.length ? sm.error : '');
        if (!txt) return null;
        var kids = [el('div', { class: 'error', text: txt })];
        if (fe && fe.where === w && fe.code === 'SIMILAR_CUSTOMERS' && fe.details) {
          fe.details.forEach(function (c) {
            kids.push(el('button', { class: 'chip', onclick: function () { d.cust = { id: c.customer_id }; saveDraft(); renderBottom(); } }, [c.name + (c.note ? ' (' + c.note + ')' : '')]));
          });
        }
        return el('div', { class: 'fielderr', role: 'alert' }, kids);
      };
      var priceField = amountField('Цена (можно поставить свою)', d.price == null ? (sm.sum || '') : d.price, {
        quick: sm.sum ? [sm.sum, Math.ceil(sm.sum / 1000) * 1000, Math.ceil(sm.sum / 5000) * 5000].filter(function (v, i, a) { return a.indexOf(v) === i; }) : [1000, 5000, 10000],
        onDone: function (v) { d.price = v; saveDraft(); renderBottom(); } });
      var discChips = el('div', { class: 'chips' }, [['none', 'Без скидки'], ['amount', 'Скидка ₸'], ['pct', 'Скидка %']].map(function (t) {
        return el('button', { class: 'chip', 'aria-pressed': String(d.disc === t[0]), onclick: function () { d.disc = t[0]; d.discVal = ''; saveDraft(); renderBottom(); } }, [t[1]]);
      }));
      var discInput = d.disc === 'none' ? null : el('input', { class: 'input num', inputmode: 'decimal', placeholder: d.disc === 'pct' ? '10' : '500', value: d.discVal,
        oninput: function (e) { d.discVal = e.target.value; saveDraft(); updateTotals(); } });
      var payChips = el('div', { class: 'chips' }, [['cash', 'Нал'], ['card', 'Безнал'], ['mixed', 'Нал + безнал'], ['debt', 'В долг']].map(function (t) {
        return el('button', { class: 'chip', 'aria-pressed': String(d.pay === t[0]), onclick: function () { d.pay = t[0]; d.cashPart = ''; saveDraft(); renderBottom(); } }, [t[1]]);
      }));
      var cashInput = d.pay !== 'mixed' && d.pay !== 'debt' ? null
        : amountField(d.pay === 'debt' ? 'Оплачено сейчас наличными (если часть — остальное в долг)' : 'Наличными (остальное — безнал)', d.cashPart, {
          quick: [1000, 5000, 10000], onDone: function (v) { d.cashPart = v; saveDraft(); renderBottom(); } });
      // Сдача: сколько дал покупатель — сколько вернуть (только подсказка, в учёт не пишется).
      var change = d.pay !== 'cash' || !sm.total ? null : amountField('Покупатель дал (для расчёта сдачи)', d.given, {
        quick: [5000, 10000, 20000], placeholder: 'необязательно',
        hint: function (v) { return v ? (v >= sm.total ? 'Сдача: ' + money(v - sm.total) : 'Не хватает ' + money(sm.total - v)) : ''; },
        onDone: function (v) { d.given = v; saveDraft(); renderBottom(); } });
      var changeLine = d.pay === 'cash' && d.given && sm.total && Number(d.given) >= sm.total
        ? el('div', { class: 'change num' }, ['Сдача: ', el('b', { text: money(Number(d.given) - sm.total) })]) : null;
      var debtPicker = d.pay !== 'debt' ? null : customerPicker(d.cust || (d.cust = {}), function () { saveDraft(); updateTotals(); }, true);
      var totals = el('div', { id: 'totals' });
      bottom.replaceChildren(
        el('div', { class: 'sum' }, [el('span', { class: 'muted', text: 'По каталогу' }), el('span', { class: 'num', text: money(sm.sum) })]),
        priceField, note('price'),
        discChips, discInput, note('discount'), payChips, debtPicker, note('customer'), cashInput, note('pay'), change, changeLine, totals
      );
      updateTotals();
    }
    function updateTotals() {
      var sm = summary(d);
      drawSumbar(sm);
      var t = document.getElementById('totals');
      var nodes = [];
      if (sm.total) nodes.push(el('div', { class: 'sum' }, [el('span', { text: 'Итого' }), el('span', { class: 'big num', text: money(sm.total) })]));
      if (d.pay === 'mixed' && sm.payload) nodes.push(el('div', { class: 'muted num', text: 'Безнал: ' + money(sm.payload.payments[1].amount) }));
      if (d.pay === 'debt' && sm.payload) {
        var paidNow = sm.payload.payments.reduce(function (a, p) { return a + p.amount; }, 0);
        nodes.push(el('div', { class: 'muted num', text: 'В долг: ' + money(sm.total - paidNow) }));
      }
      if (t) t.replaceChildren.apply(t, nodes);
      var label = state.sending ? 'Проводим…' : (sm.payload ? 'Провести ' + money(sm.total) : 'Провести');
      mainButton(label, !!sm.payload && !state.sending, submit);
      if (!tg) {
        var fb = document.getElementById('fallback');
        if (fb) { fb.textContent = label; fb.disabled = !sm.payload || state.sending; }
      }
    }
    var sumbar = el('div', { class: 'sumbar', role: 'region', 'aria-label': 'Итог продажи' });
    function drawSumbar(sm) {
      var n = sm.items.reduce(function (a, x) { return a + x.qty; }, 0);
      if (!n) { sumbar.hidden = true; return; }
      sumbar.hidden = false;
      var pays = [['cash', 'Нал'], ['card', 'Безнал'], ['mixed', 'Нал+б/н'], ['debt', 'Долг']];
      sumbar.replaceChildren(
        el('div', { class: 'sumbar__top' }, [
          el('button', { class: 'sumbar__info', onclick: function () { bottom.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, [
            el('span', { class: 'muted', text: n + ' шт · ' + (d.type === 'bouquet' ? 'букет' : 'продажа') }),
            el('span', { class: 'sumbar__total num', text: money(sm.total || sm.price || sm.sum) }),
            el('span', { class: 'sumbar__more' }, [icon('chevron-up'), 'цена и скидка'])
          ])
        ]),
        el('div', { class: 'tabs4' }, pays.map(function (t) {
          return el('button', { class: 'chip', 'aria-pressed': String(d.pay === t[0]), onclick: function () {
            d.pay = t[0]; d.cashPart = ''; saveDraft(); renderBottom();
            if (t[0] === 'mixed' || t[0] === 'debt') bottom.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } }, [t[1]]);
        })),
        sm.error && sm.items.length ? el('div', { class: 'error', text: sm.error }) : null
      );
    }
    renderBottom();

    var tpls = state.data.templates || [];
    var last = store(LAST_KEY);
    var lastOk = last && last.items && last.items.length && !Object.keys(d.cart).length;
    var tplRow = el('div', { class: 'tpls' }, (lastOk ? [el('button', { class: 'tpl tpl--again', onclick: function () {
      applyTemplate({ name: 'последняя продажа', items: last.items, price: last.price, type: last.type });
    } }, [icon('repeat'), el('div', { class: 'tpl__name', text: 'Повторить последнюю' }),
      el('div', { class: 'muted num', style: 'font-size:12px', text: last.items.reduce(function (a, x) { return a + x.qty; }, 0) + ' шт · ' + money(last.price) })])] : []).concat(tpls.map(function (t) {
      var count = t.items.reduce(function (a, x) { return a + x.qty; }, 0);
      return el('button', { class: 'tpl', onclick: function () { applyTemplate(t); } }, [
        el('img', { src: 'img/ranunculus.svg', width: '40', height: '40', alt: '' }),
        el('div', { class: 'tpl__name', text: t.name }),
        el('div', { class: 'muted num', style: 'font-size:12px', text: count + ' шт · ' + money(t.price) })
      ]);
    })).concat(Object.keys(d.cart).length ? [el('button', { class: 'tpl tpl--add', onclick: saveTemplate }, [icon('plus'), el('div', { class: 'tpl__name', text: 'Сохранить как шаблон' })])] : []));
    function applyTemplate(t) {
      haptic('light');
      var short = {};
      d.cart = {};
      t.items.forEach(function (x) {
        var c = state.data.catalog.filter(function (k) { return k.item_id === x.item_id; })[0];
        var have = c ? c.stock : 0;
        if (have < x.qty) short[x.item_id] = { need: x.qty, have: have };
        if (have > 0) d.cart[x.item_id] = Math.min(x.qty, have);
      });
      d.type = t.type || 'bouquet';
      d.price = String(t.price);
      state.shortage = Object.keys(short).length ? short : null;
      saveDraft();
      if (state.shortage) toast('Для «' + t.name + '» не хватает товара — отмечено на плитках', true);
      renderSale();
    }
    // Сохранение шаблона: поле названия прямо на экране (системное окно ввода в Telegram работает не везде).
    var naming = null;
    function saveTemplate() {
      if (naming) return;
      var nameInput = el('input', { class: 'search', placeholder: 'Название букета, например «Нежность»', maxlength: '40' });
      naming = el('div', { class: 'card' }, [
        el('div', { class: 'muted', text: 'Сохранить состав и цену как шаблон — потом букет собирается одним нажатием.' }),
        nameInput,
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn--primary', onclick: function () {
            var name = nameInput.value.trim();
            if (!name) { toast('Введите название', true); return; }
            var sm = summary(d);
            busy(postOp('template_save', { name: name, items: sm.items, price: sm.price || sm.sum }, uuid())).then(function (res) {
              if (!res) return;
              setData(res.state, true);
              toast('Шаблон «' + name + '» сохранён');
            });
          } }, ['Сохранить']),
          el('button', { class: 'btn', onclick: function () { naming.remove(); naming = null; } }, ['Отмена'])
        ])
      ]);
      tplRow.after(naming);
      nameInput.focus();
    }
    // Сверху: общая ошибка (смена закрыта и т. п.) и нехватка товара со ссылкой «Внести приход».
    var fe0 = state.fieldError;
    var generalNote = fe0 && fe0.where === 'general' ? el('div', { class: 'card card--note', role: 'alert' }, [
      el('div', { class: 'error', text: fe0.text }),
      el('button', { class: 'btn', onclick: function () { state.fieldError = null; goMain(); } }, ['На главную'])]) : null;
    var stockNote = state.shortage ? el('div', { class: 'card card--note', role: 'alert' }, [
      el('div', { class: 'error', text: 'Не хватает на складе: ' + Object.keys(state.shortage).map(function (id) {
        return nameOf(id) + ' — есть ' + state.shortage[id].have + ', нужно ' + state.shortage[id].need; }).join('; ') }),
      el('button', { class: 'btn', onclick: function () {
        openScreen('income', { lines: Object.keys(state.shortage).map(function (id) { return { item_id: id, qty: '', cost: '' }; }) });
      } }, [icon('truck-delivery'), 'Внести приход'])]) : null;
    var nodes = [generalNote, stockNote, typeChips, tpls.length || lastOk || Object.keys(d.cart).length ? tplRow : null, catChips, search, tiles, bottom];
    nodes.push(sumbar);
    if (!tg) nodes.push(el('button', { class: 'btn btn--primary fallback-main', id: 'fallback', onclick: submit }, ['Провести']));
    app.replaceChildren.apply(app, nodes);
    updateTotals();
  }

  // ---------- закрытие смены (ТЗ: инвентаризация → расходы → пересчёт вслепую → расхождение → ЗП → изъятие) ----------

  var CLOSE_KEY = 'flora.close.v1';

  function openClose() {
    // Нельзя закрывать смену, пока есть неотправленные продажи: они попали бы не в ту смену.
    var left = myQ();
    if (left.length) {
      toast('Сначала дождитесь отправки продаж: в очереди ' + left.length + (failedQ().length ? ' (есть не проведённые)' : ''), true);
      openScreen('queue');
      return;
    }
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
        setData(res.state, true);
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
        setData(res.state, true);
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
        c.done = { next_cash: res.result.next_cash, shift_no: res.result.shift_no, clean: res.result.cash_diff === 0 };
        if (res.result.cash_diff === 0) setTimeout(petalBurst, 250);
        setData(res.state, true);
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
        c.done.clean ? el('div', { class: 'script', style: 'font-size:22px', text: 'Касса сошлась до тенге!' }) : null,
        el('div', { class: 'muted num', text: 'Оставлено в кассе на следующую смену: ' + money(c.done.next_cash) })
      ]),
      el('div', { class: 'muted center', text: 'Отчёт отправлен владелице.' }));
    mainButton('Готово', true, function () { state.close = null; state.screen = 'main'; render(); });
  }

  // ---------- общие элементы форм ----------

  /** Покупатель: выбрать из списка или вписать нового. obj хранит выбор (живёт в черновике). */
  function customerPicker(obj, onChange, debtorsFirst) {
    var list = state.data.customers.slice();
    if (debtorsFirst) list.sort(function (a, b) { return (b.debt > 0) - (a.debt > 0); });
    var box = el('div', { class: 'field' });
    function draw() {
      var sel = el('select', { class: 'input', 'aria-label': 'Покупатель', onchange: null });
      sel.appendChild(el('option', { value: '', text: '— Новый покупатель —' }));
      list.forEach(function (c) {
        var o = el('option', { value: c.customer_id, text: c.name + (c.note ? ' (' + c.note + ')' : '') + (c.debt ? ' — долг ' + money(c.debt) : '') });
        if (obj.id === c.customer_id) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () { obj.id = sel.value; draw(); onChange(); };
      var nodes = [el('label', { text: 'Покупатель' }), sel];
      if (!obj.id) {
        nodes.push(el('input', { class: 'search', placeholder: 'Имя (без фамилии и телефона)', value: obj.name || '',
          oninput: function (e) { obj.name = e.target.value; onChange(); } }));
        nodes.push(el('input', { class: 'search', placeholder: 'Пометка, например «соседний магазин»', value: obj.note || '',
          oninput: function (e) { obj.note = e.target.value; onChange(); } }));
        var cb = el('input', { type: 'checkbox', id: 'cnew' });
        cb.checked = !!obj.confirm;
        cb.onchange = function () { obj.confirm = cb.checked; onChange(); };
        nodes.push(el('label', { class: 'muted', for: 'cnew' }, [cb, ' Это другой человек, хотя имя совпадает']));
      }
      box.replaceChildren.apply(box, nodes);
    }
    draw();
    return box;
  }
  function customerRef(obj) {
    if (obj.id) return { customer_id: obj.id };
    if (obj.name && obj.name.trim()) return { new_customer: { name: obj.name.trim(), note: (obj.note || '').trim(), confirm_new: !!obj.confirm } };
    return null;
  }

  /** Строки «позиция — количество (— сумма)». lines — массив в черновике экрана. */
  function linesEditor(lines, opts, onChange) {
    var box = el('div', { class: 'card' });
    function draw() {
      var rows = lines.map(function (l, i) {
        var sel = el('select', { class: 'input', 'aria-label': 'Позиция' });
        sel.appendChild(el('option', { value: '', text: '— выберите позицию —' }));
        state.data.catalog.forEach(function (c) {
          var o = el('option', { value: c.item_id, text: c.name + ' · остаток ' + c.stock });
          if (l.item_id === c.item_id) o.selected = true;
          sel.appendChild(o);
        });
        sel.onchange = function () { l.item_id = sel.value; onChange(); };
        var qty = el('input', { class: 'input num', inputmode: 'numeric', placeholder: 'шт', value: l.qty || '', 'aria-label': 'Количество',
          oninput: function (e) { l.qty = e.target.value; onChange(); } });
        var parts = [qty];
        if (opts.withCost) {
          parts.push(el('input', { class: 'input num', inputmode: 'numeric', placeholder: 'сумма ₸', value: l.cost || '', 'aria-label': 'Сумма по накладной',
            oninput: function (e) { l.cost = e.target.value; onChange(); } }));
        }
        parts.push(el('button', { class: 'btn', 'aria-label': 'Убрать строку', onclick: function () { lines.splice(i, 1); draw(); onChange(); } }, ['✕']));
        return el('div', { class: 'field' }, [sel, el('div', { class: 'row' }, parts)]);
      });
      rows.push(el('button', { class: 'btn', onclick: function () { lines.push({ item_id: '', qty: '' }); draw(); onChange(); } }, ['+ Строка']));
      box.replaceChildren.apply(box, rows);
    }
    draw();
    return box;
  }
  function cleanLines(lines, withCost) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l.item_id && !l.qty && !l.cost) continue;
      var q = intOf(l.qty);
      if (!l.item_id || !q) return { error: 'В каждой строке — позиция и количество' };
      var line = { item_id: l.item_id, qty: q };
      if (withCost) {
        var c = intOf(l.cost);
        if (c === null) return { error: 'В каждой строке — сумма по накладной' };
        line.cost_sum = c;
      }
      out.push(line);
    }
    if (!out.length) return { error: 'Добавьте хотя бы одну строку' };
    return { lines: out };
  }
  function title(text, sub) {
    return el('div', {}, [el('h1', { class: 'h1', text: text }), sub ? el('div', { class: 'muted', text: sub }) : null]);
  }
  function chips(options, current, onPick) {
    return el('div', { class: 'chips' }, options.map(function (t) {
      return el('button', { class: 'chip', 'aria-pressed': String(current === t[0]), onclick: function () { onPick(t[0]); } }, [t[1]]);
    }));
  }
  function openScreen(screen, data) {
    state.form = Object.assign({ op_id: uuid() }, data || {});
    state.screen = screen;
    render();
    window.scrollTo(0, 0);
  }
  /** Провести операцию с кнопки экрана; после успеха — обновлённые данные и возврат. */
  function submitOp(kind, payload, okText, next) {
    var f = state.form;
    busy(postOp(kind, payload, f.op_id)).then(function (res) {
      if (!res) return;
      haptic('success');
      ocClear();
      setData(res.state, true);
      toast((res.status === 'already' ? 'Уже было проведено. ' : '') + okText);
      if (next) next(res); else { state.screen = 'main'; render(); }
    });
  }

  var SCREENS = SCREENS_EARLY;

  // ---------- приход ----------
  SCREENS.income = function () {
    backButton(true);
    var f = state.form;
    f.lines = f.lines || [{ item_id: '', qty: '', cost: '' }];
    var totalEl = el('div', { class: 'sum' });
    function upd() {
      var c = cleanLines(f.lines, true);
      var total = c.lines ? c.lines.reduce(function (a, l) { return a + l.cost_sum; }, 0) : 0;
      totalEl.replaceChildren(el('span', { text: 'Итог накладной (сверьте с бумагой)' }), el('span', { class: 'big num', text: money(total) }));
      var ok = c.lines && (f.supplier || '').trim();
      mainButton(state.sending ? 'Проводим…' : 'Провести приход ' + money(total), !!ok && !state.sending, function () {
        submitOp('income', { lines: c.lines, supplier: f.supplier.trim() }, 'Приход проведён');
      });
    }
    var nf = f.newItem || (f.newItem = { open: false, category: 'flowers', name: '', price: '' });
    var newBox = el('div', { class: 'card' });
    function drawNew() {
      if (!nf.open) {
        newBox.replaceChildren(el('button', { class: 'btn', onclick: function () { nf.open = true; drawNew(); } }, ['+ Новая позиция в каталог']));
        return;
      }
      newBox.replaceChildren(
        el('div', { class: 'muted', text: 'Новая позиция сразу работает в продажах, владелица проверит её позже.' }),
        chips(Object.keys(CATS).map(function (k) { return [k, CATS[k]]; }), nf.category, function (k) { nf.category = k; drawNew(); }),
        el('input', { class: 'search', placeholder: 'Название, например «Роза белая 60 см»', value: nf.name, oninput: function (e) { nf.name = e.target.value; } }),
        el('input', { class: 'input num', inputmode: 'numeric', placeholder: 'Цена продажи ₸', value: nf.price, oninput: function (e) { nf.price = e.target.value; } }),
        nf.similar ? el('div', { class: 'error', text: 'Похожие уже есть: ' + nf.similar.join(', ') + '. Если это другая позиция — нажмите «Создать» ещё раз.' }) : null,
        el('button', { class: 'btn btn--primary', disabled: state.sending, onclick: function () {
          var price = intOf(nf.price);
          if (!nf.name.trim() || !price) return toast('Название и цена продажи', true);
          busy(postOp('new_item', { category: nf.category, name: nf.name.trim(), sale_price: price, confirm_new: !!nf.similar }, uuid())
            .catch(function (e) {
              if (e.code === 'SIMILAR_ITEMS') { nf.similar = (e.details || []).map(function (x) { return x.name; }); }
              throw e;
            })).then(function (res) {
            if (!res) { render(); return; }
            setData(res.state, true);
            f.lines.push({ item_id: res.result.item_id, qty: '', cost: '' });
            f.newItem = { open: false, category: 'flowers', name: '', price: '' };
            toast('Позиция добавлена — впишите количество и сумму');
            render();
          });
        } }, ['Создать'])
      );
    }
    drawNew();
    app.replaceChildren(title('Приход', 'Строки накладной: позиция, количество, сумма за строку. Касса не меняется — поставщику платит владелица.'),
      linesEditor(f.lines, { withCost: true }, upd), newBox,
      el('div', { class: 'field' }, [el('label', { text: 'Поставщик' }),
        el('input', { class: 'search', value: f.supplier || '', placeholder: 'Например, Флора-опт', oninput: function (e) { f.supplier = e.target.value; upd(); } })]),
      el('div', { class: 'card' }, [totalEl]));
    upd();
  };

  // ---------- брак ----------
  SCREENS.defect = function () {
    backButton(true);
    var f = state.form;
    f.lines = f.lines || [{ item_id: '', qty: '' }];
    f.reason = f.reason || 'wilted';
    function upd() {
      var c = cleanLines(f.lines, false);
      mainButton(state.sending ? 'Проводим…' : 'Списать', !!c.lines && !state.sending, function () {
        submitOp('defect', { lines: c.lines.map(function (l) { return { item_id: l.item_id, qty: l.qty, reason: f.reason }; }) }, 'Списано');
      });
    }
    app.replaceChildren(title('Брак', 'Что списать и почему'),
      chips([['arrived_bad', 'Пришло бракованным'], ['wilted', 'Завяло'], ['broken', 'Сломано'], ['gift', 'Подарок'], ['other', 'Другое']], f.reason,
        function (k) { f.reason = k; render(); }),
      linesEditor(f.lines, {}, upd));
    upd();
  };

  // ---------- расход, изъятие, погашение долга, отмена продажи ----------

  SCREENS.cashout = function () {
    backButton(true);
    var f = state.form;
    if (f.type === undefined) { f.type = 'delivery'; f.amount = ''; f.comment = ''; }
    function upd() {
      var a = intOf(f.amount);
      mainButton(state.sending ? 'Записываем…' : 'Записать расход' + (a ? ' ' + money(a) : ''), !!a && a > 0 && !state.sending, function () {
        submitOp('cash_out', { type: f.type, amount: a, comment: f.comment.trim() }, 'Расход записан');
      });
    }
    app.replaceChildren(
      title('Расход из кассы', 'Доставка, закупка мелочей — то, что заплатили из кассы'),
      chips([['delivery', 'Доставка'], ['other', 'Прочее']], f.type, function (k) { f.type = k; render(); }),
      formField('Сумма, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.amount, oninput: function (e) { f.amount = e.target.value; upd(); } })),
      formField('На что (по желанию)', el('input', { class: 'input', value: f.comment, maxlength: '200', placeholder: 'например: такси до клиента', oninput: function (e) { f.comment = e.target.value; } }),
        'Расход уменьшит расчёт кассы и будет виден владелице в отчёте смены.')
    );
    upd();
  };

  SCREENS.withdraw = function () {
    backButton(true);
    var f = state.form;
    if (f.amount === undefined) f.amount = '';
    function upd() {
      var a = intOf(f.amount);
      mainButton(state.sending ? 'Записываем…' : 'Записать изъятие' + (a ? ' ' + money(a) : ''), !!a && a > 0 && !state.sending, function () {
        askOk('Записать, что владелица забрала ' + money(a) + ' из кассы?', function () {
          submitOp('withdrawal', { amount: a }, 'Изъятие записано');
        });
      });
    }
    app.replaceChildren(
      title('Владелица забрала', 'Деньги из кассы в течение смены'),
      formField('Сумма, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.amount, oninput: function (e) { f.amount = e.target.value; upd(); } }),
        'Владелица сразу получит сообщение об этом изъятии.')
    );
    upd();
  };

  SCREENS.repay = function () {
    backButton(true);
    var f = state.form;
    var debtors = (state.data.customers || []).filter(function (c) { return c.debt > 0; });
    if (!f.customer) {
      mainButton(null);
      var q = (f.q || '').toLowerCase();
      var list = debtors.filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) >= 0; });
      app.replaceChildren.apply(app, [
        title('Погашение долга', 'Кто принёс деньги'),
        debtors.length > 5 ? el('input', { class: 'search', placeholder: 'Поиск по имени', value: f.q || '', oninput: function (e) { f.q = e.target.value; render(); } }) : null
      ].concat(list.length ? list.map(function (c) {
        return el('button', { class: 'btn', style: 'text-align:left', onclick: function () { f.customer = c; f.amount = String(c.debt); f.method = 'cash'; render(); } }, [
          el('div', { class: 'sum' }, [el('b', { text: c.name }), el('span', { class: 'num copper', text: money(c.debt) })]),
          c.note ? el('div', { class: 'muted', text: c.note }) : null
        ]);
      }) : [emptyState('Должников нет', 'Все рассчитались.')]));
      return;
    }
    var c = f.customer;
    function upd() {
      var a = intOf(f.amount);
      var ok = a && a > 0 && a <= c.debt;
      mainButton(state.sending ? 'Проводим…' : 'Принять ' + (a ? money(a) : ''), !!ok && !state.sending, function () {
        submitOp('debt_repay', { customer_id: c.customer_id, method: f.method, amount: a }, 'Долг погашен');
      });
    }
    app.replaceChildren(
      title(c.name, 'Долг ' + money(c.debt)),
      formField('Сколько принёс, ₸ (не больше ' + money(c.debt) + ')', el('input', { class: 'input num', inputmode: 'numeric', value: f.amount, oninput: function (e) { f.amount = e.target.value; upd(); } })),
      chips([['cash', 'Наличными'], ['card', 'Картой']], f.method, function (k) { f.method = k; render(); }),
      el('button', { class: 'btn', onclick: function () { f.customer = null; render(); } }, 'Другой покупатель')
    );
    upd();
  };

  SCREENS.cancel = function () {
    backButton(true);
    var f = state.form;
    if (!f.receipts) {
      mainButton(null);
      app.replaceChildren(title('Отмена продажи', 'Чеки текущей смены'), skeleton('list'));
      api({ action: 'receipts', days: 2 }).then(function (list) { f.receipts = list.filter(function (r) { return r.cancellable; }); render(); })
        .catch(function (e) { toast(e.message || 'Нет связи', true); });
      return;
    }
    if (!f.receipt) {
      mainButton(null);
      app.replaceChildren.apply(app, [title('Отмена продажи', 'Выберите чек этой смены. Товар вернётся на склад.')].concat(f.receipts.length ? f.receipts.map(function (r) {
        return el('button', { class: 'btn', style: 'text-align:left', onclick: function () { f.receipt = r; f.reason = ''; render(); } }, [
          el('div', { class: 'sum' }, [el('span', { text: '№' + r.receipt_no + ' · ' + String(r.created_at).slice(11, 16) + (r.type === 'bouquet' ? ' · букет' : '') }), el('b', { class: 'num', text: money(r.total) })])
        ]);
      }) : [emptyState('Отменять нечего', 'В этой смене нет чеков, которые можно отменить. После возврата или замены отмена невозможна, предзаказ отменяет владелица.')]));
      return;
    }
    var r = f.receipt;
    function upd() {
      var ok = f.reason.trim().length >= 3;
      mainButton(state.sending ? 'Отменяем…' : 'Отменить чек №' + r.receipt_no, ok && !state.sending, function () {
        askOk('Отменить чек №' + r.receipt_no + ' на ' + money(r.total) + '? Владелица получит сообщение.', function () {
          submitOp('cancel', { receipt_id: r.receipt_id, reason: f.reason.trim() }, 'Чек отменён');
        });
      });
    }
    app.replaceChildren(
      title('Чек №' + r.receipt_no, money(r.total)),
      formField('Причина отмены', el('input', { class: 'input', value: f.reason, maxlength: '200', placeholder: 'например: ошибся с позицией', oninput: function (e) { f.reason = e.target.value; upd(); } }),
        'Обязательно: причина попадёт в отчёт владелице.'),
      el('button', { class: 'btn', onclick: function () { f.receipt = null; render(); } }, 'Другой чек')
    );
    upd();
  };

  // ---------- возврат ----------
  SCREENS.refund = function () {
    backButton(true);
    var f = state.form;
    if (!f.receipts) {
      app.replaceChildren(title('Возврат', 'Чеки за 7 дней'), skeleton('list'));
      mainButton(null);
      api({ action: 'receipts', days: 7 }).then(function (list) { f.receipts = list; render(); })
        .catch(function (e) { toast(e.message || 'Нет связи', true); });
      return;
    }
    if (!f.receipt) {
      var q = (f.q || '').replace(/\D/g, '');
      var list = f.receipts.filter(function (r) { return !q || String(r.total).indexOf(q) >= 0; });
      var search = el('input', { class: 'search', inputmode: 'numeric', placeholder: 'Сумма чека', value: f.q || '',
        oninput: function (e) { f.q = e.target.value; render(); var s = app.querySelector('.search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } } });
      mainButton(null);
      app.replaceChildren.apply(app, [title('Возврат', 'Найдите чек по сумме'), search].concat(list.length ? list.map(function (r) {
        return el('button', { class: 'btn', style: 'text-align:left', onclick: function () { f.receipt = r; f.mode = 'money'; f.method = 'cash'; render(); } }, [
          el('div', { class: 'sum' }, [el('span', { text: '№' + r.receipt_no + ' · ' + String(r.created_at).slice(8, 10) + '.' + String(r.created_at).slice(5, 7) + ' ' + String(r.created_at).slice(11, 16) }),
            el('span', { class: 'num', text: money(r.total) })]),
          el('div', { class: 'muted num', text: (r.type === 'bouquet' ? 'букет · ' : r.type === 'preorder' ? 'предзаказ · ' : '') + 'можно вернуть деньгами до ' + money(r.refundable) })
        ]);
      }) : [emptyState('Чеков не нашлось', q ? 'Нет чеков на такую сумму за 7 дней.' : 'За последние 7 дней чеков нет.')]));
      return;
    }
    var r = f.receipt;
    f.lines = f.lines || [{ item_id: '', qty: '' }];
    var body = el('div', {});
    function upd() {
      if (f.mode === 'money') {
        var a = intOf(f.amount);
        var ok = a && a <= r.refundable;
        mainButton(state.sending ? 'Проводим…' : 'Вернуть ' + (a ? money(a) : ''), !!ok && !state.sending, function () {
          submitOp('refund', { receipt_id: r.receipt_id, mode: 'money', method: f.method, amount: a }, 'Возврат проведён');
        });
      } else {
        var c = cleanLines(f.lines, false);
        mainButton(state.sending ? 'Проводим…' : 'Выдать замену', !!c.lines && !state.sending, function () {
          submitOp('refund', { receipt_id: r.receipt_id, mode: 'replace', items: c.lines }, 'Замена проведена');
        });
      }
    }
    if (f.mode === 'money') {
      body.replaceChildren(
        el('div', { class: 'field' }, [el('label', { text: 'Сумма возврата (не больше ' + money(r.refundable) + ')' }),
          el('input', { class: 'input num', inputmode: 'numeric', value: f.amount || '', oninput: function (e) { f.amount = e.target.value; upd(); } })]),
        chips([['cash', 'Наличными'], ['card', 'На карту']], f.method, function (k) { f.method = k; render(); }));
    } else {
      body.replaceChildren(el('div', { class: 'muted', text: 'Состав нового букета со склада. Вернувшиеся цветы на склад не приходуются.' }),
        linesEditor(f.lines, {}, upd));
    }
    app.replaceChildren(title('Возврат по чеку №' + r.receipt_no, money(r.total)),
      chips([['money', 'Вернуть деньги'], ['replace', 'Заменить букет']], f.mode, function (k) { f.mode = k; render(); }), body,
      el('button', { class: 'btn', onclick: function () { f.receipt = null; render(); } }, ['Другой чек']));
    upd();
  };

  // ---------- остатки ----------
  SCREENS.stock = function () {
    backButton(true);
    mainButton(null);
    var f = state.form;
    var q = (f.q || '').trim().toLowerCase();
    var cat = f.cat || 'all';
    var list = state.data.catalog.filter(function (c) {
      return (cat === 'all' || c.category === cat) && (!q || c.name.toLowerCase().indexOf(q) >= 0);
    }).sort(function (a, b) { return ((b.stock < b.min) - (a.stock < a.min)) || (a.name < b.name ? -1 : 1); });
    var onShift = !!(state.data.shift && state.data.shift.on_shift);
    app.replaceChildren(title('Склад'),
      onShift ? el('div', { class: 'row' }, [
        el('button', { class: 'btn btn--primary', onclick: function () { openScreen('income'); } }, [icon('truck-delivery'), 'Принять товар']),
        el('button', { class: 'btn', onclick: function () { openScreen('defect'); } }, [icon('flower-off'), 'Списать брак'])
      ]) : null,
      el('input', { class: 'search', type: 'search', placeholder: 'Поиск', value: f.q || '', oninput: function (e) { f.q = e.target.value; render(); } }),
      chips([['all', 'Все']].concat(Object.keys(CATS).map(function (k) { return [k, CATS[k]]; })), cat, function (k) { f.cat = k; render(); }),
      el('div', { class: 'card' }, list.map(function (c) {
        var low = c.stock < c.min;
        return el('div', { class: 'item' }, [
          itemArt(c),
          el('div', { class: 'item__main' }, [el('div', { style: 'font-weight:600', text: c.name }),
            el('div', { class: 'muted num', style: 'font-size:13px', text: money(c.price) + ' · ' + c.stock + ' шт' + (c.review ? ' · на проверке' : '') })]),
          el('span', { class: 'status ' + (low ? 'status--low' : 'status--ok'), text: low ? 'Мало · мин. ' + c.min : 'Есть' }),
          onShift ? el('button', { class: 'chip', 'aria-label': 'Принять ' + c.name, onclick: function () { openScreen('income', { lines: [{ item_id: c.item_id, qty: '', cost: '' }] }); } }, ['+']) : null
        ]);
      })));
  };

  // ---------- предзаказы и брони ----------
  function dateRu(d) { var p = String(d).split('-'); return p.length === 3 ? p[2] + '.' + p[1] : d; }
  SCREENS.preorders = function () {
    backButton(true);
    mainButton('Новый предзаказ', !state.sending, function () { openScreen('preorder_new'); });
    var d = state.data;
    var f = state.form || {};
    var nodes = [title('Предзаказы', 'По дате выдачи')];
    // Календарь на 14 дней: точки — сколько выдач в день; касание — показать только этот день.
    var all = d.preorders.map(function (p) { return p.pickup_date; }).concat(d.reservations.map(function (r) { return r.pickup_date; }));
    var today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    var overdue = all.filter(function (x) { return x < today; }).length;
    var WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    var cells = [];
    for (var i = 0; i < 14; i++) {
      var day = new Date(Date.parse(today + 'T00:00:00Z') + i * 86400000);
      var iso = day.toISOString().slice(0, 10);
      var n = all.filter(function (x) { return x === iso; }).length;
      (function (iso, n, wd, num) {
        cells.push(el('button', { class: 'cal__day' + (f.day === iso ? ' cal__day--on' : '') + (i === 0 ? ' cal__day--today' : ''), 'aria-label': iso + ': выдач ' + n,
          onclick: function () { f.day = f.day === iso ? null : iso; render(); } }, [
          el('span', { class: 'cal__wd', text: wd }), el('span', { class: 'cal__num', text: num }),
          el('span', { class: 'cal__dots' }, n ? Array.from({ length: Math.min(n, 3) }, function () { return el('i'); }).concat(n > 3 ? [el('em', { text: '+' + (n - 3) })] : []) : [])
        ]));
      })(iso, n, WD[day.getUTCDay()], String(day.getUTCDate()));
    }
    if (all.length) {
      nodes.push(el('div', { class: 'card' }, [
        el('div', { class: 'cal' }, cells),
        overdue ? el('div', { class: 'error', text: 'Просрочено выдач: ' + overdue + ' — проверьте, забрали ли заказ' }) : null,
        f.day ? el('button', { class: 'chip', onclick: function () { f.day = null; render(); } }, ['Показать все дни']) : null
      ]));
    }
    var onDay = function (x) { return !f.day || x.pickup_date === f.day; };
    if (!d.preorders.length && !d.reservations.length) {
      nodes.push(emptyState('Предзаказов пока нет', 'Когда клиент закажет букет заранее, он появится здесь — по дате выдачи.'));
    }
    d.preorders.filter(onDay).forEach(function (p) {
      nodes.push(el('div', { class: 'card' }, [
        el('div', { class: 'sum' }, [el('b', { text: dateRu(p.pickup_date) + ' · ' + p.customer }), el('span', { class: 'num', text: money(p.total) })]),
        el('div', { class: 'muted num', text: 'аванс ' + money(p.paid) + ' · к доплате ' + money(p.unpaid) + ' · ' + (p.assembly_status === 'assembled' ? 'собран' : 'не собран') }),
        p.assembly_status === 'waiting'
          ? el('button', { class: 'btn', onclick: function () { openScreen('assemble', { pre: p }); } }, ['Собрать'])
          : el('button', { class: 'btn btn--primary', onclick: function () { openScreen('pickup', { pre: p, method: 'cash' }); } }, ['Выдать'])
      ]));
    });
    d.reservations.filter(onDay).forEach(function (r) {
      nodes.push(el('div', { class: 'card card--note' }, [
        el('div', { class: 'sum' }, [el('b', { text: dateRu(r.pickup_date) + ' · ' + r.customer + ' · бронь' }), el('span', { class: 'num', text: money(r.total) })]),
        el('div', { class: 'muted', text: 'Без аванса — в выручку войдёт, когда внесут первую оплату.' }),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn btn--primary', onclick: function () { openScreen('preorder_new', { fromRes: r, method: 'cash' }); } }, ['Принять аванс']),
          el('button', { class: 'btn', onclick: function () {
            state.form = { op_id: uuid() };
            submitOp('reserve_cancel', { reservation_id: r.reservation_id }, 'Бронь отменена', function () { state.screen = 'preorders'; render(); });
          } }, ['Отменить бронь'])
        ])
      ]));
    });
    app.replaceChildren.apply(app, nodes);
  };

  SCREENS.preorder_new = function () {
    backButton(true);
    var f = state.form;
    f.method = f.method || 'cash';
    f.cust = f.cust || {};
    var res = f.fromRes;
    var hint = el('div', {});
    function upd() {
      var total = res ? res.total : intOf(f.price);
      var adv = f.advance === '' || f.advance == null ? 0 : intOf(f.advance);
      var cust = res ? true : customerRef(f.cust);
      var err = !cust ? 'Укажите клиента' : !res && !/^\d{4}-\d{2}-\d{2}$/.test(f.date || '') ? 'Укажите дату выдачи' : !total ? 'Укажите сумму заказа'
        : adv === null || adv > total ? 'Аванс — не больше суммы заказа' : (res && !adv) ? 'Впишите аванс' : '';
      hint.replaceChildren(err ? el('div', { class: 'error', text: err })
        : el('div', { class: 'muted num', text: adv ? 'Предзаказ: войдёт в выручку сегодня на ' + money(total) + ', к доплате ' + money(total - adv) : 'Без аванса — это бронь: в выручку не входит' }));
      var label = adv ? 'Провести, аванс ' + money(adv) : 'Записать бронь';
      mainButton(state.sending ? 'Проводим…' : label, !err && !state.sending, function () {
        if (res) return submitOp('preorder', { reservation_id: res.reservation_id, payments: [{ method: f.method, amount: adv }] }, 'Аванс принят', backToList);
        if (adv) {
          return submitOp('preorder', { customer: customerRef(f.cust), pickup_date: f.date, price: total, discount: { kind: 'none' },
            payments: [{ method: f.method, amount: adv }] }, 'Предзаказ оформлен', backToList);
        }
        submitOp('reserve', { customer: customerRef(f.cust), pickup_date: f.date, price: total, discount: { kind: 'none' } }, 'Бронь записана', backToList);
      });
    }
    function backToList() { state.screen = 'preorders'; render(); }
    var nodes = [title(res ? 'Аванс по брони' : 'Новый предзаказ', res ? res.customer + ' · ' + dateRu(res.pickup_date) + ' · ' + money(res.total) : 'Клиент, дата выдачи, сумма, аванс')];
    if (!res) {
      nodes.push(customerPicker(f.cust, upd, false));
      nodes.push(el('div', { class: 'field' }, [el('label', { text: 'Дата выдачи' }),
        el('input', { class: 'input', type: 'date', min: new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10), value: f.date || '', oninput: function (e) { f.date = e.target.value; upd(); } })]));
      nodes.push(el('div', { class: 'field' }, [el('label', { text: 'Сумма заказа' }),
        el('input', { class: 'input num', inputmode: 'numeric', value: f.price || '', oninput: function (e) { f.price = e.target.value; upd(); } })]));
    }
    nodes.push(el('div', { class: 'field' }, [el('label', { text: res ? 'Аванс' : 'Аванс (0 или пусто — бронь без аванса)' }),
      el('input', { class: 'input num', inputmode: 'numeric', value: f.advance || '', oninput: function (e) { f.advance = e.target.value; upd(); } })]));
    nodes.push(chips([['cash', 'Нал'], ['card', 'Безнал']], f.method, function (k) { f.method = k; render(); }));
    nodes.push(hint);
    app.replaceChildren.apply(app, nodes);
    upd();
  };

  SCREENS.assemble = function () {
    backButton(true);
    var f = state.form;
    f.lines = f.lines || [{ item_id: '', qty: '' }];
    function upd() {
      var c = cleanLines(f.lines, false);
      mainButton(state.sending ? 'Проводим…' : 'Собрано — списать со склада', !!c.lines && !state.sending, function () {
        submitOp('preorder_assemble', { receipt_id: f.pre.receipt_id, items: c.lines }, 'Предзаказ собран', function () { state.screen = 'preorders'; render(); });
      });
    }
    app.replaceChildren(title('Сборка: ' + f.pre.customer, 'Состав букета со склада'), linesEditor(f.lines, {}, upd));
    upd();
  };

  SCREENS.pickup = function () {
    backButton(true);
    var f = state.form;
    var p = f.pre;
    var hint = el('div', {});
    function upd() {
      var pay = f.method === 'debt' ? (f.now === '' || f.now == null ? 0 : intOf(f.now)) : p.unpaid;
      var err = pay === null || (f.method === 'debt' && pay >= p.unpaid) ? 'Оплачено сейчас — меньше остатка' : '';
      hint.replaceChildren(err ? el('div', { class: 'error', text: err })
        : f.method === 'debt' ? el('div', { class: 'muted num', text: 'В долг: ' + money(p.unpaid - pay) }) : null);
      var payload = { receipt_id: p.receipt_id, payments: [] };
      if (f.method === 'debt') { if (pay) payload.payments.push({ method: 'cash', amount: pay }); payload.to_debt = true; }
      else if (p.unpaid) payload.payments.push({ method: f.method, amount: p.unpaid });
      var label = !p.unpaid ? 'Выдать'
        : f.method === 'debt' ? 'Выдать: ' + (pay ? 'оплата ' + money(pay) + ', ' : '') + 'в долг ' + money(p.unpaid - (pay || 0))
        : 'Выдать, доплата ' + money(p.unpaid);
      mainButton(state.sending ? 'Проводим…' : label, !err && !state.sending, function () {
        submitOp('preorder_pickup', payload, 'Выдано', function () { state.screen = 'preorders'; render(); });
      });
    }
    var nodes = [title('Выдача: ' + p.customer, 'Заказ ' + money(p.total) + ' · аванс ' + money(p.paid))];
    if (p.unpaid) {
      nodes.push(el('div', { class: 'card' }, [el('div', { class: 'sum' }, [el('span', { text: 'К доплате' }), el('span', { class: 'big num', text: money(p.unpaid) })])]));
      nodes.push(chips([['cash', 'Нал'], ['card', 'Безнал'], ['debt', 'Остаток в долг']], f.method, function (k) { f.method = k; render(); }));
      if (f.method === 'debt') {
        nodes.push(el('div', { class: 'field' }, [el('label', { text: 'Оплачено сейчас наличными (необязательно)' }),
          el('input', { class: 'input num', inputmode: 'numeric', value: f.now || '', oninput: function (e) { f.now = e.target.value; upd(); } })]));
      }
    } else nodes.push(el('div', { class: 'muted', text: 'Заказ оплачен полностью.' }));
    nodes.push(hint);
    app.replaceChildren.apply(app, nodes);
    upd();
  };

  // ---------- владелица: Сегодня, История, Сводка, Должники ----------

  var OWNER_TABS = [['owner_today', 'Сегодня'], ['owner_history', 'История'], ['owner_period', 'Сводка'], ['owner_debtors', 'Должники'], ['owner_catalog', 'Склад'], ['owner_manage', 'Ещё']];

  function ownerTabs() {
    var cur = state.screen === 'owner_shift' ? 'owner_history' : state.screen;
    var t = OWNER_TABS.filter(function (x) { return x[0] === cur; })[0];
    if (cur === 'owner_today') {
      return el('div', {}, [el('div', { class: 'hello', text: greeting() + ', ' + firstName(state.data.me.name) + '!' }),
        el('div', { class: 'muted', text: 'Вот как идут дела в магазине' })]);
    }
    return el('h1', { class: 'h1', text: t ? (t[0] === 'owner_period' ? 'Аналитика' : t[1]) : '' });
  }
  /** Отчёт с сервера: текст уже экранирован, разрешаем только <b>. */
  function reportBlock(text) {
    var box = el('div', { class: 'card', style: 'white-space:pre-wrap;font-size:14px;line-height:1.45' });
    box.innerHTML = String(text || '').replace(/<(?!\/?b>)[^>]*>/g, '');
    return box;
  }
  /** Загрузить данные экрана владелицы один раз, потом перерисовать. */
  // Данные экранов владелицы: в памяти и на телефоне. Открываем из них сразу, свежие подтягиваем в фоне (D36).
  function ocRead(key) {
    var c = store(OC_KEY);
    return c && c.uid === uid() && c.m ? c.m[key] : undefined;
  }
  function ocWrite(key, value) {
    var c = store(OC_KEY);
    var m = c && c.uid === uid() && c.m ? c.m : {};
    m[key] = value;
    var keys = Object.keys(m);
    if (keys.length > 14) delete m[keys[0]];
    store(OC_KEY, { uid: uid(), m: m });
  }
  function ocClear() { store(OC_KEY, null); }

  function ownerLoad(action, params, draw) {
    var f = state.form;
    if (f.data === undefined) {
      var okey = action + '|' + JSON.stringify(params || {});
      var seen = ocRead(okey);
      var fetchFresh = function () {
        return api(Object.assign({ action: action }, params || {})).then(function (d) {
          ocWrite(okey, d);
          if (f !== state.form) return; // владелица уже ушла на другой экран
          if (f.data === null || JSON.stringify(d) !== JSON.stringify(f.data)) { f.data = d; render(); countUpAll(app); }
        });
      };
      if (seen !== undefined) {
        f.data = seen;
        fetchFresh().catch(function () { /* связи нет — остаются прежние данные */ });
        draw(seen);
        return;
      }
      f.data = null;
      app.replaceChildren(ownerTabs(), skeleton(action === 'owner_today' || action === 'owner_period' ? 'cards' : 'list'));
      fetchFresh().catch(function (e) { f.data = undefined; app.replaceChildren(ownerTabs(), el('div', { class: 'error pad', text: e.message || 'Нет связи' })); });
      return;
    }
    if (f.data) draw(f.data);
  }

  /** Прогрев экранов владелицы сразу после входа: потом вкладки открываются без ожидания. */
  function prefetchOwner() {
    if (!state.data || state.data.me.role !== 'owner') return;
    ['owner_catalog', 'owner_shifts', 'owner_team'].forEach(function (a, i) {
      setTimeout(function () {
        var key = a + '|' + JSON.stringify(a === 'owner_shifts' ? {} : {});
        if (ocRead(key) !== undefined) return;
        api({ action: a }).then(function (d) { ocWrite(key, d); }).catch(function () {});
      }, 1500 + i * 1500);
    });
  }
  function kv(label, value, cls) {
    return el('div', { class: 'sum' }, [el('span', { class: 'muted', text: label }), el('span', { class: 'num ' + (cls || ''), text: value })]);
  }

  SCREENS.owner_today = function () {
    backButton(false);
    mainButton(null);
    ownerLoad('owner_today', {}, function (d) {
      var r = d.shift;
      var nodes = [ownerTabs()];
      if (d.alerts.length) nodes.push(el('div', { class: 'card card--note' }, d.alerts.map(function (a) { return el('div', { text: '⚠️ ' + a }); })));
      var y = d.yesterday;
      if (y && y.shifts) {
        var cleanY = y.all_closed && y.cash_diff === 0;
        nodes.push(el('div', { class: 'card' }, [
          el('div', { class: 'sum' }, [el('span', { class: 'script', style: 'font-size:24px', text: 'Вчера' }), numEl(y.revenue, true)]),
          el('div', { class: 'muted', text: 'чеков ' + y.receipts + ' · ' + (!y.all_closed ? 'смена не закрыта' : cleanY ? 'касса сошлась' : 'расхождение ' + money(y.cash_diff)) +
            (y.top_item ? ' · лучшая позиция — ' + y.top_item.name : '') }),
          el('button', { class: 'btn', onclick: function () {
            shareImage(function () { return drawDayCard(y, (d.shop && d.shop.name) || 'Флора·Учёт'); }, 'Карточка дня · ' + y.date.split('-').reverse().join('.'),
              'Карточка дня пришла вам в чат — её можно переслать');
          } }, [icon('sparkles'), 'Карточка дня картинкой'])
        ]));
      }
      if (!r) nodes.push(emptyState('Смена не открыта', 'Как только флорист откроет смену, здесь будут выручка и касса в реальном времени.'));
      else {
        nodes.push(el('div', { class: 'row' }, [el('h1', { class: 'h1', text: 'Смена №' + r.shift_no }), el('div', { class: 'muted', text: r.florists.join(', ') })]));
        nodes.push(el('div', { class: 'grid2' }, [
          el('div', { class: 'card card--accent' }, [el('div', { class: 'muted', text: 'Выручка' }), numEl(r.revenue, true),
            el('div', { class: 'muted', text: 'чеков: ' + r.receipts_count })]),
          el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'В кассе по расчёту' }), numEl(r.calc_cash, true),
            el('div', { class: 'muted num', text: 'безнал ' + money(r.card_total) })])
        ]));
        if (r.revenue) {
          nodes.push(el('div', { class: 'card' }, [donut([
            { label: 'Наличными', value: r.sales_cash, color: '#f07ca0' },
            { label: 'Безнал', value: r.sales_card, color: '#7fd0e0' },
            { label: 'В долг', value: r.sales_debt, color: '#ffd27a' },
            { label: 'Предзаказы к доплате', value: r.preorder_unpaid, color: '#c9b6ff' }
          ], shortMoney(r.revenue) + ' ₸', 'выручка')]));
        }
        nodes.push(controlCard(r.control));
        nodes.push(el('div', { class: 'card' }, [
          r.discounts ? kv('Скидки', money(r.discounts)) : null,
          kv('Расходы (доставка + прочее)', money(r.delivery + r.other)),
          r.withdrawal ? kv('Изъято', money(r.withdrawal)) : null,
          r.defects.length ? kv('Брак (по закупке)', money(r.defects.reduce(function (a, x) { return a + x.cost; }, 0)), 'copper') : null
        ]));
      }
      if (d.restock && d.restock.length) {
        nodes.push(el('div', { class: 'card' }, [el('div', { class: 'script', style: 'font-size:24px', text: 'Закупка на неделю' }),
          el('div', { class: 'muted', text: 'Продано за 7 дней + минимум − есть сейчас' })].concat(d.restock.slice(0, 8).map(function (x) {
          return el('div', { class: 'item' }, [el('div', { class: 'item__main' }, [
            el('div', { style: 'font-weight:600', text: x.name }),
            el('div', { class: 'muted num', style: 'font-size:13px', text: 'есть ' + x.stock + ' · мин. ' + x.min + (x.weekly ? ' · за неделю ' + x.weekly : '') })]),
            el('b', { class: 'num copper', text: '+' + x.buy })]);
        }))));
      } else if (d.below_min.length) {
        nodes.push(el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Ниже минимума' })].concat(d.below_min.map(function (b) {
          return kv(b.name, b.qty + ' / ' + b.min, 'copper');
        }))));
      }
      nodes.push(el('button', { class: 'btn', onclick: function () { state.form.data = undefined; render(); } }, ['Обновить']));
      app.replaceChildren.apply(app, nodes);
    });
  };

  SCREENS.owner_history = function () {
    backButton(false);
    mainButton(null);
    ownerLoad('owner_shifts', { limit: 60 }, function (list) {
      var nodes = [ownerTabs()];
      if (!list.length) nodes.push(emptyState('Смен пока нет', 'После первой закрытой смены здесь появятся отчёты и чеки.'));
      list.forEach(function (s) {
        var diff = s.cash_diff === null ? 'открыта' : s.cash_diff === 0 ? 'касса сошлась' : (s.cash_diff > 0 ? 'излишек ' : 'недостача ') + money(Math.abs(s.cash_diff));
        nodes.push(el('button', { class: 'btn', style: 'text-align:left', onclick: function () { openScreen('owner_shift', { shift_id: s.shift_id }); } }, [
          el('div', { class: 'sum' }, [el('b', { text: '№' + s.shift_no + ' · ' + s.shift_date.slice(8, 10) + '.' + s.shift_date.slice(5, 7) + (s.corrected ? ' · исправлено' : '') }),
            el('span', { class: 'num', text: money(s.revenue) })]),
          el('div', { class: 'muted', text: s.florists.join(', ') + ' · чеков ' + s.receipts + ' · ' + diff })
        ]));
      });
      app.replaceChildren.apply(app, nodes);
    });
  };

  /** Контроль смены: что владелице стоит глянуть (D28). */
  function controlCard(c) {
    if (!c) return null;
    var head = el('div', { class: 'script', style: 'font-size:22px', text: 'Контроль' });
    if (c.clean) return el('div', { class: 'card' }, [head, el('div', { class: 'muted', text: 'Замечаний нет' })]);
    var rows = c.items.slice(0, 12).map(function (i) { return el('div', { class: 'ctl ctl--' + i.kind, text: i.text }); });
    if (c.items.length > 12) rows.push(el('div', { class: 'muted', text: '…и ещё ' + (c.items.length - 12) }));
    return el('div', { class: 'card card--note' }, [head].concat(rows));
  }

  // ---------- владелица: Управление (D29) ----------

  SCREENS.owner_manage = function () {
    backButton(false);
    mainButton(null);
    var f = state.form;
    var tile = function (ic, label, sub, screen) {
      return el('button', { class: 'card btn--tile', style: 'font:inherit;color:inherit;cursor:pointer;text-align:left', onclick: function () { openScreen(screen); } },
        [icon(ic), el('b', { text: label }), el('div', { class: 'muted', text: sub })]);
    };
    var head = function (t) { return el('div', { class: 'script', style: 'font-size:22px;margin-top:6px', text: t }); };
    var nodes = [
      el('h1', { class: 'h1', text: 'Ещё' }),
      head('Люди'),
      el('div', { class: 'grid2' }, [
        tile('users', 'Сотрудники', 'ставки, приглашения', 'owner_team'),
        tile('calendar-event', 'График смен', 'кто когда работает', 'schedule'),
        tile('user-star', 'Я в смене', 'моя оплата и выход', 'owner_work')
      ]),
      head('Деньги и заказы'),
      el('div', { class: 'grid2' }, [
        tile('receipt', 'Расходы месяца', 'аренда, интернет, налоги', 'owner_expenses'),
        tile('calendar-heart', 'Предзаказы', 'список и отмена', 'owner_preorders'),
        tile('users', 'Должники', 'кто сколько должен', 'owner_debtors')
      ]),
      head('Настройки'),
      el('div', { class: 'grid2' }, [
        tile('adjustments', 'Настройки', 'размен, напоминание', 'owner_settings')
      ]),
      liteToggle(),
      el('button', { class: 'btn', onclick: function () { f.launch = !f.launch; render(); } }, [icon(f.launch ? 'chevron-up' : 'chevron-down'), 'Запуск магазина (один раз)'])
    ];
    if (f.launch) {
      nodes.push(el('div', { class: 'muted center', text: 'Нужно только при первом запуске. Каталог и остатки удобнее вносить на вкладке «Склад».' }));
      nodes.push(el('div', { class: 'grid2' }, [
        tile('clipboard-list', 'Начальные остатки', 'для позиций без остатка', 'owner_start_stock'),
        tile('user-dollar', 'Долги с прошлого', 'из тетради', 'owner_start_debt')
      ]));
    }
    app.replaceChildren.apply(app, nodes);
  };

  var TYPICAL = {
    flowers: ['Роза красная 60 см', 'Роза белая 60 см', 'Роза кустовая', 'Тюльпан', 'Пион', 'Хризантема кустовая', 'Гвоздика', 'Лилия', 'Ирис', 'Гербера', 'Подсолнух', 'Альстромерия', 'Эустома', 'Ранункулюс', 'Орхидея'],
    greens: ['Эвкалипт', 'Гипсофила', 'Рускус', 'Салал', 'Папоротник', 'Питоспорум'],
    packaging: ['Крафт-бумага', 'Плёнка', 'Лента атласная', 'Сетка флористическая', 'Коробка для цветов', 'Открытка'],
    toys: ['Мишка мягкий', 'Шарики'],
    baskets: ['Корзина плетёная', 'Кашпо']
  };
  var DRAFT_KEY = 'flora.draft.cat';
  function draftGet() { var d = store(DRAFT_KEY); return d && d.uid === uid() && Array.isArray(d.rows) ? d.rows : []; }
  function draftSet(rows) { store(DRAFT_KEY, rows.length ? { uid: uid(), rows: rows } : null); }
  function draftRow(cat, name) { return { id: 'r' + Math.random().toString(36).slice(2, 9), cat: cat, name: name || '', price: '', qty: '', cost: '' }; }
  /** Состояние строки черновика: пустая / верная / с ошибкой (и что именно не так). */
  function draftCheck(r) {
    var any = r.name.trim() || String(r.price).trim() || String(r.qty).trim() || String(r.cost).trim();
    if (!any) return { empty: true };
    if (!r.name.trim()) return { bad: 'нет названия' };
    if (!(intOf(r.price) > 0)) return { bad: 'впишите цену' };
    if (String(r.qty).trim() && intOf(r.qty) === null) return { bad: 'остаток — число' };
    if (String(r.cost).trim() && intOf(r.cost) === null) return { bad: 'закупка — число' };
    return { ok: true };
  }

  SCREENS.owner_catalog = function () {
    backButton(false);
    mainButton(null);
    var f = state.form;
    if (f.cat === undefined) f.cat = 'all';
    if (f.q === undefined) f.q = '';
    if (f.mode === undefined) f.mode = 'list';
    ownerLoad('owner_catalog', {}, function (list) {
      var draftCount = draftGet().filter(function (r) { return !draftCheck(r).empty; }).length;
      var modes = el('div', { class: 'chips' }, [['list', 'Список'], ['add', 'Добавить' + (draftCount ? ' · ' + draftCount : '')]].map(function (m) {
        return el('button', { class: 'chip', 'aria-pressed': String(f.mode === m[0]), onclick: function () { f.mode = m[0]; render(); } }, [m[1]]);
      }));
      if (f.mode === 'add') { drawCatalogAdd(f, list, modes); return; }
      mainButton(null);
      var q = f.q.trim().toLowerCase();
      var shown = list.filter(function (c) {
        if (q && c.name.toLowerCase().indexOf(q) < 0) return false;
        if (f.cat === 'hidden') return c.status === 'hidden';
        if (c.status === 'hidden') return false;
        return f.cat === 'all' || c.category === f.cat;
      });
      var hiddenCount = list.filter(function (c) { return c.status === 'hidden'; }).length;
      var cats = [['all', 'Все']].concat(Object.keys(CATS).filter(function (k) { return list.some(function (c) { return c.category === k && c.status !== 'hidden'; }); })
        .map(function (k) { return [k, CATS[k]]; }));
      if (hiddenCount) cats.push(['hidden', 'Скрытые · ' + hiddenCount]);
      var rows = shown.map(function (c) {
        var low = c.status !== 'hidden' && c.stock < c.min;
        return el('button', { class: 'card', style: 'font:inherit;color:inherit;cursor:pointer;text-align:left;display:block;width:100%',
          onclick: function () { openScreen('owner_item', { item: c }); } }, [
          el('div', { class: 'sum' }, [el('b', { text: c.name }), el('span', { class: 'num', text: money(c.price) })]),
          el('div', { class: 'muted num', text: 'остаток ' + c.stock + (c.min ? ' · минимум ' + c.min : '') + (c.cost ? ' · закупка ' + money(c.cost) : '') +
            (c.status === 'review' ? ' · новое, на проверке' : '') + (low ? ' · мало' : '') })
        ]);
      });
      var search = el('input', { class: 'input', type: 'search', placeholder: 'Поиск позиции', value: f.q, 'aria-label': 'Поиск', oninput: function (e) { f.q = e.target.value; render(); } });
      app.replaceChildren.apply(app, [
        el('h1', { class: 'h1', text: 'Склад' }),
        modes,
        list.length ? search : null,
        list.length ? chips(cats, f.cat, function (k) { f.cat = k; render(); }) : null
      ].concat(rows.length ? rows : [emptyState(list.length ? 'Ничего не найдено' : 'Склад пока пуст', list.length ? 'Измените поиск или категорию' : 'Нажмите «Добавить» и внесите позиции строками.',
        list.length ? null : { label: 'Добавить позиции', onclick: function () { f.mode = 'add'; render(); } })]));
    });
  };

  /** Режим «Добавить»: таблица-черновик, строки по категориям, всё сохраняется одной кнопкой. */
  function drawCatalogAdd(f, list, modes) {
    var rows = draftGet();
    var save = function (confirmDups) {
      var groups = {};
      rows.forEach(function (r) {
        if (!draftCheck(r).ok) return;
        (groups[r.cat] = groups[r.cat] || []).push({ name: r.name.trim(), sale_price: intOf(r.price), qty: intOf(r.qty) || 0, cost: intOf(r.cost) || 0 });
      });
      var payload = { groups: Object.keys(groups).map(function (k) { return { category: k, lines: groups[k] }; }), confirm_dups: confirmDups === true };
      busy(postOp('catalog_import', payload, f.op_id).catch(function (e) {
        if (e && e.code === 'SIMILAR_ITEMS') { f.dups = (e.details || []).map(function (d) { return d.name; }); return null; }
        throw e;
      })).then(function (res) {
        if (!res) { if (f.dups) { toast('Такие названия уже есть. Если это новые позиции — нажмите «Сохранить» ещё раз.', true); f.confirmDups = true; render(); } return; }
        draftSet([]); ocClear();
        if (res.state) setData(res.state, true);
        haptic('success'); toast('Позиций сохранено: ' + payload.groups.reduce(function (a, g) { return a + g.lines.length; }, 0));
        openScreen('owner_catalog');
      });
    };
    var upd = function () {
      var valid = 0, bad = 0;
      rows.forEach(function (r) { var c = draftCheck(r); if (c.ok) valid++; else if (c.bad) bad++; });
      mainButton(state.sending ? 'Сохраняем…' : 'Сохранить ' + valid + ' ' + positionsWord(valid), valid > 0 && !bad && !state.sending, function () {
        var withStock = rows.filter(function (r) { return draftCheck(r).ok && intOf(r.qty) > 0; }).length;
        askOk('Сохранить ' + valid + ' ' + positionsWord(valid) + (withStock ? ', с остатком: ' + withStock : '') + '?', function () { save(f.confirmDups === true); });
      });
    };
    var rowCard = function (r) {
      var card = el('div', { class: 'dr', 'data-id': r.id });
      var mark = function () { var c = draftCheck(r); card.classList.toggle('dr--bad', !!c.bad); var note = card.querySelector('.dr__note'); if (note) note.textContent = c.bad ? c.bad : ''; };
      var field = function (label, key, numeric) {
        var inp = el('input', { class: 'input' + (numeric ? ' num' : ''), inputmode: numeric ? 'numeric' : 'text', enterkeyhint: 'next', 'aria-label': label, placeholder: numeric ? '0' : '', value: r[key] });
        inp.addEventListener('input', function () { r[key] = inp.value; draftSet(rows); mark(); upd(); });
        return el('label', { class: 'dr__f' }, [el('span', { text: label }), inp]);
      };
      var name = el('input', { class: 'input', 'aria-label': 'Название', placeholder: 'Название, например: Пион розовый', enterkeyhint: 'next', maxlength: '80', value: r.name });
      name.addEventListener('input', function () { r.name = name.value; draftSet(rows); mark(); upd(); });
      var del = el('button', { class: 'dr__x', type: 'button', 'aria-label': 'Убрать строку' }, [icon('x')]);
      del.addEventListener('click', function () { rows = rows.filter(function (x) { return x.id !== r.id; }); draftSet(rows); render(); });
      card.appendChild(el('div', { class: 'dr__top' }, [name, del]));
      card.appendChild(el('div', { class: 'dr__nums' }, [field('Цена ₸', 'price', true), field('Остаток', 'qty', true), field('Закупка', 'cost', true)]));
      card.appendChild(el('div', { class: 'dr__note muted' }));
      mark();
      return card;
    };
    var nodes = [el('h1', { class: 'h1', text: 'Склад' }), modes,
      el('div', { class: 'muted', text: 'Внесите позиции строками. Обязательны название и цена; остаток и закупку можно не знать. Черновик не пропадёт, если закроете кассу.' }),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', onclick: function () { openScreen('owner_typical'); } }, [icon('list-check'), 'Выбрать из типовых']),
        el('button', { class: 'btn', onclick: function () { openScreen('owner_import'); } }, [icon('clipboard-text'), 'Вставить текстом'])
      ])];
    Object.keys(CATS).forEach(function (cat) {
      var mine = rows.filter(function (r) { return r.cat === cat; });
      if (!mine.length) return;
      nodes.push(el('div', { class: 'script', style: 'font-size:22px', text: CATS[cat] }));
      mine.forEach(function (r) { nodes.push(rowCard(r)); });
    });
    nodes.push(el('div', { class: 'muted', text: 'Добавить строку в категорию:' }));
    nodes.push(el('div', { class: 'chips' }, Object.keys(CATS).map(function (cat) {
      return el('button', { class: 'chip', onclick: function () {
        var r = draftRow(cat); rows.push(r); draftSet(rows); render();
        setTimeout(function () { var inp = document.querySelector('.dr[data-id="' + r.id + '"] input'); if (inp) inp.focus(); }, 60);
      } }, ['+ ' + CATS[cat]]);
    })));
    if (f.dups && f.dups.length) nodes.push(el('div', { class: 'card card--note' }, [el('div', { text: 'Эти названия уже есть: ' + f.dups.slice(0, 5).join(', ') }),
      el('div', { class: 'muted', text: 'Если это другие позиции — нажмите «Сохранить» ещё раз.' })]));
    app.replaceChildren.apply(app, nodes);
    upd();
  }

  /** Типовые позиции: отметьте, что у вас есть, — они добавятся строками в черновик, цены впишете потом. */
  SCREENS.owner_typical = function () {
    backButton(true);
    var f = state.form;
    if (!f.sel) f.sel = {};
    ownerLoad('owner_catalog', {}, function (list) {
      var have = {};
      list.forEach(function (c) { have[c.name.toLowerCase()] = true; });
      draftGet().forEach(function (r) { have[r.name.trim().toLowerCase()] = true; });
      var count = function () { return Object.keys(f.sel).filter(function (k) { return f.sel[k]; }).length; };
      mainButton(state.sending ? '…' : 'Добавить выбранные (' + count() + ')', count() > 0, function () {
        var rows = draftGet();
        Object.keys(TYPICAL).forEach(function (cat) {
          TYPICAL[cat].forEach(function (n) { if (f.sel[cat + '|' + n]) rows.push(draftRow(cat, n)); });
        });
        draftSet(rows);
        openScreen('owner_catalog', { mode: 'add' });
      });
      var nodes = [title('Типовые позиции', 'Отметьте то, что у вас есть. Цены и остатки впишете на следующем шаге.')];
      Object.keys(TYPICAL).forEach(function (cat) {
        var names = TYPICAL[cat].filter(function (n) { return !have[n.toLowerCase()]; });
        if (!names.length) return;
        nodes.push(el('div', { class: 'script', style: 'font-size:22px', text: CATS[cat] }));
        nodes.push(el('div', { class: 'chips' }, names.map(function (n) {
          var key = cat + '|' + n;
          return el('button', { class: 'chip', 'aria-pressed': String(!!f.sel[key]), onclick: function () { f.sel[key] = !f.sel[key]; render(); } }, [n]);
        })));
      });
      app.replaceChildren.apply(app, nodes);
    });
  };

  // ---------- открытие смены (флорист) ----------

  SCREENS.open = function () {
    backButton(true);
    var f = state.form;
    var info = state.data.open_info;
    if (!info) { state.screen = 'main'; render(); return; }
    if (f.cash === undefined) { f.cash = info.first ? '' : String(info.prev_cash); f.partner = ''; }
    function upd() {
      var cash = intOf(f.cash);
      var diff = cash === null || info.first ? null : cash - info.prev_cash;
      var note = document.getElementById('open-diff');
      if (note) note.textContent = diff ? 'Расхождение с тем, что оставила прошлая смена: ' + (diff > 0 ? '+' : '−') + money(Math.abs(diff)) + '. Владелица получит сообщение.' : '';
      mainButton(state.sending ? 'Открываем…' : 'Открыть смену', cash !== null && !state.sending, function () {
        var ids = f.partner ? ['', f.partner] : ['']; // пустое место — сам флорист, его ID подставит сервер
        submitOp('open_shift', { florist_ids: ids, open_cash: cash }, 'Смена открыта', function () { state.screen = 'main'; render(); });
      });
    }
    app.replaceChildren(
      title(info.first ? 'Первая смена магазина' : 'Открытие смены', info.first ? 'Пересчитайте деньги в кассе: эта сумма станет стартовой' : 'Прошлая смена оставила в кассе ' + money(info.prev_cash) + ' (размен внутри)'),
      formField('Сколько наличных в кассе сейчас, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.cash, oninput: function (e) { f.cash = e.target.value; upd(); } }),
        'Пересчитайте деньги. Если сумма другая — впишите её, владелица увидит расхождение.'),
      el('div', { id: 'open-diff', class: 'muted', style: 'min-height:18px' }),
      el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Кто работает в смене' }),
        chips([['', 'Только я']].concat(info.partners.map(function (p) { return [p.staff_id, 'Со мной ' + p.name]; })), f.partner, function (k) { f.partner = k; render(); })])
    );
    upd();
  };

  // ---------- владелица: предзаказы и отмена (D24) ----------

  SCREENS.owner_preorders = function () {
    backButton(true);
    mainButton(null);
    var list = state.data.preorders || [];
    var rows = list.map(function (p) {
      return el('button', { class: 'card', style: 'font:inherit;color:inherit;cursor:pointer;text-align:left;display:block;width:100%',
        onclick: function () { openScreen('owner_preorder', { p: p }); } }, [
        el('div', { class: 'sum' }, [el('b', { text: p.pickup_date.slice(8, 10) + '.' + p.pickup_date.slice(5, 7) + ' · ' + (p.customer || 'без имени') }), el('span', { class: 'num', text: money(p.total) })]),
        el('div', { class: 'muted num', text: (p.assembly_status === 'assembled' ? 'собран' : 'не собран') + ' · внесено ' + money(p.paid) + ' · к доплате ' + money(Math.max(0, p.unpaid)) })
      ]);
    });
    app.replaceChildren.apply(app, [title('Предзаказы', 'Нажмите на заказ, чтобы отменить')]
      .concat(rows.length ? rows : [emptyState('Активных предзаказов нет', 'Новые предзаказы оформляет флорист.')]));
  };

  SCREENS.owner_preorder = function () {
    backButton(true);
    var f = state.form;
    var p = f.p;
    if (!p) { openScreen('owner_preorders'); return; }
    var shiftOpen = !!(state.data.shift);
    if (f.refund === undefined) { f.refund = p.paid > 0 ? (shiftOpen ? 'cash' : 'card') : 'keep'; f.stock = p.assembly_status === 'assembled' ? '1' : '0'; f.reason = ''; }
    function upd() {
      var ok = f.reason.trim().length >= 3;
      mainButton(state.sending ? 'Отменяем…' : 'Отменить предзаказ', ok && !state.sending, function () {
        askOk('Отменить предзаказ ' + (p.customer || '') + ' на ' + money(p.total) + '?', function () {
          var payload = { receipt_id: p.receipt_id, reason: f.reason.trim(), return_stock: f.stock === '1' && p.assembly_status === 'assembled' };
          if (f.refund !== 'keep' && p.paid > 0) payload.refund = { method: f.refund, amount: p.paid };
          submitOp('preorder_cancel', payload, 'Предзаказ отменён', function () { openScreen('owner_preorders'); });
        });
      });
    }
    var nodes = [title((p.customer || 'Предзаказ') + ' · ' + money(p.total), 'Внесено ' + money(p.paid) + ' · ' + (p.assembly_status === 'assembled' ? 'букет собран' : 'не собран'))];
    if (p.paid > 0) {
      var opts = [];
      if (shiftOpen) opts.push(['cash', 'Вернуть ' + money(p.paid) + ' наличными из кассы']);
      opts.push(['card', 'Вернуть ' + money(p.paid) + ' на карту'], ['keep', 'Аванс остаётся магазину']);
      nodes.push(el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Что с авансом' }), chips(opts, f.refund, function (k) { f.refund = k; render(); })]));
    }
    if (p.assembly_status === 'assembled') {
      nodes.push(el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Собранный букет' }),
        chips([['1', 'Вернуть цветы на склад'], ['0', 'Не возвращать (списан)']], f.stock, function (k) { f.stock = k; render(); })]));
    }
    nodes.push(formField('Причина отмены', el('input', { class: 'input', value: f.reason, maxlength: '200', placeholder: 'например: клиент передумал', oninput: function (e) { f.reason = e.target.value; upd(); } })));
    app.replaceChildren.apply(app, nodes);
    upd();
  };

  // ---------- запуск: начальные остатки и старые долги (владелица) ----------

  SCREENS.owner_start_stock = function () {
    backButton(true);
    var f = state.form;
    ownerLoad('owner_catalog', {}, function (list) {
      var items = list.filter(function (c) { return c.status !== 'hidden'; });
      if (!f.qty) f.qty = {};
      var lines = function () {
        return items.map(function (c) { return { item_id: c.item_id, qty: intOf(f.qty[c.item_id]) }; }).filter(function (l) { return l.qty > 0; });
      };
      var upd = function () {
        var n = lines().length;
        mainButton(state.sending ? 'Вносим…' : 'Внести остатки' + (n ? ' (' + n + ')' : ''), n > 0 && !state.sending, function () {
          askOk('Внести начальные остатки по ' + n + ' позициям? Это нужно делать один раз, до первой смены.', function () {
            submitOp('stock_start', { lines: lines() }, 'Начальные остатки внесены', function () { openScreen('owner_manage'); });
          });
        });
      };
      var rows = items.map(function (c) {
        return el('div', { class: 'sum' }, [
          el('div', {}, [el('div', { text: c.name }), el('div', { class: 'muted num', text: 'сейчас на складе ' + c.stock })]),
          el('input', { class: 'input num', style: 'max-width:110px', inputmode: 'numeric', placeholder: '0', value: f.qty[c.item_id] || '',
            'aria-label': 'Сколько внести: ' + c.name, oninput: function (e) { f.qty[c.item_id] = e.target.value; upd(); } })
        ]);
      });
      app.replaceChildren.apply(app, [
        title('Начальные остатки', 'Сколько чего лежит на складе перед запуском. Внесите цифры по пересчёту.'),
        el('div', { class: 'card card--note' }, [el('div', { text: 'Вносится только когда смена закрыта. Число прибавляется к текущему остатку, поэтому внесите один раз.' })]),
        el('div', { class: 'card' }, rows.length ? rows : [el('div', { class: 'muted', text: 'Каталог пуст. Сначала добавьте позиции: «Склад и каталог».' })])
      ]);
      upd();
    });
  };

  SCREENS.owner_start_debt = function () {
    backButton(true);
    var f = state.form;
    if (f.mode === undefined) { f.mode = 'new'; f.name = ''; f.customer = ''; f.amount = ''; f.since = ''; f.comment = ''; }
    var debtors = (state.data.customers || []);
    var amount = intOf(f.amount);
    var today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    var who = f.mode === 'new' ? f.name.trim().length > 0 : !!f.customer;
    var datePast = /^\d{4}-\d{2}-\d{2}$/.test(f.since) && f.since <= today;
    var upd = function () {
      amount = intOf(f.amount);
      who = f.mode === 'new' ? f.name.trim().length > 0 : !!f.customer;
      datePast = /^\d{4}-\d{2}-\d{2}$/.test(f.since) && f.since <= today;
      mainButton(state.sending ? 'Записываем…' : 'Записать долг' + (amount ? ' ' + money(amount) : ''), who && !!amount && datePast && !state.sending, function () {
        var customer = f.mode === 'new' ? { new_customer: { name: f.name.trim(), confirm_new: f.confirmNew === true } } : { customer_id: f.customer };
        var payload = { customer: customer, amount: amount, since_date: f.since, comment: f.comment.trim() };
        busy(postOp('debt_opening', payload, f.op_id).catch(function (e) {
          if (e && e.code === 'SIMILAR_CUSTOMERS') { f.similar = true; toast('Покупатель с таким именем уже есть. Выберите его из списка или нажмите «Записать» ещё раз, если это другой человек.', true); return null; }
          throw e;
        })).then(function (res) {
          if (res === null || res === undefined) { if (f.similar) { f.confirmNew = true; } return; }
          if (res.state) setData(res.state, true);
          haptic('success'); toast('Долг записан');
          openScreen('owner_start_debt');
        });
      });
    };
    app.replaceChildren(
      title('Долги с прошлого', 'Кто сколько должен по тетради. Записывается один раз на запуске.'),
      chips([['new', 'Новый покупатель'], ['old', 'Уже есть в кассе']], f.mode, function (k) { f.mode = k; f.similar = false; render(); }),
      f.mode === 'new'
        ? formField('Имя покупателя', el('input', { class: 'input', value: f.name, maxlength: '60', oninput: function (e) { f.name = e.target.value; f.confirmNew = false; upd(); } }))
        : formField('Покупатель', (function () {
          var sel = el('select', { class: 'input', 'aria-label': 'Покупатель', onchange: function (e) { f.customer = e.target.value; upd(); } },
            [el('option', { value: '', text: 'Выберите…' })].concat(debtors.map(function (c) { return el('option', { value: c.customer_id, text: c.name + (c.debt ? ' · долг ' + money(c.debt) : '') }); })));
          sel.value = f.customer; return sel; })()),
      formField('Сумма долга, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.amount, oninput: function (e) { f.amount = e.target.value; upd(); } })),
      formField('Долг с даты', el('input', { class: 'input', type: 'date', max: today, value: f.since, oninput: function (e) { f.since = e.target.value; upd(); } }),
        'Нужна, чтобы видеть, какие долги старше 30 дней.'),
      formField('Комментарий (по желанию)', el('input', { class: 'input', value: f.comment, maxlength: '200', oninput: function (e) { f.comment = e.target.value; } }))
    );
    upd();
  };

  // ---------- график смен (D31) ----------

  var WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  function dayLabel(iso) {
    var today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    var tomorrow = new Date(Date.now() + 29 * 3600000).toISOString().slice(0, 10);
    var d = new Date(iso + 'T00:00:00Z');
    var base = WEEKDAYS[d.getUTCDay()] + ', ' + iso.slice(8, 10) + '.' + iso.slice(5, 7);
    return iso === today ? 'сегодня (' + base + ')' : iso === tomorrow ? 'завтра (' + base + ')' : base;
  }

  SCREENS.schedule = function () {
    backButton(true);
    mainButton(null);
    var f = state.form;
    if (f.month === undefined) f.month = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7);
    var go = function (delta) { return function () { f.month = shiftMonth(f.month, delta); f.data = undefined; render(); }; };
    var today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    var draw = function (d) {
      var byDate = {};
      d.entries.forEach(function (e) { (byDate[e.date] = byDate[e.date] || []).push(e); });
      var y = Number(f.month.slice(0, 4)), m = Number(f.month.slice(5, 7));
      var first = new Date(Date.UTC(y, m - 1, 1));
      var lead = (first.getUTCDay() + 6) % 7; // понедельник — первый
      var days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      var cells = [];
      ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'].forEach(function (w) { cells.push(el('div', { class: 'sch__wd', text: w })); });
      for (var i = 0; i < lead; i++) cells.push(el('div', { class: 'sch__cell sch__cell--empty' }));
      for (var day = 1; day <= days; day++) {
        var iso = f.month + '-' + String(day).padStart(2, '0');
        var list = byDate[iso] || [];
        var cls = 'sch__cell' + (iso === today ? ' sch__cell--today' : '') + (list.some(function (e) { return e.me; }) ? ' sch__cell--me' : '');
        var attrs = { class: cls, 'aria-label': iso };
        if (d.can_edit) { attrs.onclick = (function (iso2) { return function () { openScreen('owner_day', { date: iso2, month: f.month }); }; })(iso); }
        cells.push(el(d.can_edit ? 'button' : 'div', attrs, [el('b', { text: String(day) })].concat(list.slice(0, 2).map(function (e) { return el('span', { class: 'sch__who', text: firstName(e.name).slice(0, 6) }); }))));
      }
      var upcoming = d.entries.filter(function (e) { return e.date >= today; });
      var seen = {};
      var lines = upcoming.filter(function (e) { return e.me; }).slice(0, 4).map(function (e) {
        var others = upcoming.filter(function (x) { return x.date === e.date && !x.me; }).map(function (x) { return x.name; });
        return el('div', { class: 'sum' }, [el('span', { text: dayLabel(e.date) }), el('span', { class: 'muted', text: others.length ? 'с ' + others.join(' и ') : '' })]);
      });
      app.replaceChildren.apply(app, [
        el('h1', { class: 'h1', text: 'График смен' }),
        el('div', { class: 'row' }, [
          el('button', { class: 'chip', onclick: go(-1), 'aria-label': 'Прошлый месяц' }, [icon('chevron-left')]),
          el('b', { text: MONTHS[m - 1] + ' ' + y }),
          el('button', { class: 'chip', onclick: go(1), 'aria-label': 'Следующий месяц' }, [icon('chevron-right')])
        ]),
        el('div', { class: 'sch' }, cells),
        d.can_edit ? el('div', { class: 'muted center', text: 'Нажмите на день, чтобы выбрать, кто работает. График — просто памятка: он никого не ограничивает.' })
          : el('div', { class: 'muted center', text: 'График ставит владелица. Он только напоминает и никого не ограничивает.' })
      ].concat(lines.length ? [el('div', { class: 'card' }, [el('div', { class: 'script', style: 'font-size:22px', text: 'Ваши смены' })].concat(lines))] : []));
    };
    if (f.data === undefined) {
      f.data = null;
      app.replaceChildren(el('h1', { class: 'h1', text: 'График смен' }), skeleton('list'));
      api({ action: 'schedule', month: f.month }).then(function (d) { f.data = d; render(); })
        .catch(function (e) { f.data = undefined; app.replaceChildren(el('div', { class: 'error pad', text: e.message || 'Нет связи' })); });
      return;
    }
    if (f.data) draw(f.data);
  };

  SCREENS.owner_day = function () {
    backButton(true);
    var f = state.form;
    if (f.sel === undefined) {
      f.sel = null; f.note = '';
      app.replaceChildren(title(dayLabel(f.date), 'Кто работает в этот день'), skeleton('list'));
      mainButton(null);
      api({ action: 'schedule', month: f.date.slice(0, 7) }).then(function (d) {
        f.people = d.people;
        f.sel = d.entries.filter(function (e) { return e.date === f.date; }).map(function (e) { return e.staff_id; });
        var n = d.entries.filter(function (e) { return e.date === f.date && e.note; })[0];
        f.note = n ? n.note : '';
        render();
      }).catch(function (e) { f.sel = undefined; toast(e.message || 'Нет связи', true); });
      return;
    }
    function upd() {
      mainButton(state.sending ? 'Сохраняем…' : 'Сохранить день', !state.sending, function () {
        submitOp('schedule_set', { date: f.date, staff_ids: f.sel, note: f.note.trim() }, 'График сохранён', function () { openScreen('schedule', { month: f.month }); });
      });
    }
    var toggle = function (id) {
      var i = f.sel.indexOf(id);
      if (i >= 0) f.sel.splice(i, 1);
      else if (f.sel.length >= 2) { toast('В смене не больше двух человек', true); return; }
      else f.sel.push(id);
      render();
    };
    app.replaceChildren(
      title(dayLabel(f.date), 'Кто работает в этот день'),
      el('div', { class: 'card' }, [el('div', { class: 'chips' }, f.people.map(function (p) {
        return el('button', { class: 'chip', 'aria-pressed': String(f.sel.indexOf(p.staff_id) >= 0), onclick: function () { toggle(p.staff_id); } }, [p.name + (p.role === 'owner' ? ' (вы)' : '')]);
      }))]),
      formField('Пометка (по желанию)', el('input', { class: 'input', value: f.note, maxlength: '100', placeholder: 'например: приём товара утром', oninput: function (e) { f.note = e.target.value; } })),
      el('div', { class: 'muted center', text: 'Если никого не выбрать, день станет пустым.' })
    );
    upd();
  };

  // ---------- владелица выходит в смену (D32) ----------

  SCREENS.owner_work = function () {
    backButton(true);
    var f = state.form;
    var w = state.data.owner_work || { works: false, shift_rate: 0, pct_bp: 0 };
    if (f.kind === undefined) {
      f.kind = w.works && (w.shift_rate > 0 || w.pct_bp > 0) ? 'paid' : 'none';
      f.rate = w.shift_rate ? String(w.shift_rate) : '';
      f.pct = w.pct_bp ? String(w.pct_bp / 100).replace('.', ',') : '';
    }
    var rate = f.kind === 'paid' ? intOf(f.rate) : 0;
    var bp = f.kind === 'paid' ? pctBp(f.pct) : 0;
    var valid = rate !== null && bp !== null && (f.kind === 'none' || rate > 0 || bp > 0);
    mainButton(state.sending ? 'Сохраняем…' : (w.works ? 'Сохранить' : 'Выходить в смену'), valid && !state.sending, function () {
      submitOp('owner_work_set', { enabled: true, shift_rate: rate, pct_bp: bp }, w.works ? 'Сохранено' : 'Готово: кнопка «Я в смене» вверху', function () {
        state.mode = 'shift'; state.screen = 'main'; render();
      });
    });
    app.replaceChildren(
      title('Вы работаете в смене сами?', 'Тогда касса покажет вам экраны флориста: продажи, приход, закрытие смены. Переключаться можно кнопкой вверху.'),
      el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Как считать вашу оплату за смену' }),
        chips([['none', 'Без оплаты'], ['paid', 'Ставка и процент']], f.kind, function (k) { f.kind = k; render(); })]),
      f.kind === 'paid' ? formField('Ставка за смену, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.rate, oninput: function (e) { f.rate = e.target.value; render(); } })) : null,
      f.kind === 'paid' ? formField('Процент от выручки, %', el('input', { class: 'input num', inputmode: 'decimal', value: f.pct, placeholder: 'например 3 или 2,5', oninput: function (e) { f.pct = e.target.value; render(); } }),
        'Если процента нет, процент напарника не делится на вас.') : el('div', { class: 'muted center', text: 'Без оплаты: вы не получаете ставку и процент, а процент напарника не уменьшается.' }),
      w.works ? el('button', { class: 'btn btn--close', disabled: state.sending, onclick: function () {
        askOk('Больше не выходить в смену сами?', function () {
          submitOp('owner_work_set', { enabled: false }, 'Режим смены выключен', function () { state.mode = 'owner'; openScreen('owner_manage'); });
        });
      } }, [icon('user-off'), 'Больше не выхожу в смену']) : null
    );
  };

  // ---------- загрузка каталога списком (D33) ----------

  /** Разбор вставленного текста: название; цена; остаток; закупка; минимум (разделитель — «;» или табуляция из Excel). */
  function positionsWord(n) {
    var m = n % 100, d = n % 10;
    return m > 10 && m < 20 ? 'позиций' : d === 1 ? 'позицию' : d > 1 && d < 5 ? 'позиции' : 'позиций';
  }
  function parseImport(text) {
    var out = { ok: [], bad: [] };
    String(text || '').split(/\r?\n/).forEach(function (raw, i) {
      var line = raw.trim();
      if (!line) return;
      var parts = line.split(/[;\t]/).map(function (x) { return x.trim(); });
      var name = parts[0];
      var price = intOf(parts[1]);
      var opt = function (v) { return v === undefined || v === '' ? 0 : intOf(v); };
      var qty = opt(parts[2]), cost = opt(parts[3]), min = opt(parts[4]);
      if (!name || name.length > 80) out.bad.push('Строка ' + (i + 1) + ': нет названия');
      else if (!price || price <= 0) out.bad.push('Строка ' + (i + 1) + ' («' + name.slice(0, 20) + '»): цена должна быть числом больше нуля');
      else if (qty === null || cost === null || min === null) out.bad.push('Строка ' + (i + 1) + ' («' + name.slice(0, 20) + '»): остаток, закупка и минимум — числа');
      else out.ok.push({ name: name, sale_price: price, qty: qty, cost: cost, min_stock: min });
    });
    return out;
  }

  SCREENS.owner_import = function () {
    backButton(true);
    var f = state.form;
    if (f.text === undefined) { f.text = ''; f.category = 'flowers'; }
    var parsed = parseImport(f.text);
    var withStock = parsed.ok.filter(function (r) { return r.qty > 0; }).length;
    var send = function () {
      busy(postOp('catalog_import', { category: f.category, lines: parsed.ok, confirm_dups: f.confirm === true }, f.op_id).catch(function (e) {
        if (e && e.code === 'SIMILAR_ITEMS') { f.dups = (e.details || []).map(function (d) { return d.name; }); f.confirm = true; return null; }
        throw e;
      })).then(function (res) {
        if (!res) { if (f.dups) { toast('Такие названия уже есть. Проверьте список. Если это новые позиции — нажмите кнопку ещё раз.', true); render(); } return; }
        if (res.state) setData(res.state, true);
        haptic('success'); toast('Загружено позиций: ' + parsed.ok.length);
        openScreen('owner_catalog');
      });
    };
    mainButton(state.sending ? 'Загружаем…' : 'Загрузить ' + parsed.ok.length + ' ' + positionsWord(parsed.ok.length),
      parsed.ok.length > 0 && !parsed.bad.length && !state.sending, function () {
        askOk('Загрузить ' + parsed.ok.length + ' позиций' + (withStock ? ', по ' + withStock + ' из них с остатком' : '') + '?', send);
      });
    var nodes = [
      title('Загрузить списком', 'Вставьте строки: название; цена; остаток; закупка; минимум'),
      el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Категория для всего списка' }),
        chips(Object.keys(CATS).map(function (k) { return [k, CATS[k]]; }), f.category, function (k) { f.category = k; render(); })]),
      el('div', { class: 'card card--note' }, [
        el('div', { text: 'Пример строки: Пион розовый; 1500; 40; 900; 10' }),
        el('div', { class: 'muted', text: 'Обязательны название и цена. Остаток, закупка и минимум — по желанию. Закупку можно не знать: оставьте пустой или поставьте «;» без числа. Из Excel можно вставлять столбцами.' }),
        el('div', { class: 'muted', text: 'Остаток вносится только когда смена закрыта.' })]),
      (function () {
        var ta = el('textarea', { class: 'input', rows: '8', placeholder: 'Роза красная 60 см; 1200; 80; 650; 20\nЭвкалипт; 500; 100', 'aria-label': 'Список позиций',
        oninput: function (e) { f.text = e.target.value; f.confirm = false; f.dups = null; render(); } });
        ta.value = f.text;
        return ta;
      })()
    ];
    if (f.text.trim()) {
      nodes.push(el('div', { class: 'card' }, [
        el('div', { class: 'sum' }, [el('span', { text: 'Распознано позиций' }), el('b', { class: 'num', text: String(parsed.ok.length) })]),
        withStock ? el('div', { class: 'muted', text: 'С остатком: ' + withStock }) : null
      ]));
      if (parsed.bad.length) nodes.push(el('div', { class: 'card card--note' }, parsed.bad.slice(0, 6).map(function (b) { return el('div', { text: b }); })));
      if (f.dups && f.dups.length) nodes.push(el('div', { class: 'card card--note' }, [el('div', { text: 'Эти названия уже есть: ' + f.dups.slice(0, 5).join(', ') }), el('div', { class: 'muted', text: 'Если это другие позиции — нажмите «Загрузить» ещё раз.' })]));
    }
    app.replaceChildren.apply(app, nodes);
  };

  /** Одно поле формы: подпись + ввод. */
  function formField(label, input, hint) {
    return el('label', { class: 'card', style: 'display:flex;flex-direction:column;gap:6px' }, [
      el('span', { class: 'muted', text: label }), input, hint ? el('span', { class: 'muted', style: 'font-size:12px', text: hint }) : null]);
  }

  SCREENS.owner_item = function () {
    backButton(true);
    var f = state.form;
    var it = f.item;
    if (!it) { openScreen('owner_catalog'); return; }
    if (f.name === undefined) { f.name = it.name; f.price = String(it.price); f.min = String(it.min); f.cost = it.cost ? String(it.cost) : ''; }
    var price = intOf(f.price), min = intOf(f.min), cost = intOf(f.cost);
    var payload = { item_id: it.item_id };
    if (f.name.trim() && f.name.trim() !== it.name) payload.name = f.name.trim();
    if (price !== null && price > 0 && price !== it.price) payload.sale_price = price;
    if (min !== null && min >= 0 && min !== it.min) payload.min_stock = min;
    if (cost !== null && cost !== (it.cost || 0)) payload.last_cost = cost;
    var changed = Object.keys(payload).length > 1;
    var valid = f.name.trim().length > 0 && price !== null && price > 0 && min !== null && min >= 0 && (f.cost === '' || cost !== null);
    mainButton(state.sending ? 'Сохраняем…' : 'Сохранить', changed && valid && !state.sending, function () {
      submitOp('catalog_edit', payload, 'Сохранено', function () { openScreen('owner_catalog'); });
    });
    var hidden = it.status === 'hidden';
    app.replaceChildren(
      title(it.name, (CATS[it.category] || '') + ' · остаток ' + it.stock + (it.cost ? ' · закупка ' + money(it.cost) : '')),
      formField('Название', el('input', { class: 'input', value: f.name, maxlength: '80', oninput: function (e) { f.name = e.target.value; render(); } })),
      formField('Цена продажи, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.price, oninput: function (e) { f.price = e.target.value; render(); } }),
        'Новая цена действует для следующих продаж. Старые чеки не меняются.'),
      formField('Минимальный остаток, шт', el('input', { class: 'input num', inputmode: 'numeric', value: f.min, oninput: function (e) { f.min = e.target.value; render(); } }),
        'Ниже этого числа позиция попадёт в «Заканчиваются» и в закупку.'),
      formField('Закупка за штуку, ₸ (по желанию)', el('input', { class: 'input num', inputmode: 'numeric', value: f.cost, placeholder: 'не указана', oninput: function (e) { f.cost = e.target.value; render(); } }),
        'Нужна, чтобы оценивать брак и недостачи. Пока не знаете — оставьте пустой, потом заполнится приходом или здесь.'),
      it.status === 'review' ? el('button', { class: 'btn btn--primary', disabled: state.sending, onclick: function () {
        submitOp('catalog_edit', { item_id: it.item_id, status: 'active' }, 'Позиция подтверждена', function () { openScreen('owner_catalog'); });
      } }, [icon('check'), 'Подтвердить новую позицию']) : null,
      el('button', { class: 'btn', disabled: state.sending, onclick: function () {
        submitOp('catalog_edit', { item_id: it.item_id, status: hidden ? 'active' : 'hidden' }, hidden ? 'Позиция снова в кассе' : 'Позиция скрыта', function () { openScreen('owner_catalog'); });
      } }, [icon(hidden ? 'eye' : 'eye-off'), hidden ? 'Вернуть в кассу' : 'Скрыть из кассы']),
      el('div', { class: 'muted center', text: hidden ? 'Скрытая позиция не продаётся, история чеков сохраняется.' : 'Скрыть можно, если позиции больше нет. История чеков сохраняется.' }),
      hidden ? el('button', { class: 'btn btn--close', disabled: state.sending || it.stock !== 0, onclick: function () {
        askOk('Удалить «' + it.name + '» из каталога? Из списков она пропадёт, старые чеки и отчёты останутся.', function () {
          submitOp('catalog_delete', { item_id: it.item_id }, 'Позиция удалена', function () { openScreen('owner_catalog'); });
        });
      } }, [icon('trash'), 'Удалить навсегда']) : null,
      hidden && it.stock !== 0 ? el('div', { class: 'muted center', text: 'Удалить можно, когда остаток равен нулю (сейчас ' + it.stock + ' шт.). Спишите остаток браком или поправьте при закрытии смены.' }) : null
    );
  };

  SCREENS.owner_item_new = function () {
    backButton(true);
    var f = state.form;
    if (f.name === undefined) { f.name = ''; f.price = ''; f.category = 'flowers'; }
    var price = intOf(f.price);
    var valid = f.name.trim().length > 0 && price !== null && price > 0;
    var send = function (confirm) {
      busyPost('new_item', { name: f.name.trim(), category: f.category, sale_price: price, confirm_new: confirm === true }).then(function (res) {
        if (!res) return;
        if (res.similar) { f.similar = res.similar; render(); return; }
        toast('Позиция добавлена');
        openScreen('owner_catalog');
      });
    };
    mainButton(state.sending ? 'Добавляем…' : 'Добавить', valid && !state.sending, function () { send(!!f.similar); });
    var nodes = [
      title('Новая позиция', 'Появится в кассе сразу. Остаток внесёт флорист приходом.'),
      formField('Название', el('input', { class: 'input', value: f.name, maxlength: '80', placeholder: 'Например: Пион розовый', oninput: function (e) { f.name = e.target.value; f.similar = null; render(); } })),
      el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Категория' }), chips(Object.keys(CATS).map(function (k) { return [k, CATS[k]]; }), f.category, function (k) { f.category = k; render(); })]),
      formField('Цена продажи, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.price, oninput: function (e) { f.price = e.target.value; render(); } }))
    ];
    if (f.similar && f.similar.length) {
      nodes.push(el('div', { class: 'card card--note' }, [
        el('div', { text: 'Похожие позиции уже есть:' })
      ].concat(f.similar.map(function (s) { return el('div', { class: 'muted', text: '• ' + s.name }); })).concat([
        el('div', { class: 'muted', text: 'Если это другая позиция — нажмите «Добавить» ещё раз.' })])));
    }
    app.replaceChildren.apply(app, nodes);
  };

  // ---------- Управление: сотрудники, расходы, настройки ----------

  /** Процент из поля («3» или «2,5») → сотые доли процента; пусто/ошибка → null. */
  function pctBp(v) {
    var s = String(v == null ? '' : v).replace(',', '.').replace(/[\s%]/g, '');
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
    var bp = Math.round(parseFloat(s) * 100);
    return bp <= 10000 ? bp : null;
  }
  /** Целое со знаком: «150000» или «-150000»; 0 и мусор → null. */
  function signedInt(v) {
    var s = String(v == null ? '' : v).replace(/[\s\u00a0\u20bd₸]/g, '').replace('\u2212', '-');
    return /^-?\d{1,9}$/.test(s) && Number(s) !== 0 ? Number(s) : null;
  }
  function bpText(bp) { return String(bp / 100).replace('.', ',') + '%'; }
  function askOk(text, yes) {
    if (tg && tg.showConfirm) tg.showConfirm(text, function (ok) { if (ok) yes(); });
    else if (window.confirm(text)) yes();
  }

  SCREENS.owner_team = function () {
    backButton(true);
    mainButton(null);
    ownerLoad('owner_team', {}, function (list) {
      var rows = list.map(function (s) {
        var status = s.role === 'owner' ? 'владелица' : !s.active ? 'доступ отключён' : s.joined ? 'в кассе' : s.invited ? 'ждёт приглашения' : 'нет входа';
        var card = el('div', { class: 'card' + (s.active ? '' : ' card--note') }, [
          el('div', { class: 'sum' }, [el('b', { text: s.name }), el('span', { class: 'muted', text: status })]),
          s.role === 'florist' ? el('div', { class: 'muted num', text: 'ставка ' + money(s.shift_rate) + ' + ' + bpText(s.pct_bp) + ' от выручки' }) : null
        ]);
        if (s.role !== 'florist') return card;
        card.style.cursor = 'pointer';
        card.onclick = function () { openScreen('owner_staff', { person: s }); };
        return card;
      });
      app.replaceChildren.apply(app, [
        el('h1', { class: 'h1', text: 'Сотрудники' }),
        el('button', { class: 'btn btn--primary', onclick: function () { openScreen('owner_staff_new'); } }, [icon('user-plus'), 'Добавить флориста'])
      ].concat(rows));
    });
  };

  SCREENS.owner_staff_new = function () {
    backButton(true);
    var f = state.form;
    if (f.name === undefined) { f.name = ''; f.rate = ''; f.pct = ''; }
    var rate = intOf(f.rate), bp = pctBp(f.pct);
    var valid = f.name.trim().length > 0 && rate !== null && bp !== null;
    mainButton(state.sending ? 'Создаём…' : 'Создать и получить ссылку', valid && !state.sending, function () {
      var name = f.name.trim();
      submitOp('staff_add', { name: name, shift_rate: rate, pct_bp: bp }, 'Флорист добавлен', function (res) {
        openScreen('owner_invite', { name: name, link: res.result && res.result.invite_link });
      });
    });
    app.replaceChildren(
      title('Новый флорист', 'После создания появится ссылка-приглашение'),
      formField('Имя', el('input', { class: 'input', value: f.name, maxlength: '40', oninput: function (e) { f.name = e.target.value; render(); } })),
      formField('Ставка за смену, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.rate, oninput: function (e) { f.rate = e.target.value; render(); } })),
      formField('Процент от выручки, %', el('input', { class: 'input num', inputmode: 'decimal', value: f.pct, placeholder: 'например 3 или 2,5', oninput: function (e) { f.pct = e.target.value; render(); } }),
        'Если в смене двое, процент делится между ними.')
    );
  };

  SCREENS.owner_invite = function () {
    backButton(true);
    mainButton(null);
    var f = state.form;
    if (!f.link) { openScreen('owner_team'); return; }
    var share = function () {
      var url = 'https://t.me/share/url?url=' + encodeURIComponent(f.link) + '&text=' + encodeURIComponent('Ссылка для входа в кассу «Флора·Учёт»');
      if (tg && tg.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
    };
    var copy = function () {
      var done = function () { toast('Ссылка скопирована'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(f.link).then(done, function () { toast('Не получилось скопировать — выделите ссылку вручную', true); });
      else toast('Выделите ссылку и скопируйте вручную', true);
    };
    app.replaceChildren(
      title('Ссылка для ' + (f.name || 'сотрудника'), 'Одноразовая, действует 48 часов'),
      el('div', { class: 'card', style: 'word-break:break-all;user-select:all', text: f.link }),
      el('button', { class: 'btn btn--primary', onclick: share }, [icon('send'), 'Отправить в Telegram']),
      el('button', { class: 'btn', onclick: copy }, [icon('copy'), 'Скопировать ссылку']),
      el('div', { class: 'muted center', text: 'Отправьте её лично этому человеку: ссылка привязывается к первому, кто её откроет.' }),
      el('button', { class: 'btn', onclick: function () { openScreen('owner_team'); } }, 'Готово')
    );
  };

  SCREENS.owner_staff = function () {
    backButton(true);
    var f = state.form;
    var s = f.person;
    if (!s) { openScreen('owner_team'); return; }
    if (f.name === undefined) { f.name = s.name; f.rate = String(s.shift_rate); f.pct = String(s.pct_bp / 100).replace('.', ','); }
    var rate = intOf(f.rate), bp = pctBp(f.pct);
    var payload = { staff_id: s.staff_id };
    if (f.name.trim() && f.name.trim() !== s.name) payload.name = f.name.trim();
    if (rate !== null && rate !== s.shift_rate) payload.shift_rate = rate;
    if (bp !== null && bp !== s.pct_bp) payload.pct_bp = bp;
    var valid = f.name.trim().length > 0 && rate !== null && bp !== null;
    mainButton(state.sending ? 'Сохраняем…' : 'Сохранить', Object.keys(payload).length > 1 && valid && !state.sending, function () {
      submitOp('staff_edit', payload, 'Сохранено', function () { openScreen('owner_team'); });
    });
    app.replaceChildren(
      title(s.name, s.active ? (s.joined ? 'Работает в кассе' : 'Ещё не заходил') : 'Доступ отключён'),
      formField('Имя', el('input', { class: 'input', value: f.name, maxlength: '40', oninput: function (e) { f.name = e.target.value; render(); } })),
      formField('Ставка за смену, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.rate, oninput: function (e) { f.rate = e.target.value; render(); } }),
        'Новые условия — со следующей смены. Открытая и прошлые смены не меняются.'),
      formField('Процент от выручки, %', el('input', { class: 'input num', inputmode: 'decimal', value: f.pct, oninput: function (e) { f.pct = e.target.value; render(); } })),
      s.active ? el('button', { class: 'btn', disabled: state.sending, onclick: function () {
        submitOp('staff_invite', { staff_id: s.staff_id }, 'Ссылка готова', function (res) { openScreen('owner_invite', { name: s.name, link: res.result && res.result.invite_link }); });
      } }, [icon('link'), s.joined ? 'Новая ссылка-приглашение (старая перестанет работать)' : 'Показать ссылку-приглашение']) : null,
      el('button', { class: 'btn btn--close', disabled: state.sending, onclick: function () {
        var off = s.active;
        askOk(off ? 'Отключить доступ ' + s.name + '? Записи сохранятся, доступ вернуть можно.' : 'Вернуть доступ ' + s.name + '?', function () {
          submitOp('staff_set_active', { staff_id: s.staff_id, active: !off }, off ? 'Доступ отключён' : 'Доступ возвращён', function () { openScreen('owner_team'); });
        });
      } }, [icon(s.active ? 'user-off' : 'user-check'), s.active ? 'Отключить доступ' : 'Вернуть доступ'])
    );
  };

  var MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  function shiftMonth(m, delta) {
    var y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7)) - 1 + delta;
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    return y + '-' + String(mo + 1).padStart(2, '0');
  }

  SCREENS.owner_expenses = function () {
    backButton(true);
    var f = state.form;
    ownerLoad('owner_expenses', { month: f.month || '' }, function (d) {
      if (!f.month) f.month = d.month;
      if (!f.vals) { f.vals = {}; f.other = ''; f.otherAmount = ''; f.comment = ''; }
      var go = function (delta) { return function () { f.month = shiftMonth(f.month, delta); f.vals = null; f.data = undefined; render(); }; };
      // Сколько уже записано по каждой статье за месяц.
      var saved = {};
      d.items.forEach(function (e) { saved[e.item] = (saved[e.item] || 0) + e.amount; });
      var names = d.presets.slice();
      Object.keys(saved).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k); }); // статьи, внесённые раньше, но убранные из настроек
      var lines = function () {
        var out = [];
        names.forEach(function (n) { var v = signedInt(f.vals[n]); if (v) out.push({ item: n, amount: v }); });
        var o = signedInt(f.otherAmount);
        if (o && f.other.trim()) out.push({ item: f.other.trim(), amount: o });
        return out;
      };
      var bad = function () {
        var anyText = names.some(function (n) { return String(f.vals[n] || '').trim() && !signedInt(f.vals[n]); }) ||
          (String(f.otherAmount || '').trim() && (!signedInt(f.otherAmount) || !f.other.trim()));
        return !!anyText;
      };
      var upd = function () {
        var n = lines().length;
        mainButton(state.sending ? 'Записываем…' : 'Записать' + (n ? ' (' + n + ')' : ''), n > 0 && !bad() && !state.sending, function () {
          var payload = { month: f.month, lines: lines(), comment: f.comment.trim() };
          busy(postOp('owner_expense', payload, f.op_id)).then(function (res) {
            if (!res) return;
            haptic('success'); toast('Записано статей: ' + payload.lines.length);
            openScreen('owner_expenses', { month: f.month });
          });
        });
      };
      var rows = names.map(function (n) {
        return el('div', { class: 'sum' }, [
          el('div', {}, [el('div', { text: n }), el('div', { class: 'muted num', text: saved[n] ? 'уже записано ' + money(saved[n]) : 'за месяц пока ничего' })]),
          el('input', { class: 'input num', style: 'max-width:130px', inputmode: 'text', placeholder: 'сумма', value: f.vals[n] || '', 'aria-label': 'Сумма: ' + n,
            oninput: function (e) { f.vals[n] = e.target.value; upd(); } })
        ]);
      });
      var shown = d.items.map(function (e) {
        return el('div', { class: 'sum' }, [el('span', { class: 'muted', text: e.item + (e.comment ? ' · ' + e.comment : '') }), el('span', { class: 'num', text: money(e.amount) })]);
      });
      app.replaceChildren.apply(app, [
        el('h1', { class: 'h1', text: 'Расходы месяца' }),
        el('div', { class: 'row' }, [
          el('button', { class: 'chip', onclick: go(-1), 'aria-label': 'Прошлый месяц' }, [icon('chevron-left')]),
          el('b', { text: MONTHS[Number(f.month.slice(5, 7)) - 1] + ' ' + f.month.slice(0, 4) }),
          el('button', { class: 'chip', onclick: go(1), 'aria-label': 'Следующий месяц' }, [icon('chevron-right')])
        ]),
        el('div', { class: 'card card--accent' }, [el('div', { class: 'muted', text: 'Всего за месяц' }), el('div', { class: 'big num', text: money(d.total) })]),
        el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Впишите суммы по нужным статьям и нажмите «Записать». Пустые строки пропускаются. Ошибку исправляет сумма со знаком «−».' })].concat(rows)),
        el('div', { class: 'card' }, [
          el('div', { class: 'muted', text: 'Другая статья (по желанию)' }),
          el('input', { class: 'input', placeholder: 'Название, например: Ремонт', value: f.other, maxlength: '60', oninput: function (e) { f.other = e.target.value; upd(); } }),
          el('input', { class: 'input num', inputmode: 'text', placeholder: 'Сумма, ₸', value: f.otherAmount, 'aria-label': 'Сумма другой статьи', oninput: function (e) { f.otherAmount = e.target.value; upd(); } }),
          el('input', { class: 'input', placeholder: 'Общий комментарий (по желанию)', value: f.comment, maxlength: '200', oninput: function (e) { f.comment = e.target.value; } })
        ])
      ].concat(shown.length ? [el('div', { class: 'card' }, [el('div', { class: 'script', style: 'font-size:22px', text: 'Записи месяца' })].concat(shown))]
        : [emptyState('Расходов за месяц пока нет', 'Аренда, интернет, налоги — внесите, и прибыль в сводке станет точнее.')]));
      upd();
    });
  };

  SCREENS.owner_settings = function () {
    backButton(true);
    var f = state.form;
    ownerLoad('owner_settings', {}, function (d) {
      if (f.fund === undefined) { f.fund = String(d.change_fund); f.time = d.reminder_time; f.items = d.expense_items.split(';').join(', '); }
      var fund = intOf(f.fund);
      var payload = {};
      if (fund !== null && fund !== d.change_fund) payload.change_fund = fund;
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time) && f.time !== d.reminder_time) payload.reminder_time = f.time;
      if (f.items.trim() && f.items.trim() !== d.expense_items.split(';').join(', ')) payload.expense_items = f.items;
      var valid = fund !== null && /^([01]\d|2[0-3]):[0-5]\d$/.test(f.time) && f.items.trim().length > 0;
      mainButton(state.sending ? 'Сохраняем…' : 'Сохранить', valid && Object.keys(payload).length > 0 && !state.sending, function () {
        submitOp('settings_edit', payload, 'Настройки сохранены', function () { openScreen('owner_manage'); });
      });
      app.replaceChildren(
        title('Настройки', 'Для этой точки'),
        formField('Размен в кассе, ₸', el('input', { class: 'input num', inputmode: 'numeric', value: f.fund, oninput: function (e) { f.fund = e.target.value; render(); } }),
          'Эта сумма остаётся в кассе при закрытии смены.'),
        formField('Напомнить закрыть смену в', el('input', { class: 'input', type: 'time', value: f.time, oninput: function (e) { f.time = e.target.value; render(); } }),
          'Если смена открыта после этого времени, придёт напоминание.'),
        formField('Статьи расходов месяца', el('input', { class: 'input', value: f.items, maxlength: '300', oninput: function (e) { f.items = e.target.value; render(); } }),
          'Через запятую, например: Аренда, Налоги, Реклама.')
      );
    });
  };

  /** Отправить операцию владелицы; «похожие позиции» возвращаем как обычный результат, а не ошибку. */
  function busyPost(kind, payload) {
    var f = state.form;
    return busy(postOp(kind, payload, f.op_id).catch(function (e) {
      if (e && e.code === 'SIMILAR_ITEMS') return { similar: e.details || [] };
      throw e;
    })).then(function (res) {
      if (res && res.state) { setData(res.state, true); }
      return res;
    });
  }

  SCREENS.owner_shift = function () {
    backButton(true);
    mainButton(null);
    var f = state.form;
    ownerLoad('owner_shift', { shift_id: f.shift_id }, function (d) {
      var nodes = [ownerTabs(), reportBlock(d.text)];
      nodes.push(el('div', { class: 'muted', text: 'Чеки смены' }));
      d.receipts.forEach(function (r) {
        var parts = [r.cash ? 'нал ' + money(r.cash) : '', r.card ? 'безнал ' + money(r.card) : '', r.debt ? 'в долг ' + money(r.debt) : '',
          r.discount ? 'скидка ' + money(r.discount) : ''].filter(Boolean).join(' · ');
        var card = el('div', { class: 'card' + (r.status === 'cancelled' ? ' card--note' : '') }, [
          el('div', { class: 'sum' }, [el('span', { text: '№' + r.receipt_no + ' · ' + r.time + ' · ' + ({ sale: 'продажа', bouquet: 'букет', preorder: 'предзаказ' }[r.type] || r.type) +
            (r.status === 'cancelled' ? ' · снят' : '') }), el('span', { class: 'num', text: money(r.total) })]),
          parts ? el('div', { class: 'muted num', text: parts }) : null
        ]);
        if (d.status === 'closed' && r.status === 'posted') {
          if (f.fix === r.receipt_id) {
            card.appendChild(el('input', { class: 'search', placeholder: 'Причина, например «проведён дважды»', value: f.reason || '', oninput: function (e) { f.reason = e.target.value; } }));
            card.appendChild(el('div', { class: 'muted', text: 'Чек будет снят: товар на склад, долг по чеку снимется, выручка и % смены пересчитаются. Наличные факты смены не меняются (D26).' }));
            card.appendChild(el('div', { class: 'row' }, [
              el('button', { class: 'btn btn--primary', disabled: state.sending, onclick: function () {
                if (!(f.reason || '').trim()) return toast('Напишите причину', true);
                busy(postOp('correction', { receipt_id: r.receipt_id, reason: f.reason.trim() }, uuid())).then(function (res) {
                  if (!res) return;
                  toast('Исправлено. Отчёт отправлен в чат.');
                  f.fix = null; f.reason = ''; f.data = undefined; render();
                });
              } }, ['Снять чек']),
              el('button', { class: 'btn', onclick: function () { f.fix = null; render(); } }, ['Отмена'])
            ]));
          } else {
            card.appendChild(el('button', { class: 'btn', onclick: function () { f.fix = r.receipt_id; f.reason = ''; render(); } }, ['Исправить']));
          }
        }
        nodes.push(card);
      });
      app.replaceChildren.apply(app, nodes);
    });
  };

  function isoDay(offsetDays) {
    var now = new Date(Date.now() + 5 * 3600000);
    return new Date(now.getTime() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
  }
  function periodRange(kind, f) {
    var today = isoDay(0);
    if (kind === '7') return [isoDay(-6), today];
    if (kind === 'cur') return [today.slice(0, 8) + '01', today];
    if (kind === 'prev') {
      var first = today.slice(0, 8) + '01';
      var last = new Date(Date.parse(first + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
      return [last.slice(0, 8) + '01', last];
    }
    return [f.from || today, f.to || today];
  }

  SCREENS.owner_period = function () {
    backButton(false);
    mainButton(null);
    var f = state.form;
    f.kind = f.kind || 'cur';
    var range = periodRange(f.kind, f);
    var head = [ownerTabs(), el('div', { class: 'tabs4' }, [['7', '7 дней'], ['cur', 'Месяц'], ['prev', 'Прошлый'], ['own', 'Даты']].map(function (t) {
      return el('button', { class: 'chip', 'aria-pressed': String(f.kind === t[0]), onclick: function () { f.kind = t[0]; f.data = undefined; render(); } }, [t[1]]);
    }))];
    if (f.kind === 'own') {
      head.push(el('div', { class: 'row' }, [
        el('input', { class: 'input', type: 'date', value: f.from || '', 'aria-label': 'С', onchange: function (e) { f.from = e.target.value; f.data = undefined; render(); } }),
        el('input', { class: 'input', type: 'date', value: f.to || '', 'aria-label': 'По', onchange: function (e) { f.to = e.target.value; f.data = undefined; render(); } })
      ]));
      if (!f.from || !f.to) { app.replaceChildren.apply(app, head.concat([el('div', { class: 'muted', text: 'Выберите даты.' })])); return; }
    }
    ownerLoad('owner_period', { from: range[0], to: range[1] }, function (d) {
      var s = d.summary;
      var prev = d.prev || {};
      var staff = d.names.staff || {};
      var ownerItems = Object.keys(s.owner_by_item).map(function (k) { return kv(k, money(s.owner_by_item[k])); });
      app.replaceChildren.apply(app, head.concat([
        el('div', { class: 'muted', text: range[0].split('-').reverse().join('.') + ' — ' + range[1].split('-').reverse().join('.') }),
        el('div', { class: 'grid2' }, [
          el('div', { class: 'card card--accent' }, [el('div', { class: 'muted', text: 'Выручка' }), numEl(s.revenue, true),
            el('div', {}, [delta(s.revenue, prev.revenue), el('span', { class: 'muted', style: 'font-size:12px', text: ' к прошлому' })])]),
          el('div', { class: 'card' }, [el('div', { class: 'muted', text: 'Прибыль' }), numEl(s.profit, true, s.profit < 0 ? 'copper' : ''),
            el('div', {}, [deltaMoney(s.profit, prev.profit), el('span', { class: 'muted', style: 'font-size:12px', text: ' к прошлому' })]),
            s.profit < 0 ? el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px', text: 'Минус — из-за расходов месяца (аренда и др.)' }) : null])
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'legend legend--inline' }, [
            el('div', { class: 'legend__row' }, [el('span', { class: 'legend__dot', style: 'background:#f07ca0' }), el('span', { text: 'Выручка' })]),
            el('div', { class: 'legend__row' }, [el('span', { class: 'legend__dot', style: 'background:#7fd0e0' }), el('span', { text: 'Прибыль дня' })])
          ]),
          lineChart(d.days),
          el('div', { class: 'muted', style: 'font-size:12px', text: 'Коснитесь графика, чтобы увидеть день. Прибыль дня — без расходов месяца (аренда и др.). Смен ' + s.shifts + ' · чеков ' + s.receipts + ' · средний чек ' + money(s.avg_check) + '.' })
        ]),
        d.top && d.top.length ? el('div', { class: 'card' }, [el('div', { class: 'script', style: 'font-size:24px', text: 'Топ позиций' })].concat(d.top.map(function (t) {
          var maxQ = d.top[0].qty || 1;
          return el('div', { class: 'item' }, [itemArt(t), el('div', { class: 'item__main' }, [
            el('div', { style: 'font-weight:600', text: t.name }),
            el('div', { class: 'bar' }, [el('span', { style: 'width:' + Math.round(t.qty / maxQ * 100) + '%' })])
          ]), el('b', { class: 'num', text: t.qty + ' шт' })]);
        }))) : null,
        el('div', { class: 'card' }, [
          kv('Получено наличными', money(s.cash)),
          kv('Получено безналом', money(s.card)),
          kv('Закупки', money(s.purchases)),
          kv('Зарплата', money(s.payroll))
        ].concat(s.payroll_by.map(function (p) { return kv('  ' + (staff[p.staff_id] || p.staff_id) + ' · смен ' + p.shifts, money(p.rate + p.pct)); }))
          .concat([kv('Доставки', money(s.delivery)), kv('Прочие расходы', money(s.other)), kv('Возвраты', money(s.refunds))]).concat(ownerItems)),
        el('div', { class: 'card' }, [
          el('div', { class: 'muted', text: 'Потери (в прибыль не входят)' }),
          kv('Брак / замены', money(s.losses.defects) + ' / ' + money(s.losses.replaces)),
          kv('Недостачи товара', money(s.losses.shortage)),
          kv('Расхождения кассы', money(s.losses.cash_diff), s.losses.cash_diff < 0 ? 'copper' : '')
        ]),
        el('div', { class: 'card' }, [
          kv('Скидки', money(s.discounts)),
          kv('Изъято владелицей', money(s.withdrawal)),
          kv('Склад: начало → конец', money(s.stock_value_start) + ' → ' + money(s.stock_value_end)),
          kv('Не получено: долги', money(s.not_received.debts) + (s.not_received.debts_old ? ' (старше 30 дн. ' + money(s.not_received.debts_old) + ')' : '')),
          kv('Предзаказы к доплате', money(s.not_received.preorders))
        ]),
        el('button', { class: 'btn', onclick: function () { openScreen('owner_debtors'); } }, [icon('users'), 'Должники' + (s.not_received && s.not_received.debts ? ' · ' + money(s.not_received.debts) : '')]),
        el('button', { class: 'btn', disabled: state.sending, onclick: function () {
          busy(api({ action: 'owner_export', from: range[0], to: range[1] })).then(function (ok) {
            if (ok) toast('Файл Excel придёт вам в чат с ботом');
          });
        } }, [icon('file-spreadsheet'), 'Выгрузить в Excel'])
      ]));
    });
  };

  SCREENS.owner_debtors = function () {
    backButton(false);
    mainButton(null);
    var f = state.form;
    ownerLoad('owner_customers', {}, function (list) {
      var total = list.reduce(function (a, c) { return a + c.debt; }, 0);
      var nodes = [ownerTabs(), el('div', { class: 'card' }, [kv('Итого долгов', money(total))])];
      if (!list.length) nodes.push(emptyState('Должников нет', 'Все рассчитались — так держать.'));
      list.forEach(function (c) {
        var card = el('div', { class: 'card' }, [
          el('div', { class: 'sum' }, [el('b', { text: c.name }), el('span', { class: 'num ' + (c.debt ? 'copper' : ''), text: c.debt ? money(c.debt) : 'без долга' })]),
          el('div', { class: 'muted', text: [c.note, c.since && c.debt ? 'с ' + c.since.split('-').reverse().join('.') : ''].filter(Boolean).join(' · ') })
        ]);
        if (f.anon === c.customer_id) {
          card.appendChild(el('div', { class: 'muted', text: 'Имя и пометка будут стёрты по просьбе человека (закон о ПД). Долг и суммы в отчётах останутся. Отменить нельзя.' }));
          card.appendChild(el('div', { class: 'row' }, [
            el('button', { class: 'btn btn--primary', disabled: state.sending, onclick: function () {
              busy(postOp('anonymize', { customer_id: c.customer_id }, uuid())).then(function (res) {
                if (!res) return;
                toast('Обезличено'); f.anon = null; f.data = undefined; render();
              });
            } }, ['Обезличить']),
            el('button', { class: 'btn', onclick: function () { f.anon = null; render(); } }, ['Отмена'])
          ]));
        } else {
          card.appendChild(el('button', { class: 'btn', onclick: function () { f.anon = c.customer_id; render(); } }, ['Обезличить…']));
        }
        nodes.push(card);
      });
      app.replaceChildren.apply(app, nodes);
    });
  };

  // ---------- проведение ----------

  /** Нужно ли переспросить: крупная сумма или цена сильно отличается от каталога (похоже на лишний ноль). */
  function sureReasons(sm) {
    var why = [];
    if (sm.total >= LARGE_SUM) why.push('Крупная сумма — проверьте, что цифры верные.');
    if (sm.sum > 0 && sm.price >= sm.sum * 5 && sm.price - sm.sum >= 5000) why.push('Цена в ' + Math.round(sm.price / sm.sum) + ' раз выше каталожной (' + money(sm.sum) + ') — нет лишнего нуля?');
    if (sm.sum >= 5000 && sm.price * 5 <= sm.sum) why.push('Цена в ' + Math.round(sm.sum / sm.price) + ' раз ниже каталожной (' + money(sm.sum) + ').');
    return why;
  }
  function confirmSale(sm, how, why, onOk) {
    if (document.querySelector('.confirm')) return;
    haptic('warning');
    var close = function () { box.classList.add('confirm--out'); setTimeout(function () { box.remove(); }, 180); };
    var box = el('div', { class: 'confirm', role: 'alertdialog', 'aria-label': 'Подтвердите сумму' }, [
      el('div', { class: 'confirm__card' }, [
        el('div', { class: 'script', style: 'font-size:30px', text: 'Проверьте сумму' }),
        el('div', { class: 'confirm__sum num', text: money(sm.total) }),
        el('div', { class: 'muted', text: how }),
        el('div', { class: 'confirm__why' }, why.map(function (t) { return el('div', { text: '⚠️ ' + t }); })),
        el('button', { class: 'btn btn--primary btn--action', onclick: function () { close(); haptic('heavy'); onOk(); } }, [icon('check'), 'Провести ' + money(sm.total)]),
        el('button', { class: 'btn', onclick: close }, ['Изменить'])
      ])
    ]);
    document.body.appendChild(box);
  }

  function submit() {
    var d = draft();
    var sm = summary(d);
    if (!sm.payload || state.sending) return;
    var why = sureReasons(sm);
    if (why.length) {
      var how = { cash: 'наличными', card: 'безналом', mixed: 'нал + безнал', debt: 'в долг' }[d.pay] || '';
      return confirmSale(sm, (d.type === 'bouquet' ? 'Букет' : 'Продажа') + ' · ' + how, why, function () { doSubmit(d, sm); });
    }
    doSubmit(d, sm);
  }

  function doSubmit(d, sm) {
    var sh = state.data.shift;
    if (!sh || !sh.on_shift) { state.fieldError = { where: 'general', text: 'Смена не открыта. Откройте смену в чате бота — и оформите продажу.', code: 'NO_OPEN_SHIFT' }; render(); return; }
    var how = { cash: 'наличными', card: 'безналом', mixed: 'нал + безнал', debt: 'в долг' }[d.pay] || '';
    var change = d.pay === 'cash' && d.given && Number(d.given) > sm.total ? ' · сдача ' + money(Number(d.given) - sm.total) : '';
    // Продажа сначала сохраняется на телефоне (с номером операции и номером смены), потом уходит на сервер.
    var item = {
      id: uuid(), uid: uid(), kind: d.type, op_id: d.op_id, total: sm.total, created: Date.now(), status: 'pending', tries: 0,
      payload: Object.assign({}, sm.payload, { shift_no: sh.shift_no })
    };
    var q = myQ();
    q.push(item);
    saveMyQ(q);
    if (!myQ().some(function (i) { return i.id === item.id; })) { // телефон не дал сохранить (например, приватный режим) — не обещаем того, чего нет
      state.fieldError = { where: 'general', text: 'Телефон не даёт сохранить продажу (возможно, включён приватный режим). Продажа не оформлена — откройте кассу в обычном режиме.', code: 'STORAGE' };
      render();
      return;
    }
    state.lastSale = {
      shop: (state.data.shop && state.data.shop.name) || 'Флора·Учёт', type: d.type, how: how, total: sm.total,
      discount: sm.payload.price - sm.total,
      items: sm.payload.items.map(function (x) { return { name: nameOf(x.item_id), qty: x.qty }; }),
      when: new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 16).replace('T', ' ').split(' ').map(function (v, i) { return i ? v : v.split('-').reverse().join('.'); }).join(' · ')
    };
    store(LAST_KEY, { type: d.type, price: sm.payload.price, items: sm.payload.items });
    // Черновик пуст сразу: второе нажатие «Провести» ничего не проведёт.
    state.draft = newDraft();
    store(DRAFT_KEY, null);
    state.shortage = null;
    state.fieldError = null;
    // Остатки и выручка на экране — сразу, не дожидаясь сервера (только эта продажа: прежние уже учтены).
    applyList([item]);
    haptic('success');
    var box = showDone(sm.total, (d.type === 'bouquet' ? 'Букет' : 'Продажа') + ' · ' + how + change, false, true);
    state.doneBox = { id: item.id, title: box.title, note: box.note };
    state.screen = 'main';
    render();
    pump();
  }

  // ---------- старт ----------

  applyLite();
  if (tg) {
    tg.ready();
    tg.expand();
    // Тема кассы одна — тёмная бирюза с розами; шапку и главную кнопку Telegram красим под неё.
    try { tg.setHeaderColor('#163940'); tg.setBackgroundColor('#163940'); } catch (e) { /* старые версии Telegram */ }
    try { tg.MainButton.setParams({ color: '#E0507E', text_color: '#FFFFFF' }); } catch (e2) { /* не важно */ }
  }
  if (!tg || !tg.initData) {
    renderMessage('Откройте кассу из бота: кнопка «Касса» в меню @flora_uchet_bot.');
    return;
  }
  window.addEventListener('online', function () { netState(false); clearTimeout(retryTimer); retryStep = 0; pump(); silentRefresh(); });
  window.addEventListener('offline', function () { netState(true); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { pump(); silentRefresh(); } });
  setInterval(pump, 20000); // страховка: если таймер потерялся, очередь всё равно уйдёт
  // Продажи, оставшиеся в очереди с прошлого раза, считаем неотправленными.
  saveMyQ(myQ().map(function (i) { if (i.status === 'sending') i.status = 'pending'; return i; }));
  load();
})();
