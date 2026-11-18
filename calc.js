/* Чистые функции: деньги, даты, чеки, вклады. Без DOM — их можно тестировать отдельно. */
(function (root) {
  'use strict';

  var MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var MONTHS_DAT = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];
  var WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** 1543.9 → «1 543,90», 150000 → «150 000» */
  function fmtMoney(n) {
    var neg = n < 0;
    var v = Math.round(Math.abs(n) * 100) / 100;
    var int = Math.floor(v);
    var frac = Math.round((v - int) * 100);
    var s = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (frac) s += ',' + pad(frac);
    return (neg ? '−' : '') + s;
  }

  function toDateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toDateTimeStr(d) { return toDateStr(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  /** «2026-11-17» или «2026-11-17 16:22» → Date (локальное время) */
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(s || ''));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  }

  function monthKey(dateStr) { return String(dateStr).slice(0, 7); }
  function monthLabel(key) {
    var y = +key.slice(0, 4), m = +key.slice(5, 7);
    return MONTHS[m - 1] + ' ' + y;
  }
  function shiftMonth(key, delta) {
    var y = +key.slice(0, 4), m = +key.slice(5, 7) - 1 + delta;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + '-' + pad(m + 1);
  }
  function monthDative(key) { return MONTHS_DAT[+key.slice(5, 7) - 1]; }

  /** «Сегодня, 18 ноября» / «17 ноября, 16:22» */
  function humanDate(dateTimeStr, now) {
    var d = parseDate(dateTimeStr);
    if (!d) return '';
    now = now || new Date();
    var sameDay = toDateStr(d) === toDateStr(now);
    var y = new Date(now); y.setDate(now.getDate() - 1);
    var label = d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) label += ' ' + d.getFullYear();
    var hasTime = /\d{2}:\d{2}$/.test(dateTimeStr);
    if (sameDay) return 'Сегодня, ' + label;
    if (toDateStr(d) === toDateStr(y)) return 'Вчера, ' + label;
    return hasTime ? label + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : label;
  }

  function dayHeader(dateStr, now) {
    var d = parseDate(dateStr);
    now = now || new Date();
    var base = d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (toDateStr(d) === toDateStr(now)) return 'Сегодня, ' + base;
    if (toDateStr(d) === toDateStr(y)) return 'Вчера, ' + base;
    return base + ', ' + WEEKDAYS[d.getDay()];
  }

  /**
   * QR-код российского кассового чека:
   * t=20261117T1622&s=1543.90&fn=7380440700076549&i=12345&fp=1234567890&n=1
   * Возвращает null, если это не чек.
   */
  function parseReceiptQR(text) {
    var str = String(text || '').trim();
    if (str.indexOf('t=') === -1 || str.indexOf('s=') === -1) return null;
    var params = {};
    str.replace(/^\?/, '').split('&').forEach(function (part) {
      var i = part.indexOf('=');
      if (i > 0) params[part.slice(0, i).toLowerCase()] = decodeURIComponent(part.slice(i + 1));
    });
    var amount = parseFloat(String(params.s || '').replace(',', '.'));
    var tm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(params.t || '');
    if (!(amount > 0) || !tm) return null;
    return {
      amount: Math.round(amount * 100) / 100,
      date: tm[1] + '-' + tm[2] + '-' + tm[3] + ' ' + tm[4] + ':' + tm[5],
      fn: params.fn || '', i: params.i || '', fp: params.fp || '',
      n: params.n || '1',
      isRefund: params.n === '2' || params.n === '4',
      raw: str
    };
  }

  function daysInYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365; }

  function addMonths(date, k) {
    var d = new Date(date.getFullYear(), date.getMonth() + k, 1);
    var last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(date.getDate(), last));
    return d;
  }

  /**
   * Вклад: проценты начисляются за каждый день по ставке / дней в году (365 или 366).
   * capitalization: 'daily' — прибавляются к сумме каждый день,
   *                 'monthly' — раз в месяц, в день открытия,
   *                 'none' — копятся отдельно, на сумму не начисляются.
   * Возвращает состояние на дату asOf (не дальше конца срока).
   */
  function depositAt(dep, asOf) {
    var start = parseDate(dep.start_date);
    var principal = Number(dep.principal) || 0;
    var rate = (Number(dep.rate) || 0) / 100;
    var term = Math.max(0, Math.round(Number(dep.term_months) || 0));
    var end = term ? addMonths(start, term) : null;
    var target = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    if (end && target > end) target = end;

    var balance = principal, pending = 0, k = 1;
    var nextCap = addMonths(start, 1);
    var day = new Date(start);
    while (day < target) {
      pending += balance * rate / daysInYear(day.getFullYear());
      day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      if (dep.capitalization === 'daily') {
        balance += pending; pending = 0;
      } else if (dep.capitalization === 'monthly' && day.getTime() === nextCap.getTime()) {
        balance += pending; pending = 0;
        k += 1; nextCap = addMonths(start, k);
      }
    }
    var total = balance + pending;
    return {
      start: start,
      end: end,
      balance: round2(total),
      interest: round2(total - principal),
      finished: !!end && asOf >= end
    };
  }

  function depositSummary(dep, now) {
    now = now || new Date();
    var cur = depositAt(dep, now);
    var horizon = cur.end || addMonths(cur.start, 12);
    var fin = depositAt(dep, horizon);
    var progress = cur.end ? Math.min(1, Math.max(0, (now - cur.start) / (cur.end - cur.start))) : null;
    return { now: cur, atEnd: fin, horizon: horizon, openEnded: !cur.end, progress: progress };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /** Сводка за месяц */
  function monthSummary(txs, key) {
    var byCat = {}, income = 0, expense = 0, count = 0;
    txs.forEach(function (t) {
      if (monthKey(t.date) !== key) return;
      count++;
      if (t.type === 'income') { income += t.amount; }
      else { expense += t.amount; }
      byCat[t.category_id] = (byCat[t.category_id] || 0) + t.amount;
    });
    return { byCat: byCat, income: round2(income), expense: round2(expense), count: count };
  }

  function accountBalance(acc, txs) {
    var b = Number(acc.start_balance) || 0;
    txs.forEach(function (t) {
      if (t.account_id !== acc.id) return;
      b += t.type === 'income' ? t.amount : -t.amount;
    });
    return round2(b);
  }

  /** Строка суммы с клавиатуры: «1543,9» → 1543.9 */
  function amountFromInput(s) { return parseFloat(String(s).replace(',', '.')) || 0; }

  function pluralOps(n) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return n + ' операция';
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return n + ' операции';
    return n + ' операций';
  }

  var api = {
    fmtMoney: fmtMoney, toDateStr: toDateStr, toDateTimeStr: toDateTimeStr, parseDate: parseDate,
    monthKey: monthKey, monthLabel: monthLabel, shiftMonth: shiftMonth, monthDative: monthDative,
    humanDate: humanDate, dayHeader: dayHeader, parseReceiptQR: parseReceiptQR,
    depositAt: depositAt, depositSummary: depositSummary, addMonths: addMonths,
    monthSummary: monthSummary, accountBalance: accountBalance,
    amountFromInput: amountFromInput, pluralOps: pluralOps, MONTHS_GEN: MONTHS_GEN
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetCalc = api;
})(this);
