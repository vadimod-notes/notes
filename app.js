/* Наш бюджет — интерфейс. Данные живут в Google Таблице, сюда только загружаются и показываются. */
(function () {
  'use strict';

  var C = window.BudgetCalc;
  var ICONS = window.ICONS;
  var CFG = window.APP_CONFIG || {};
  var LS_KEY = 'budget.accessKey';
  var LS_ACC = 'budget.lastAccount';

  // Ключ доступа: SHA-256 токен устройства, 64 hex-символа.
  // Генерируется скриптом при регистрации устройства.
  var ACCESS_KEY_LENGTH = 64;
  var ACCESS_KEY_FORMAT = /^[a-f0-9]+$/i; // eslint-disable-line no-unused-vars

  function validateAccessKey(key) {
    // отсекаем явно битые ключи до запроса к серверу
    if (key.length < ACCESS_KEY_LENGTH) {
      return { ok: false, error: 'Ключ должен содержать 64 символа' };
    }
    return { ok: true };
  }

  var S = {
    key: safeGet(LS_KEY) || '',
    me: '',
    data: null,
    view: 'overview',
    prevView: 'overview',
    month: thisMonth(),
    opsFilter: null,
    suppressClickUntil: 0
  };
  var T = null;   // состояние окна новой операции
  var F = null;   // состояние формы (категория / счёт / вклад)
  var SC = null;  // состояние сканера

  var app = document.getElementById('app');

  // ───────────── утилиты ─────────────

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function thisMonth() { return C.monthKey(C.toDateStr(new Date())); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function icon(name, size, color) {
    size = size || 22;
    return '<svg class="i" width="' + size + '" height="' + size + '" viewBox="0 0 24 24"' +
      (color ? ' style="color:' + color + '"' : '') + ' aria-hidden="true"><path d="' + (ICONS[name] || ICONS.more) + '"/></svg>';
  }
  function money(n) { return C.fmtMoney(n) + ' ₽'; }
  function tint(color) { return color + '14'; }

  function toast(text) {
    var old = document.querySelector('.toast');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2200);
  }

  // ───────────── данные ─────────────

  function sorted(list) {
    return list.filter(function (x) { return !x.archived; })
      .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });
  }
  function cats(kind) { return sorted(S.data.categories.filter(function (c) { return c.kind === kind; })); }
  function accounts() { return sorted(S.data.accounts); }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function cat(id) { return byId(S.data.categories, id); }
  function acc(id) { return byId(S.data.accounts, id); }
  function txs() { return S.data.transactions; }
  function defaultAccount() {
    var last = safeGet(LS_ACC);
    if (last && acc(last) && !acc(last).archived) return last;
    var a = accounts()[0];
    return a ? a.id : null;
  }
  function sortTxs() {
    S.data.transactions.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.created_at < b.created_at ? 1 : -1);
    });
  }
  function firstMonth() {
    var list = txs();
    if (!list.length) return thisMonth();
    return C.monthKey(list[list.length - 1].date);
  }

  // ───────────── сервер ─────────────

  function api(action, payload) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: S.key, action: action, payload: payload || {} }),
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) { return res.json(); })
      .then(function (j) {
        if (timer) clearTimeout(timer);
        if (!j.ok) { var e = new Error(j.error); e.code = j.error; throw e; }
        S.me = j.me;
        return j.data;
      }, function (err) {
        if (timer) clearTimeout(timer);
        // ошибки браузера (AbortError = код 20, TypeError «Load failed») — это обрыв связи, а не ответ сервера
        if (err && typeof err.code === 'string') throw err;
        var e = new Error('network');
        e.code = err && err.name === 'AbortError' ? 'timeout' : 'network';
        throw e;
      });
  }

  var ERRORS = {
    network: 'Нет связи с таблицей. Проверьте интернет.',
    timeout: 'Таблица долго не отвечает. Попробуйте ещё раз — дубля не будет.',
    busy: 'Таблица занята, попробуйте через пару секунд',
    locked: 'Слишком много неверных попыток. Подождите 10 минут.',
    bad_amount: 'Проверьте сумму',
    bad_date: 'Проверьте дату',
    bad_account: 'Счёт не найден — обновите приложение',
    bad_category: 'Категория не найдена — обновите приложение',
    bad_name: 'Введите название',
    bad_rate: 'Проверьте ставку'
  };
  function errText(e) { return ERRORS[e.code] || ('Ошибка: ' + (e.code || e.message)); }
  function isLinkError(e) { return e && (e.code === 'network' || e.code === 'timeout'); }

  /** Короткий случайный ID: создаётся на телефоне, поэтому повторная отправка не создаёт дубль. */
  function uid() {
    var a = new Uint8Array(6);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  /** Тихо подтянуть свежие данные из таблицы (без экрана загрузки). */
  function silentReload() {
    return api('load').then(function (d) {
      d.transactions.forEach(function (t) { t.amount = Number(t.amount) || 0; });
      S.data = d;
      S.lastLoad = Date.now();
      sortTxs();
      if (!document.getElementById('sheet-root') && !SC) render();
      return d;
    });
  }

  // ───────────── запуск ─────────────

  function start() {
    if (!CFG.API_URL || CFG.API_URL.indexOf('https://script.google.com/') !== 0) {
      app.innerHTML = '<div class="center-screen"><h1>Почти готово</h1><p>Вставьте адрес веб-приложения Apps Script в файл <b>config.js</b> и загрузите его на GitHub ещё раз.</p></div>';
      return;
    }
    if (!S.key) return renderLogin('');
    load();
  }

  function load() {
    app.innerHTML = '<div class="center-screen"><div class="spinner" role="status" aria-label="Загрузка"></div></div>';
    api('load').then(function (d) {
      d.transactions.forEach(function (t) { t.amount = Number(t.amount) || 0; });
      S.data = d;
      S.lastLoad = Date.now();
      sortTxs();
      render();
    }).catch(function (e) {
      if (e.code === 'unauthorized') {
        S.key = ''; safeSet(LS_KEY, null);
        renderLogin('Код доступа не подошёл');
      } else if (e.code === 'locked') {
        renderLogin(ERRORS.locked);
      } else {
        app.innerHTML = '<div class="center-screen"><h1>Не загрузилось</h1><p>' + esc(errText(e)) +
          '</p><button class="primary" data-a="reload">Попробовать снова</button></div>';
      }
    });
  }

  function renderLogin(error) {
    app.innerHTML =
      '<div class="center-screen">' +
      '<h1>Наш бюджет</h1>' +
      '<p>Введите код доступа. Это нужно сделать один раз на этом телефоне.</p>' +
      '<input id="key" class="key-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Код доступа" aria-label="Код доступа">' +
      '<div class="error" id="key-err">' + esc(error) + '</div>' +
      '<button class="primary" data-a="login">Войти</button>' +
      '<button class="secondary" data-a="paste-key">Вставить из буфера</button>' +
      '</div>';
  }

  function doLogin() {
    var input = document.getElementById('key');
    var key = input.value.replace(/\s+/g, '');
    var v = validateAccessKey(key);
    if (!v.ok) { document.getElementById('key-err').textContent = v.error; return; }
    S.key = key;
    safeSet(LS_KEY, key);
    load();
  }

  // ───────────── экраны ─────────────

  function render() {
    if (!S.data) return;
    var html;
    switch (S.view) {
      case 'ops': html = viewOps(); break;
      case 'deposits': html = viewDeposits(); break;
      case 'settings': html = viewSettings(); break;
      case 'add': html = viewAdd(); break;
      default: html = viewOverview();
    }
    app.innerHTML = html + (S.view === 'add' ? '' : tabs());
  }

  function tabs() {
    function tab(v, ic, label) {
      return '<button class="tab' + (S.view === v ? ' on' : '') + '" data-a="tab" data-v="' + v + '">' + icon(ic, 24) + '<span>' + label + '</span></button>';
    }
    return '<nav class="tabs">' + tab('overview', 'pie', 'Обзор') + tab('ops', 'list', 'Операции') +
      '<div class="fab-wrap"><button class="fab" data-a="open-add" aria-label="Добавить расход или доход">' + icon('plus', 26) + '</button></div>' +
      tab('deposits', 'bank', 'Вклады') + tab('settings', 'sliders', 'Настройки') + '</nav>';
  }

  function monthSwitch() {
    var canPrev = S.month > firstMonth();
    var canNext = S.month < thisMonth();
    return '<div class="month">' +
      '<button class="round-btn ghost" data-a="month" data-d="-1" aria-label="Предыдущий месяц"' + (canPrev ? '' : ' disabled') + '>' + icon('chevL', 20) + '</button>' +
      '<span>' + C.monthLabel(S.month) + '</span>' +
      '<button class="round-btn ghost" data-a="month" data-d="1" aria-label="Следующий месяц"' + (canNext ? '' : ' disabled') + '>' + icon('chevR', 20) + '</button>' +
      '</div>';
  }

  function viewOverview() {
    var sum = C.monthSummary(txs(), S.month);
    var prev = C.monthSummary(txs(), C.shiftMonth(S.month, -1));
    var rows = cats('expense').concat(S.data.categories.filter(function (c) { return c.kind === 'expense' && c.archived; }))
      .map(function (c) { return { c: c, v: sum.byCat[c.id] || 0 }; })
      .filter(function (r) { return r.v > 0; })
      .sort(function (a, b) { return b.v - a.v; });

    var bg = '#EDEDEA';
    if (sum.expense > 0) {
      var acc0 = 0, parts = [];
      rows.forEach(function (r) {
        var s = acc0 / sum.expense * 360, e = (acc0 + r.v) / sum.expense * 360;
        var gap = rows.length > 1 ? Math.min(1.4, (e - s) / 3) : 0;
        parts.push(r.c.color + ' ' + s.toFixed(2) + 'deg ' + (e - gap).toFixed(2) + 'deg');
        if (gap) parts.push('#FFFFFF ' + (e - gap).toFixed(2) + 'deg ' + e.toFixed(2) + 'deg');
        acc0 += r.v;
      });
      bg = 'conic-gradient(' + parts.join(',') + ')';
    }
    var delta = '';
    if (prev.expense > 0 && sum.expense > 0) {
      var d = Math.round((sum.expense - prev.expense) / prev.expense * 100);
      delta = (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d) + '% к ' + C.monthDative(C.shiftMonth(S.month, -1));
    }
    var max = rows.length ? rows[0].v : 1;

    var list = rows.map(function (r) {
      var pct = Math.round(r.v / sum.expense * 100);
      return '<button class="row" data-a="cat-ops" data-id="' + esc(r.c.id) + '">' +
        '<div class="ic" style="background:' + tint(r.c.color) + '">' + icon(r.c.icon, 22, r.c.color) + '</div>' +
        '<div class="mid"><div class="line1"><span class="name">' + esc(r.c.name) + '</span><span class="amt">' + money(r.v) + '</span></div>' +
        '<div class="line2"><div class="bar"><i style="width:' + (r.v / max * 100).toFixed(1) + '%;background:' + r.c.color + '"></i></div><span class="p">' + pct + '%</span></div></div>' +
        '</button>';
    }).join('');

    return '<div class="screen">' +
      '<div class="top"><div><div class="eyebrow">Наш бюджет</div><h1>Обзор</h1></div>' +
      '<button class="round-btn" data-a="quick-scan" aria-label="Сканировать чек">' + icon('scan', 22) + '</button></div>' +
      monthSwitch() +
      '<div class="card donut-card">' +
      '<div class="donut" role="img" aria-label="Диаграмма расходов по категориям" style="background:' + bg + '">' +
      '<div class="donut-hole"><span class="l">Расходы</span><span class="v">' + money(sum.expense) + '</span><span class="d">' + esc(delta) + '</span></div></div>' +
      '<div class="stats"><div><span class="l">Доходы</span><span class="v">' + C.fmtMoney(sum.income) + '</span></div>' +
      '<div><span class="l">Расходы</span><span class="v">' + C.fmtMoney(sum.expense) + '</span></div>' +
      '<div><span class="l">Остаток</span><span class="v">' + C.fmtMoney(sum.income - sum.expense) + '</span></div></div>' +
      '</div>' +
      '<div class="section-title"><h2>Категории</h2><span>' + C.pluralOps(sum.count) + '</span></div>' +
      (list ? '<div class="rows">' + list + '</div>' : '<div class="empty">В этом месяце расходов пока нет.<br>Нажмите «+», чтобы добавить.</div>') +
      '</div>';
  }

  function viewOps() {
    var f = S.opsFilter ? cat(S.opsFilter) : null;
    var list = txs().filter(function (t) {
      return C.monthKey(t.date) === S.month && (!f || t.category_id === f.id);
    });
    var groups = [], cur = null;
    list.forEach(function (t) {
      var day = t.date.slice(0, 10);
      if (!cur || cur.day !== day) { cur = { day: day, items: [], total: 0 }; groups.push(cur); }
      cur.items.push(t);
      if (t.type === 'expense') cur.total += t.amount;
    });
    var html = groups.map(function (g) {
      return '<div class="day"><span>' + C.dayHeader(g.day) + '</span><span>' + (g.total ? '−' + money(g.total) : '') + '</span></div>' +
        '<div class="rows">' + g.items.map(txRow).join('') + '</div>';
    }).join('');

    return '<div class="screen">' +
      '<div class="top"><div><div class="eyebrow">Наш бюджет</div><h1>Операции</h1></div>' +
      '<button class="round-btn" data-a="quick-scan" aria-label="Сканировать чек">' + icon('scan', 22) + '</button></div>' +
      monthSwitch() +
      (f ? '<button class="filter-chip" data-a="clear-filter">' + esc(f.name) + icon('close', 16) + '</button>' : '') +
      (html || '<div class="empty">Операций за этот месяц нет.</div>') +
      '</div>';
  }

  function txRow(t) {
    var c = cat(t.category_id) || { name: 'Без категории', icon: 'more', color: '#868E96' };
    var a = acc(t.account_id);
    var isIn = t.type === 'income';
    var meta = [t.who, a ? a.name : '', t.comment].filter(Boolean).join(' · ');
    return '<button class="row" data-a="tx" data-id="' + esc(t.id) + '">' +
      '<div class="ic" style="background:' + (isIn ? '#F1F1EE' : tint(c.color)) + '">' + icon(c.icon, 22, isIn ? '#141414' : c.color) + '</div>' +
      '<div class="mid" style="gap:3px"><div class="line1"><span class="name">' + esc(c.name) + '</span>' +
      '<span class="amt' + (isIn ? ' plus' : '') + '">' + (isIn ? '+' : '−') + money(t.amount) + '</span></div>' +
      '<span class="meta">' + esc(meta) + (t.qr ? ' · чек' : '') + '</span></div></button>';
  }

  function viewAdd() {
    var key = thisMonth();
    var sum = C.monthSummary(txs(), key);
    var incomes = cats('income').map(function (c) {
      return '<button class="tile" data-drag="income" data-id="' + esc(c.id) + '" data-a="tap-income" aria-label="' + esc(c.name) + ': нажмите или перетащите на счёт">' +
        '<span class="t-name">' + esc(c.name) + '</span><div class="circle income">' + icon(c.icon, 22) + '</div>' +
        '<span class="t-amt">' + money(sum.byCat[c.id] || 0) + '</span></button>';
    }).join('');
    var accs = accounts().map(function (a) {
      return '<button class="tile" data-drag="acc" data-drop="1" data-kind="acc" data-id="' + esc(a.id) + '" data-a="tap-acc" aria-label="' + esc(a.name) + ': зажмите и перетащите на категорию">' +
        '<span class="t-name">' + esc(a.name) + '</span><div class="circle acc">' + icon(a.icon, 22) + '</div>' +
        '<span class="t-amt">' + money(C.accountBalance(a, txs())) + '</span></button>';
    }).join('');
    var R = 28, L = 2 * Math.PI * R, spent = 0, limits = 0;
    var expense = cats('expense').map(function (c) {
      var v = sum.byCat[c.id] || 0;
      spent += v; limits += c.limit || 0;
      var over = c.limit > 0 && v > c.limit;
      var ratio = c.limit > 0 ? Math.min(1, v / c.limit) : 0;
      return '<button class="tile" data-drop="1" data-kind="cat" data-id="' + esc(c.id) + '" data-a="tap-cat">' +
        '<span class="t-name">' + esc(c.name) + '</span>' +
        '<div class="ringwrap"><svg class="ring" width="60" height="60" viewBox="0 0 60 60" aria-hidden="true">' +
        '<circle cx="30" cy="30" r="28" fill="none" stroke="#EDEDEA" stroke-width="2.5"/>' +
        (ratio > 0 ? '<circle cx="30" cy="30" r="28" fill="none" stroke="' + (over ? '#C2410C' : c.color) + '" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="' + (ratio * L).toFixed(1) + ' ' + L.toFixed(1) + '"/>' : '') +
        '</svg><div class="inner" style="background:' + tint(c.color) + '">' + icon(c.icon, 22, c.color) + '</div></div>' +
        '<span class="t-amt"' + (over ? ' style="color:#C2410C"' : '') + '>' + money(v) + '</span>' +
        '<span class="t-sub">' + (c.limit > 0 ? 'из ' + C.fmtMoney(c.limit) : 'без лимита') + '</span></button>';
    }).join('');
    function addTile(a, label, big) {
      return '<button class="tile add" data-a="' + a + '"><span class="t-name">' + label + '</span><div class="circle dashed"' +
        (big ? ' style="width:60px;height:60px"' : '') + '>' + icon('plus', 20) + '</div></button>';
    }

    return '<div class="screen no-tabs">' +
      '<div class="top center"><button class="round-btn" data-a="close-add" aria-label="Закрыть">' + icon('close', 20) + '</button>' +
      '<h1>Добавить</h1><button class="round-btn" data-a="quick-scan" aria-label="Сканировать чек">' + icon('scan', 22) + '</button></div>' +
      '<p class="hint">Зажмите счёт и перетащите на категорию — или просто нажмите на категорию</p>' +
      '<div class="card" data-sec="income"><div class="card-head"><h2>Доходы</h2><span class="sub">за ' + C.monthLabel(key).split(' ')[0].toLowerCase() + '</span></div><div class="grid4">' + incomes + addTile('new-cat-income', 'Новый') + '</div></div>' +
      '<div class="card" data-sec="acc"><div class="card-head"><h2>Счета</h2></div><div class="grid4">' + accs + addTile('new-acc', 'Новый') + '</div></div>' +
      '<div class="card" data-sec="cat"><div class="card-head"><h2>Расходы</h2><span class="sub">' + C.fmtMoney(spent) + (limits ? ' из ' + C.fmtMoney(limits) : '') + ' ₽</span></div>' +
      '<div class="grid4">' + expense + addTile('new-cat-expense', 'Новая', true) + '</div></div>' +
      '</div>';
  }

  function viewDeposits() {
    var list = sorted(S.data.deposits.map(function (d, i) { d.sort = d.sort || i; return d; }));
    var total = 0, totalInt = 0;
    var cards = list.map(function (d) {
      var s = C.depositSummary(d);
      total += s.now.balance; totalInt += s.now.interest;
      var capText = { daily: 'ежедневная капитализация', monthly: 'ежемесячная капитализация', none: 'без капитализации' }[d.capitalization] || '';
      var period = 'с ' + C.humanDate(d.start_date).replace(/^(Сегодня|Вчера), /, '') +
        (s.openEnded ? ', бессрочный' : ' по ' + C.humanDate(C.toDateStr(s.now.end)).replace(/^(Сегодня|Вчера), /, ''));
      return '<button class="card dep" data-a="edit-dep" data-id="' + esc(d.id) + '">' +
        '<div class="dname">' + esc(d.name) + '</div>' +
        '<div class="dbal">' + money(s.now.balance) + '</div>' +
        '<div class="dint">+' + money(s.now.interest) + ' процентов' + (s.now.finished ? ' · срок закончился' : '') + '</div>' +
        '<div class="dmeta">' + C.fmtMoney(d.rate) + '% годовых · ' + capText + '<br>' + esc(period) + '</div>' +
        (s.progress !== null ? '<div class="bar"><i style="width:' + (s.progress * 100).toFixed(1) + '%;background:#141414"></i></div>' : '') +
        '<div class="dfoot"><span>' + (s.openEnded ? 'Через год' : 'К концу срока') + '</span><span><b>' + money(s.atEnd.balance) + '</b> (+' + C.fmtMoney(s.atEnd.interest) + ')</span></div>' +
        '</button>';
    }).join('');

    return '<div class="screen">' +
      '<div class="top"><div><div class="eyebrow">Наш бюджет</div><h1>Вклады</h1></div>' +
      '<button class="round-btn" data-a="new-dep" aria-label="Добавить вклад">' + icon('plus', 22) + '</button></div>' +
      (list.length ? '<div class="card" style="margin-top:12px"><div class="card-head" style="margin:0"><h2>Всего на вкладах</h2><span class="sub">+' + money(totalInt) + '</span></div>' +
        '<div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;margin-top:6px">' + money(total) + '</div></div>' + cards
        : '<div class="empty">Вкладов пока нет.<br><br><button class="pill-btn" data-a="new-dep">' + icon('plus', 18) + 'Добавить вклад</button></div>') +
      '</div>';
  }

  function viewSettings() {
    var accRows = accounts().map(function (a) {
      return '<button class="list-row" data-a="edit-acc" data-id="' + esc(a.id) + '"><div class="ic" style="background:#F1F1EE">' + icon(a.icon, 20) + '</div>' +
        '<span class="name">' + esc(a.name) + '</span><span class="val">' + money(C.accountBalance(a, txs())) + '</span></button>';
    }).join('');
    var catRows = cats('expense').map(function (c) {
      return '<button class="list-row" data-a="edit-cat" data-id="' + esc(c.id) + '"><div class="ic" style="background:' + tint(c.color) + '">' + icon(c.icon, 20, c.color) + '</div>' +
        '<span class="name">' + esc(c.name) + '</span><span class="val">' + (c.limit > 0 ? 'лимит ' + C.fmtMoney(c.limit) : 'без лимита') + '</span></button>';
    }).join('');
    var incRows = cats('income').map(function (c) {
      return '<button class="list-row" data-a="edit-cat" data-id="' + esc(c.id) + '"><div class="ic" style="background:#F1F1EE">' + icon(c.icon, 20) + '</div>' +
        '<span class="name">' + esc(c.name) + '</span></button>';
    }).join('');
    function addRow(a, label) {
      return '<button class="list-row" data-a="' + a + '"><div class="ic" style="border:1.5px dashed #C9C9C4">' + icon('plus', 18, '#6B6B67') + '</div><span class="name" style="color:#6B6B67">' + label + '</span></button>';
    }
    return '<div class="screen">' +
      '<div class="top"><div><div class="eyebrow">Вы вошли как ' + esc(S.me) + '</div><h1>Настройки</h1></div><span class="spacer44"></span></div>' +
      '<div class="card" style="margin-top:12px"><h2 style="margin-bottom:4px">Счета</h2>' + accRows + addRow('new-acc', 'Добавить счёт') + '</div>' +
      '<div class="card"><h2 style="margin-bottom:4px">Категории расходов</h2>' + catRows + addRow('new-cat-expense', 'Новая категория') + '</div>' +
      '<div class="card"><h2 style="margin-bottom:4px">Источники дохода</h2>' + incRows + addRow('new-cat-income', 'Новый источник') + '</div>' +
      '<div style="padding:4px 16px"><button class="secondary danger" data-a="logout">Выйти на этом телефоне</button></div>' +
      '</div>';
  }

  // ───────────── шторка ─────────────

  function openSheet(html, label) {
    closeSheet();
    var wrap = document.createElement('div');
    wrap.id = 'sheet-root';
    wrap.innerHTML = '<div class="backdrop" data-a="close-sheet"></div><div class="sheet" role="dialog" aria-label="' + esc(label) + '">' + html + '</div>';
    document.body.appendChild(wrap);
  }
  function setSheet(html) {
    var s = document.querySelector('#sheet-root .sheet');
    if (s) s.innerHTML = html;
  }
  function closeSheet() {
    var w = document.getElementById('sheet-root');
    if (w) w.remove();
  }
  function sheetHead(title) {
    return '<div class="grab"></div><div class="s-head"><span class="spacer44"></span><h2>' + esc(title) + '</h2>' +
      '<button class="round-btn" data-a="close-sheet" aria-label="Закрыть">' + icon('close', 20) + '</button></div>';
  }

  // ───────────── новая операция ─────────────

  function openTx(type, accountId, categoryId) {
    T = {
      id: uid(),
      type: type, account_id: accountId, category_id: categoryId,
      amount: '0', who: S.me || S.data.people[0], date: C.toDateTimeStr(new Date()),
      comment: '', qr: '', scanned: false, picker: null, saving: false
    };
    openSheet(txHtml(), type === 'income' ? 'Новый доход' : 'Новый расход');
  }

  function txChip(kind, id) {
    var o = kind === 'acc' ? acc(id) : cat(id);
    var side = (T.type === 'expense') === (kind === 'acc') ? 'from' : 'to';
    if (!o) return '<button class="chip empty-chip" data-a="pick" data-side="' + side + '">' + (kind === 'acc' ? 'Выбрать счёт' : 'Выбрать категорию') + '</button>';
    var colored = kind === 'cat' && T.type === 'expense';
    return '<button class="chip" data-a="pick" data-side="' + side + '"><div class="ci" style="background:' + (colored ? tint(o.color) : '#F1F1EE') + '">' +
      icon(o.icon, 18, colored ? o.color : '#141414') + '</div>' + esc(o.name) + '</button>';
  }

  function limitInfo() {
    if (T.type !== 'expense') return { text: '', over: false };
    var c = cat(T.category_id);
    if (!c || !(c.limit > 0)) return { text: '', over: false };
    var key = C.monthKey(T.date);
    var spent = C.monthSummary(txs(), key).byCat[c.id] || 0;
    var left = c.limit - spent - C.amountFromInput(T.amount);
    return left >= 0 ? { text: 'Останется в лимите: ' + money(left), over: false } : { text: 'Лимит превышен на ' + money(-left), over: true };
  }

  function amountText() {
    var parts = T.amount.split(',');
    var int = C.fmtMoney(Number(parts[0]) || 0);
    return (parts.length > 1 ? int + ',' + parts[1] : int) + ' ₽';
  }

  function txHtml() {
    var title = T.type === 'income' ? 'Новый доход' : 'Новый расход';
    if (T.picker) return pickerHtml(title);
    var fromChip = T.type === 'expense' ? txChip('acc', T.account_id) : txChip('cat', T.category_id);
    var toChip = T.type === 'expense' ? txChip('cat', T.category_id) : txChip('acc', T.account_id);
    var li = limitInfo();
    var people = S.data.people.map(function (p) {
      return '<button class="' + (T.who === p ? 'on' : '') + '" data-a="who" data-v="' + esc(p) + '" aria-pressed="' + (T.who === p) + '">' + esc(p) + '</button>';
    }).join('');
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back'].map(function (k) {
      return '<button data-a="pad" data-k="' + k + '" aria-label="' + (k === 'back' ? 'Стереть' : k === ',' ? 'Запятая' : k) + '">' +
        (k === 'back' ? icon('backspace', 24) : k) + '</button>';
    }).join('');

    return sheetHead(title) +
      '<div class="s-body">' +
      '<div class="flow">' + fromChip + icon('arrowR', 18, '#6B6B67') + toChip + '</div>' +
      '<div class="amount-meta"><div class="amount' + (T.amount === '0' ? ' zero' : '') + '" id="tx-amount">' + amountText() + '</div>' +
      (T.scanned ? '<span class="scanned">' + icon('check', 14) + 'Итог из чека</span>' : '') +
      '<span class="limit-line' + (li.over ? ' over' : '') + '" id="tx-limit">' + esc(li.text) + '</span>' +
      '<button class="pill-btn" data-a="scan">' + icon('scan', 18) + (T.scanned ? 'Сканировать заново' : 'Сканировать чек') + '</button></div>' +
      '<div class="fields">' +
      '<div class="field"><span class="lbl">Кто</span><div class="seg">' + people + '</div></div>' +
      '<label class="field"><span class="lbl">Дата</span><span class="dt">' + icon('calendar', 16) + '<span id="tx-date">' + esc(C.humanDate(T.date)) + '</span></span>' +
      '<input class="overlay" type="datetime-local" data-in="tx-date" value="' + esc(T.date.replace(' ', 'T')) + '" aria-label="Дата"></label>' +
      '<label class="field"><span class="lbl">Комментарий</span><input type="text" data-in="tx-comment" maxlength="200" value="' + esc(T.comment) + '" placeholder="' + (T.type === 'income' ? 'Например, аванс' : 'Например, Пятёрочка') + '"></label>' +
      '</div>' +
      '<div class="pad">' + keys + '</div>' +
      '<button class="primary" data-a="save-tx" id="tx-save"' + (canSave() ? '' : ' disabled') + '>' + (T.saving ? 'Сохраняем…' : 'Сохранить') + '</button>' +
      '</div>';
  }

  function pickerHtml(title) {
    var wantAcc = (T.picker === 'from') === (T.type === 'expense');
    var items = wantAcc ? accounts() : cats(T.type);
    var tiles = items.map(function (o) {
      var colored = !wantAcc && T.type === 'expense';
      return '<button class="tile" data-a="pick-set" data-id="' + esc(o.id) + '"><div class="circle" style="background:' + (colored ? tint(o.color) : '#F1F1EE') + '">' +
        icon(o.icon, 22, colored ? o.color : '#141414') + '</div><span class="t-name">' + esc(o.name) + '</span></button>';
    }).join('');
    return '<div class="grab"></div><div class="s-head"><button class="round-btn" data-a="pick-back" aria-label="Назад">' + icon('chevL', 20) + '</button>' +
      '<h2>' + (wantAcc ? 'Счёт' : (T.type === 'income' ? 'Источник дохода' : 'Категория')) + '</h2><span class="spacer44"></span></div>' +
      '<div class="s-body"><div class="picker">' + tiles + '</div></div>';
  }

  function canSave() {
    return !T.saving && C.amountFromInput(T.amount) > 0 && !!T.account_id && !!T.category_id;
  }

  function refreshAmount() {
    var el = document.getElementById('tx-amount');
    if (!el) return;
    el.textContent = amountText();
    el.classList.toggle('zero', T.amount === '0');
    var li = limitInfo();
    var l = document.getElementById('tx-limit');
    l.textContent = li.text;
    l.classList.toggle('over', li.over);
    document.getElementById('tx-save').disabled = !canSave();
  }

  function pressKey(k) {
    var a = T.amount;
    if (k === 'back') a = a.length > 1 ? a.slice(0, -1) : '0';
    else if (k === ',') { if (a.indexOf(',') === -1) a += ','; }
    else {
      var p = a.split(',');
      if (p.length > 1 && p[1].length >= 2) return;
      if (p.length === 1 && p[0].length >= 9) return;
      a = a === '0' ? k : a + k;
    }
    T.amount = a;
    if (T.scanned) { T.scanned = false; T.qr = ''; setSheet(txHtml()); return; }
    refreshAmount();
  }

  function saveTx(force) {
    if (!canSave()) return;
    T.saving = true;
    setSheet(txHtml());
    var payload = {
      id: T.id, type: T.type, amount: C.amountFromInput(T.amount), account_id: T.account_id, category_id: T.category_id,
      who: T.who, date: T.date, comment: T.comment.trim(), qr: T.qr, force: !!force
    };
    var mine = T;
    function done(row) {
      row.amount = Number(row.amount);
      if (!byId(S.data.transactions, row.id)) S.data.transactions.push(row);
      sortTxs();
      safeSet(LS_ACC, mine.account_id);
      if (T === mine) { T = null; closeSheet(); }
      if (S.view === 'add') S.view = S.prevView;
      S.month = C.monthKey(row.date);
      render();
      toast(row.type === 'income' ? 'Доход сохранён' : 'Расход сохранён');
    }
    api('addTx', payload).then(done).catch(function (e) {
      if (isLinkError(e)) {
        // Связь оборвалась — но таблица могла успеть записать. Проверяем по ID.
        toast('Связь оборвалась, проверяем, сохранилось ли…');
        return silentReload().then(function () {
          var row = byId(S.data.transactions, mine.id);
          if (row) return done(row);
          mine.saving = false;
          if (T === mine) setSheet(txHtml());
          toast('Не сохранилось. Нажмите «Сохранить» ещё раз');
        }, function () {
          mine.saving = false;
          if (T === mine) setSheet(txHtml());
          toast(errText(e));
        });
      }
      mine.saving = false;
      if (T === mine) setSheet(txHtml());
      if (e.code === 'duplicate_receipt') {
        if (window.confirm('Этот чек уже добавлен. Добавить ещё раз?')) saveTx(true);
      } else toast(errText(e));
    });
  }

  // ───────────── сканер чеков ─────────────

  var JSQR_SOURCES = [
    './jsQR.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
    'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'
  ];
  function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    var i = 0;
    return new Promise(function (resolve, reject) {
      (function next() {
        if (i >= JSQR_SOURCES.length) return reject(new Error('jsqr'));
        var s = document.createElement('script');
        s.src = JSQR_SOURCES[i++];
        s.onload = function () { if (window.jsQR) resolve(); else next(); };
        s.onerror = function () { s.remove(); next(); };
        document.head.appendChild(s);
      })();
    });
  }

  function startScanner() {
    stopScanner();
    var el = document.createElement('div');
    el.className = 'scanner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Сканирование чека');
    el.innerHTML =
      '<video playsinline muted autoplay></video><div class="shade"></div>' +
      '<div class="s-top"><span class="spacer44"></span><h2>Скан чека</h2><button class="round-btn" data-a="scan-close" aria-label="Закрыть сканер">' + icon('close', 20) + '</button></div>' +
      '<div class="mid"><div class="frame"><svg width="250" height="250" viewBox="0 0 250 250" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M2 46V20a18 18 0 0 1 18-18h26 M204 2h26a18 18 0 0 1 18 18v26 M248 204v26a18 18 0 0 1-18 18h-26 M46 248H20a18 18 0 0 1-18-18v-26"/></svg><div class="line"></div></div>' +
      '<div><div class="status" id="scan-status">Включаем камеру…</div><div class="tip" id="scan-tip">Наведите камеру на QR-код чека — сумма и дата подставятся сами</div></div></div>' +
      '<button class="manual" data-a="scan-close">Ввести вручную</button>';
    document.body.appendChild(el);
    var video = el.querySelector('video');
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    SC = { el: el, stream: null, timer: 0, msgUntil: 0 };
    var mine = SC;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      scanStatus('Камера недоступна', 'Откройте приложение с экрана «Домой» или в Safari.');
      return;
    }
    loadJsQR().then(function () {
      if (SC !== mine) throw new Error('closed');
      return navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    }).then(function (stream) {
      if (SC !== mine) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      SC.stream = stream;
      video.srcObject = stream;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
      scanStatus('Наведите камеру на QR-код');
      tick();
    }).catch(function (err) {
      if (SC !== mine) return;
      if (err && err.message === 'jsqr') scanStatus('Не загрузился сканер', 'Проверьте интернет или загрузите файл jsQR.js на GitHub (см. инструкцию).');
      else if (err && err.name === 'NotAllowedError') scanStatus('Нет доступа к камере', 'Разрешите доступ: Настройки → Safari → Камера → «Разрешить».');
      else scanStatus('Камера недоступна', 'Попробуйте ещё раз или введите сумму вручную.');
    });

    function tick() {
      if (SC !== mine) return;
      if (video.readyState >= 2 && video.videoWidth) {
        var scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
        var w = Math.round(video.videoWidth * scale), h = Math.round(video.videoHeight * scale);
        if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
        ctx.drawImage(video, 0, 0, w, h);
        var img = ctx.getImageData(0, 0, w, h);
        var code = window.jsQR(img.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (code && code.data) {
          var r = C.parseReceiptQR(code.data);
          if (r) return onReceipt(r);
          if (Date.now() > SC.msgUntil) {
            SC.msgUntil = Date.now() + 2000;
            scanStatus('Это не QR-код чека', 'Нужен квадратный QR внизу кассового чека.');
            setTimeout(function () { if (SC === mine) scanStatus('Наведите камеру на QR-код', 'Наведите камеру на QR-код чека — сумма и дата подставятся сами'); }, 2000);
          }
        }
      }
      SC.timer = setTimeout(tick, 150);
    }
  }

  function scanStatus(status, tip) {
    var s = document.getElementById('scan-status'), t = document.getElementById('scan-tip');
    if (s) s.textContent = status;
    if (t && tip) t.textContent = tip;
  }

  function stopScanner() {
    if (!SC) return;
    clearTimeout(SC.timer);
    if (SC.stream) SC.stream.getTracks().forEach(function (t) { t.stop(); });
    SC.el.remove();
    SC = null;
  }

  function onReceipt(r) {
    stopScanner();
    if (!T) return;
    var int = Math.floor(r.amount), frac = Math.round((r.amount - int) * 100);
    T.amount = String(int) + (frac ? ',' + (frac < 10 ? '0' : '') + frac : '');
    T.date = r.date;
    T.qr = r.raw;
    T.scanned = true;
    setSheet(txHtml());
    if (r.isRefund) toast('Это чек возврата — проверьте тип операции');
  }

  // ───────────── формы: категория, счёт, вклад ─────────────

  function openForm(cfg) {
    F = cfg;
    F.saving = false;
    openSheet(formHtml(), cfg.title);
  }

  function formHtml() {
    var body = F.fields.map(function (f) {
      var v = F.values[f.key];
      if (f.type === 'icons') {
        return '<div class="fields"><div class="field col"><span class="lbl">Иконка</span><div class="icon-grid">' +
          window.ICON_SETS[f.set].map(function (n) {
            return '<button class="' + (v === n ? 'on' : '') + '" data-a="f-pick" data-k="' + f.key + '" data-v="' + n + '" aria-label="Иконка ' + n + '">' +
              icon(n, 22, F.values.color && f.set === 'expense' ? F.values.color : '#141414') + '</button>';
          }).join('') + '</div></div></div>';
      }
      if (f.type === 'colors') {
        return '<div class="fields"><div class="field col"><span class="lbl">Цвет</span><div class="color-grid">' +
          window.CATEGORY_COLORS.map(function (c) {
            return '<button class="' + (v === c ? 'on' : '') + '" data-a="f-pick" data-k="' + f.key + '" data-v="' + c + '" style="background:' + c + '" aria-label="Цвет ' + c + '"></button>';
          }).join('') + '</div></div></div>';
      }
      if (f.type === 'seg') {
        return '<div class="fields"><div class="field col"><span class="lbl">' + esc(f.label) + '</span><div class="seg" style="justify-content:flex-start">' +
          f.options.map(function (o) {
            return '<button class="' + (v === o[0] ? 'on' : '') + '" data-a="f-pick" data-k="' + f.key + '" data-v="' + o[0] + '">' + esc(o[1]) + '</button>';
          }).join('') + '</div></div></div>';
      }
      var attrs = f.type === 'money' || f.type === 'decimal' ? ' type="text" inputmode="decimal"' :
        f.type === 'int' ? ' type="text" inputmode="numeric"' : f.type === 'date' ? ' type="date"' : ' type="text" maxlength="30"';
      return '<div class="fields"><label class="field"><span class="lbl">' + esc(f.label) + '</span>' +
        '<input' + attrs + ' data-in="f" data-k="' + f.key + '" value="' + esc(v) + '" placeholder="' + esc(f.placeholder || '') + '"' +
        (f.type === 'date' ? ' style="flex:1;border:none;background:transparent;font-size:16px;text-align:right;outline:none"' : '') + '></label>' +
        (f.hint ? '<div style="font-size:12px;color:#6B6B67;padding:0 0 10px">' + esc(f.hint) + '</div>' : '') + '</div>';
    }).join('');
    return sheetHead(F.title) + '<div class="s-body">' + body +
      '<button class="primary" data-a="f-save"' + (F.saving ? ' disabled' : '') + '>' + (F.saving ? 'Сохраняем…' : 'Сохранить') + '</button>' +
      (F.extra ? '<button class="secondary danger" data-a="f-extra">' + esc(F.extra.label) + '</button>' : '') +
      '</div>';
  }

  function num(s) { return C.amountFromInput(String(s || '').replace(/[\s ]/g, '')); }

  function submitForm() {
    if (F.saving) return;
    F.saving = true;
    setSheet(formHtml());
    F.save(F.values).then(function (msg) {
      F = null;
      closeSheet();
      render();
      if (msg) toast(msg);
    }).catch(function (e) {
      F.saving = false;
      setSheet(formHtml());
      toast(isLinkError(e) ? 'Связь оборвалась. Нажмите «Сохранить» ещё раз — дубля не будет' : errText(e));
    });
  }

  function upsertLocal(list, row) {
    var i = list.findIndex(function (x) { return x.id === row.id; });
    if (i >= 0) list[i] = row; else list.push(row);
  }

  function categoryForm(kind, id) {
    var c = id ? cat(id) : null;
    var newId = uid();
    kind = c ? c.kind : kind;
    var fields = [{ key: 'name', label: 'Название', type: 'text', placeholder: kind === 'income' ? 'Например, Кэшбэк' : 'Например, Питомцы' },
      { key: 'icon', type: 'icons', set: kind }];
    if (kind === 'expense') {
      fields.push({ key: 'color', type: 'colors' });
      fields.push({ key: 'limit', label: 'Лимит в месяц, ₽', type: 'money', placeholder: 'без лимита', hint: 'Оставьте пустым, если лимит не нужен' });
    }
    openForm({
      title: c ? (kind === 'income' ? 'Источник дохода' : 'Категория') : (kind === 'income' ? 'Новый источник' : 'Новая категория'),
      fields: fields,
      values: {
        name: c ? c.name : '', icon: c ? c.icon : (kind === 'income' ? 'briefcase' : 'cart'),
        color: c ? c.color : window.CATEGORY_COLORS[Math.floor(Math.random() * 11)],
        limit: c && c.limit ? C.fmtMoney(c.limit) : ''
      },
      save: function (v) {
        var row = {
          id: c ? c.id : newId, kind: kind, name: v.name, icon: v.icon, color: kind === 'income' ? '#141414' : v.color,
          limit: kind === 'expense' ? num(v.limit) : 0, sort: c ? c.sort : 0, archived: false
        };
        return api('saveCategory', row).then(function (saved) { upsertLocal(S.data.categories, saved); return 'Сохранено'; });
      },
      extra: c ? {
        label: 'Убрать в архив',
        run: function () {
          if (!window.confirm('Убрать «' + c.name + '» в архив? Старые операции останутся в статистике.')) return null;
          var row = Object.assign({}, c, { archived: true });
          return api('saveCategory', row).then(function (saved) { upsertLocal(S.data.categories, saved); return 'Убрано в архив'; });
        }
      } : null
    });
  }

  function accountForm(id) {
    var a = id ? acc(id) : null;
    var newId = uid();
    var effect = a ? C.accountBalance(a, txs()) - (Number(a.start_balance) || 0) : 0;
    openForm({
      title: a ? 'Счёт' : 'Новый счёт',
      fields: [
        { key: 'name', label: 'Название', type: 'text', placeholder: 'Например, Вторая карта' },
        { key: 'icon', type: 'icons', set: 'account' },
        { key: 'balance', label: 'Сейчас на счёте, ₽', type: 'money', placeholder: '0', hint: 'Сколько денег на счёте прямо сейчас. Дальше остаток считается по операциям.' }
      ],
      values: { name: a ? a.name : '', icon: a ? a.icon : 'card', balance: a ? C.fmtMoney(C.accountBalance(a, txs())) : '' },
      save: function (v) {
        var row = { id: a ? a.id : newId, name: v.name, icon: v.icon, start_balance: Math.round((num(v.balance) - effect) * 100) / 100, sort: a ? a.sort : 0, archived: false };
        return api('saveAccount', row).then(function (saved) { upsertLocal(S.data.accounts, saved); return 'Сохранено'; });
      },
      extra: a ? {
        label: 'Убрать в архив',
        run: function () {
          if (!window.confirm('Убрать счёт «' + a.name + '» в архив?')) return null;
          return api('saveAccount', Object.assign({}, a, { archived: true })).then(function (saved) { upsertLocal(S.data.accounts, saved); return 'Убрано в архив'; });
        }
      } : null
    });
  }

  function depositForm(id) {
    var d = id ? byId(S.data.deposits, id) : null;
    var newId = uid();
    openForm({
      title: d ? 'Вклад' : 'Новый вклад',
      fields: [
        { key: 'name', label: 'Название', type: 'text', placeholder: 'Например, Сбер 18%' },
        { key: 'principal', label: 'Сумма, ₽', type: 'money', placeholder: '0' },
        { key: 'rate', label: 'Ставка, % годовых', type: 'decimal', placeholder: '18' },
        { key: 'start_date', label: 'Дата открытия', type: 'date' },
        { key: 'term_months', label: 'Срок, месяцев', type: 'int', placeholder: '12', hint: '0 — бессрочный (накопительный счёт)' },
        { key: 'capitalization', label: 'Начисление процентов', type: 'seg', options: [['daily', 'Ежедневно'], ['monthly', 'Ежемесячно'], ['none', 'В конце срока']] }
      ],
      values: {
        name: d ? d.name : '', principal: d ? C.fmtMoney(d.principal) : '', rate: d ? String(d.rate).replace('.', ',') : '',
        start_date: d ? d.start_date : C.toDateStr(new Date()), term_months: d ? String(d.term_months) : '12',
        capitalization: d ? d.capitalization : 'monthly'
      },
      save: function (v) {
        var row = {
          id: d ? d.id : newId, name: v.name, principal: num(v.principal), rate: num(v.rate),
          start_date: v.start_date, term_months: Math.round(num(v.term_months)), capitalization: v.capitalization, archived: false
        };
        return api('saveDeposit', row).then(function (saved) { upsertLocal(S.data.deposits, saved); return 'Сохранено'; });
      },
      extra: d ? {
        label: 'Удалить вклад',
        run: function () {
          if (!window.confirm('Удалить вклад «' + d.name + '»?')) return null;
          return api('deleteDeposit', { id: d.id }).then(function () {
            S.data.deposits = S.data.deposits.filter(function (x) { return x.id !== d.id; });
            return 'Вклад удалён';
          });
        }
      } : null
    });
  }

  // ───────────── перетаскивание ─────────────

  document.addEventListener('pointerdown', function (e) {
    if (S.view !== 'add' || !e.target.closest) return;
    var el = e.target.closest('[data-drag]');
    if (!el) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var src = { kind: el.getAttribute('data-drag'), id: el.getAttribute('data-id') };
    var srcObj = src.kind === 'acc' ? acc(src.id) : cat(src.id);
    var want = src.kind === 'income' ? 'acc' : 'cat';
    var sx = e.clientX, sy = e.clientY, started = false, coin = null, over = null;
    var lastX = sx, lastY = sy, raf = 0;
    var scroller = app.querySelector('.screen');

    // Автопрокрутка: палец у верхнего/нижнего края — страница едет сама
    function autoScroll() {
      if (!started) return;
      if (scroller) {
        var r = scroller.getBoundingClientRect();
        var zone = Math.min(110, r.height / 4), max = 16, dy = 0;
        if (lastY > r.bottom - zone) dy = max * Math.min(1, (lastY - (r.bottom - zone)) / zone);
        else if (lastY < r.top + zone) dy = -max * Math.min(1, ((r.top + zone) - lastY) / zone);
        if (dy) {
          var before = scroller.scrollTop;
          scroller.scrollTop = before + dy;
          if (scroller.scrollTop !== before) updateOver();
        }
      }
      raf = requestAnimationFrame(autoScroll);
    }
    function updateOver() {
      var t = hit(lastX, lastY);
      if (t !== over) {
        if (over) over.classList.remove('is-over');
        over = t;
        if (over) over.classList.add('is-over');
      }
    }

    function place(x, y) { coin.style.left = x + 'px'; coin.style.top = y + 'px'; }
    function begin(x, y) {
      started = true;
      coin = document.createElement('div');
      coin.className = 'coin';
      coin.innerHTML = icon(srcObj ? srcObj.icon : 'more', 24);
      document.body.appendChild(coin);
      place(x, y);
      el.classList.add('is-source');
      document.body.classList.add('dragging', 'dragging-' + src.kind);
      var dim = src.kind === 'acc' ? ['income', 'acc'] : ['income', 'cat'];
      dim.forEach(function (s) { var c = app.querySelector('[data-sec="' + s + '"]'); if (c) c.classList.add('dim'); });
      if (navigator.vibrate) navigator.vibrate(10);
      raf = requestAnimationFrame(autoScroll);
    }
    function hit(x, y) {
      var t = document.elementFromPoint(x, y);
      t = t && t.closest ? t.closest('[data-drop]') : null;
      if (!t || t.getAttribute('data-kind') !== want) return null;
      if (src.kind === 'acc' && t.getAttribute('data-id') === src.id) return null;
      return t;
    }
    function move(ev) {
      if (!started) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 8) return;
        clearTimeout(timer);
        begin(ev.clientX, ev.clientY);
      }
      if (ev.cancelable) ev.preventDefault();
      lastX = ev.clientX; lastY = ev.clientY;
      place(lastX, lastY);
      updateOver();
    }
    function end(ev, cancelled) {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (!started) return;
      S.suppressClickUntil = Date.now() + 400;
      coin.remove();
      el.classList.remove('is-source');
      document.body.classList.remove('dragging', 'dragging-acc', 'dragging-income');
      app.querySelectorAll('.dim').forEach(function (c) { c.classList.remove('dim'); });
      if (over) over.classList.remove('is-over');
      var target = !cancelled && ev ? hit(ev.clientX, ev.clientY) : null;
      if (!target) return;
      var tid = target.getAttribute('data-id');
      if (src.kind === 'acc') openTx('expense', src.id, tid);
      else openTx('income', tid, src.id);
    }
    function up(ev) { end(ev, false); }
    function cancel() { end(null, true); }
    var timer = setTimeout(function () { if (!started) begin(sx, sy); }, 200);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
  document.addEventListener('contextmenu', function (e) { if (e.target.closest && e.target.closest('[data-drag]')) e.preventDefault(); });

  // ───────────── действия ─────────────

  var ACTIONS = {
    'reload': load,
    'login': doLogin,
    'paste-key': function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) return toast('Вставьте код вручную');
      navigator.clipboard.readText().then(function (t) { document.getElementById('key').value = t.trim(); }, function () { toast('Вставьте код вручную'); });
    },
    'tab': function (d) { S.view = d.v; if (d.v !== 'ops') S.opsFilter = null; render(); scrollTop(); },
    'month': function (d) { S.month = C.shiftMonth(S.month, Number(d.d)); render(); },
    'cat-ops': function (d) { S.opsFilter = d.id; S.view = 'ops'; render(); scrollTop(); },
    'clear-filter': function () { S.opsFilter = null; render(); },
    'open-add': function () { S.prevView = S.view; S.view = 'add'; render(); scrollTop(); },
    'close-add': function () { S.view = S.prevView || 'overview'; render(); },
    'quick-scan': function () { openTx('expense', defaultAccount(), null); startScanner(); },
    'tap-cat': function (d) { openTx('expense', defaultAccount(), d.id); },
    'tap-income': function (d) { openTx('income', defaultAccount(), d.id); },
    'tap-acc': function () { toast('Зажмите счёт и перетащите на категорию'); },
    'tx': function (d) {
      var t = byId(txs(), d.id);
      if (!t) return;
      var c = cat(t.category_id);
      if (!window.confirm('Удалить операцию?\n' + (c ? c.name : '') + ', ' + C.fmtMoney(t.amount) + ' ₽, ' + C.humanDate(t.date))) return;
      api('deleteTx', { id: t.id }).then(function () {
        S.data.transactions = txs().filter(function (x) { return x.id !== t.id; });
        render();
        toast('Операция удалена');
      }).catch(function (e) {
        toast(errText(e));
        if (isLinkError(e)) silentReload().catch(function () {});
      });
    },
    'logout': function () {
      if (!window.confirm('Выйти на этом телефоне? Чтобы войти снова, понадобится код доступа.')) return;
      S.key = ''; S.data = null; safeSet(LS_KEY, null);
      renderLogin('');
    },
    // окно операции
    'close-sheet': function () { T = null; F = null; closeSheet(); },
    'pad': function (d) { pressKey(d.k); },
    'who': function (d) { T.who = d.v; setSheet(txHtml()); },
    'pick': function (d) { T.picker = d.side; setSheet(txHtml()); },
    'pick-back': function () { T.picker = null; setSheet(txHtml()); },
    'pick-set': function (d) {
      var wantAcc = (T.picker === 'from') === (T.type === 'expense');
      if (wantAcc) T.account_id = d.id; else T.category_id = d.id;
      T.picker = null;
      setSheet(txHtml());
    },
    'scan': function () { startScanner(); },
    'scan-close': stopScanner,
    'save-tx': function () { saveTx(false); },
    // формы
    'new-cat-expense': function () { categoryForm('expense'); },
    'new-cat-income': function () { categoryForm('income'); },
    'edit-cat': function (d) { categoryForm(null, d.id); },
    'new-acc': function () { accountForm(null); },
    'edit-acc': function (d) { accountForm(d.id); },
    'new-dep': function () { depositForm(null); },
    'edit-dep': function (d) { depositForm(d.id); },
    'f-pick': function (d) { F.values[d.k] = d.v; setSheet(formHtml()); },
    'f-save': submitForm,
    'f-extra': function () {
      var p = F.extra.run();
      if (!p) return;
      p.then(function (msg) { F = null; closeSheet(); render(); toast(msg); }).catch(function (e) { toast(errText(e)); });
    }
  };

  function scrollTop() { var s = app.querySelector('.screen'); if (s) s.scrollTop = 0; }

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return;
    var el = e.target.closest('[data-a]');
    if (!el) return;
    if (Date.now() < S.suppressClickUntil && !e.target.closest('#sheet-root')) return;
    var fn = ACTIONS[el.getAttribute('data-a')];
    if (fn) fn(el.dataset);
  });

  document.addEventListener('input', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-in');
    if (!k) return;
    if (k === 'tx-comment' && T) T.comment = e.target.value;
    if (k === 'f' && F) F.values[e.target.getAttribute('data-k')] = e.target.value;
  });
  document.addEventListener('change', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-in');
    if (k === 'tx-date' && T && e.target.value) {
      T.date = e.target.value.slice(0, 16).replace('T', ' ');
      if (T.date.length === 10) T.date += ' 12:00';
      document.getElementById('tx-date').textContent = C.humanDate(T.date);
      refreshAmount();
    }
    if (k === 'f' && F) F.values[e.target.getAttribute('data-k')] = e.target.value;
  });
  // Вернулись в приложение — подтягиваем изменения второго человека
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !S.data || !S.key) return;
    if (Date.now() - (S.lastLoad || 0) < 20000) return;
    if (document.getElementById('sheet-root') || SC) return;
    silentReload().catch(function () {});
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'key') doLogin();
  });

  start();
})();
