/* Split Bot Mini App — "Кто кому должен".
 * Plain JS, no build step. All user-provided text is rendered via DOM
 * textContent (see el()), never via innerHTML, to stay XSS-safe.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ constants

  var API_PATTERNS = [
    /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
  ];

  var CURRENCIES = [
    { code: 'RUB', symbol: '₽', name: 'Российский рубль' },
    { code: 'USD', symbol: '$', name: 'Доллар США' },
    { code: 'EUR', symbol: '€', name: 'Евро' },
    { code: 'KZT', symbol: '₸', name: 'Казахстанский тенге' },
    { code: 'UZS', symbol: 'сум', name: 'Узбекский сум' },
    { code: 'UAH', symbol: '₴', name: 'Украинская гривна' },
    { code: 'BYN', symbol: 'Br', name: 'Белорусский рубль' },
    { code: 'TRY', symbol: '₺', name: 'Турецкая лира' },
    { code: 'GEL', symbol: '₾', name: 'Грузинский лари' }
  ];
  var SYMBOLS = {};
  CURRENCIES.forEach(function (c) { SYMBOLS[c.code] = c.symbol; });

  var MAX_AMOUNT = 10000000000; // 100 000 000,00 in minor units (SPEC)
  var TITLE_MAX = 64;
  var DESCRIPTION_MAX = 100;
  var REQUEST_TIMEOUT_MS = 15000;
  var MUTATION_TIMEOUT_MS = 30000; // POST/DELETE: give a slow tunnel more time
  var UNCERTAIN_TEXT = 'Не удалось получить ответ сервера. Проверяем, сохранилось ли…';
  var OFFLINE_TEXT = 'Сервер не отвечает. Возможно, бот выключен.';
  var NBSP = ' ';

  var tg = (window.Telegram && window.Telegram.WebApp) || null;

  // ------------------------------------------------------------ state

  var state = {
    api: null,
    me: null,
    renderToken: 0,
    mainHandler: null,
    backHandler: null,
    busy: false,
    eventCache: null // last loaded event details, for instant tab switches
  };

  var appRoot = document.getElementById('app');
  var toastEl = document.getElementById('toast');

  // ------------------------------------------------------------ helpers: DOM

  /**
   * Create an element. attrs: class, text, on<Event>, aria-*, data-*, any
   * attribute or DOM property. Children: nodes or strings (as text nodes).
   */
  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key in node && key !== 'list' && key !== 'form' && typeof value !== 'string') {
          node[key] = value; // boolean / numeric properties (checked, disabled, ...)
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      });
    }
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }

  function append(parent, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(parent, c); }); return; }
    parent.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child)) : child);
  }

  function mount(node) {
    appRoot.textContent = '';
    appRoot.appendChild(node);
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------ helpers: format

  function formatMoney(amount, currency) {
    var n = Math.trunc(Number(amount) || 0);
    var sign = n < 0 ? '−' : '';
    n = Math.abs(n);
    var major = Math.floor(n / 100);
    var minor = n % 100;
    var majorStr = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
    var number = minor ? majorStr + ',' + (minor < 10 ? '0' : '') + minor : majorStr;
    var symbol = SYMBOLS[currency] || currency || '';
    return sign + number + (symbol ? NBSP + symbol : '');
  }

  /** "1 500,5" / "1500.50" -> 150050 kopecks; null if invalid. No floats. */
  function parseAmount(raw) {
    var s = String(raw || '').replace(/[\s  ]/g, '').replace(',', '.');
    var m = /^(\d{1,12})(?:\.(\d{0,2}))?$/.exec(s);
    if (!m) return null;
    var frac = (m[2] || '');
    while (frac.length < 2) frac += '0';
    var value = parseInt(m[1], 10) * 100 + parseInt(frac, 10);
    if (!isFinite(value)) return null;
    return value;
  }

  function parseDate(iso) {
    if (!iso) return null;
    var s = String(iso);
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z'; // backend sends naive UTC
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  function formatDate(iso) {
    var d = parseDate(iso);
    if (!d) return '';
    var now = new Date();
    var time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return 'сегодня, ' + time;
    var y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'вчера, ' + time;
    var opts = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('ru-RU', opts) + ', ' + time;
  }

  function plural(n, one, few, many) {
    var a = Math.abs(n) % 100;
    var b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function userName(u) {
    if (!u) return 'Неизвестный';
    var name = (u.name || '').trim();
    if (name) return name;
    if (u.username) return '@' + u.username;
    return 'Пользователь ' + u.id;
  }

  function isMe(u) {
    return !!(u && state.me && u.id === state.me.id);
  }

  /** Name for display; "Вы" for the current user. */
  function who(u) {
    return isMe(u) ? 'Вы' : userName(u);
  }

  function initials(u) {
    var parts = userName(u).replace(/^@/, '').split(/\s+/).filter(Boolean);
    var s = parts.slice(0, 2).map(function (p) { return Array.from(p)[0] || ''; }).join('');
    return (s || '?').toUpperCase();
  }

  function avatar(u) {
    var hue = ((u && u.id) || 0) % 7;
    return el('span', { class: 'avatar avatar--c' + hue, 'aria-hidden': 'true', text: initials(u) });
  }

  /** Balance badge: green "вам должны", red "вы должны", grey "всё ровно". */
  function netBadge(net, currency, opts) {
    var self = !opts || opts.self !== false;
    if (!net) return el('span', { class: 'net net--zero', text: 'всё ровно' });
    if (net > 0) {
      return el('span', { class: 'net net--plus' },
        el('span', { class: 'net__label', text: self ? 'вам должны' : 'получит' }),
        el('span', { class: 'net__amount', text: formatMoney(net, currency) }));
    }
    return el('span', { class: 'net net--minus' },
      el('span', { class: 'net__label', text: self ? 'вы должны' : 'отдаст' }),
      el('span', { class: 'net__amount', text: formatMoney(-net, currency) }));
  }

  // ------------------------------------------------------------ Telegram wrappers

  function tgVersion(v) {
    return !!(tg && typeof tg.isVersionAtLeast === 'function' && tg.isVersionAtLeast(v));
  }

  function haptic(type) {
    try {
      if (tg && tg.HapticFeedback && tgVersion('6.1')) tg.HapticFeedback.notificationOccurred(type);
    } catch (e) { /* ignore */ }
  }

  /** Light tick for selection changes (tabs, checkboxes). */
  function hapticSelect() {
    try {
      if (tg && tg.HapticFeedback && tgVersion('6.1')) tg.HapticFeedback.selectionChanged();
    } catch (e) { /* ignore */ }
  }

  // Telegram allows only one popup at a time (a second call throws) and at most
  // 256 characters of message text, so track the state and clip the text.
  var popupOpen = false;
  var POPUP_MAX = 256;

  function popupText(message) {
    var s = String(message).trim();
    return s.length > POPUP_MAX ? s.slice(0, POPUP_MAX - 1) + '…' : s;
  }

  function canPopup() {
    return !!(tg && typeof tg.showConfirm === 'function' && tgVersion('6.2'));
  }

  function showAlert(message) {
    if (canPopup() && !popupOpen) {
      try {
        popupOpen = true;
        tg.showAlert(popupText(message), function () { popupOpen = false; });
        return;
      } catch (e) { popupOpen = false; /* fall through */ }
    }
    toast(message, true);
  }

  function showConfirm(message) {
    return new Promise(function (resolve) {
      if (canPopup()) {
        if (popupOpen) { resolve(false); return; } // ignore double taps
        try {
          popupOpen = true;
          tg.showConfirm(popupText(message), function (ok) { popupOpen = false; resolve(!!ok); });
          return;
        } catch (e) { popupOpen = false; /* fall through */ }
      }
      resolve(window.confirm(String(message)));
    });
  }

  /**
   * Unsaved form input: ask before closing the Mini App and stop the vertical
   * swipe from accidentally closing it. Safe on old clients (version guards).
   */
  var dirty = false;
  function setDirty(on) {
    on = !!on;
    if (on === dirty) return;
    dirty = on;
    if (!tg) return;
    try {
      if (tgVersion('6.2')) { if (on) tg.enableClosingConfirmation(); else tg.disableClosingConfirmation(); }
    } catch (e) { /* ignore */ }
    try {
      if (tgVersion('7.7')) { if (on) tg.disableVerticalSwipes(); else tg.enableVerticalSwipes(); }
    } catch (e) { /* ignore */ }
  }

  /** Leave a form; ask first if something was typed. */
  function leaveForm(hash) {
    if (!dirty) { go(hash); return; }
    showConfirm('Выйти без сохранения? Введённые данные пропадут.').then(function (ok) {
      if (ok) { setDirty(false); go(hash); }
    });
  }

  function hideKeyboard() {
    var a = document.activeElement;
    if (a && a !== document.body && typeof a.blur === 'function') a.blur();
    try {
      if (tg && typeof tg.hideKeyboard === 'function' && tgVersion('9.1')) tg.hideKeyboard();
    } catch (e) { /* ignore */ }
  }

  function isTextField(node) {
    if (!node || !node.tagName) return false;
    if (node.tagName === 'TEXTAREA') return true;
    return node.tagName === 'INPUT' && /^(text|search|tel|number|email|url)$/i.test(node.type || 'text');
  }

  /** Keep the focused field visible above the on-screen keyboard. */
  function revealFocused() {
    var a = document.activeElement;
    if (!isTextField(a)) return;
    var r = a.getBoundingClientRect();
    var vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    var cs = getComputedStyle(document.documentElement);
    // In fullscreen mode Telegram's own buttons cover the top inset.
    var top = (parseFloat(cs.getPropertyValue('--tg-safe-area-inset-top')) || 0) +
      (parseFloat(cs.getPropertyValue('--tg-content-safe-area-inset-top')) || 0);
    if (r.top < top + 8 || r.bottom > vh - 16) {
      try { a.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { a.scrollIntoView(false); }
    }
  }

  var toastTimer = null;
  function toast(message, isError) {
    toastEl.textContent = String(message);
    toastEl.className = 'toast' + (isError ? ' toast--error' : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, isError ? 4500 : 2500);
  }

  function setBackButton(handler) {
    var bb = tg && tg.BackButton && tgVersion('6.1') ? tg.BackButton : null;
    if (state.backHandler && bb) bb.offClick(state.backHandler);
    state.backHandler = handler || null;
    if (!bb) return;
    if (handler) { bb.onClick(handler); bb.show(); } else { bb.hide(); }
  }

  /** Main button for forms. Returns a controller with progress(on). */
  function setMainButton(text, handler) {
    var mb = tg && tg.MainButton ? tg.MainButton : null;
    if (mb && state.mainHandler) mb.offClick(state.mainHandler);
    state.mainHandler = handler || null;
    if (!mb) return;
    if (!handler) {
      mb.hideProgress();
      mb.hide();
      return;
    }
    mb.setText(text);
    mb.onClick(handler);
    mb.enable();
    mb.hideProgress();
    mb.show();
  }

  function mainProgress(on) {
    var mb = tg && tg.MainButton ? tg.MainButton : null;
    if (!mb) return;
    if (on) { mb.showProgress(false); mb.disable(); } else { mb.hideProgress(); mb.enable(); }
  }

  function openShare(url, text) {
    var link = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
    if (tg && typeof tg.openTelegramLink === 'function') tg.openTelegramLink(link); // SDK handles old clients
    else window.open(link, '_blank', 'noopener');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = el('textarea', { class: 'visually-hidden', readonly: 'readonly', 'aria-hidden': 'true' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // ------------------------------------------------------------ API

  /**
   * offline: no usable answer from our backend.
   * uncertain: a mutating request got no answer — the server may still have
   * saved it, so the UI must reload real state instead of allowing a resubmit.
   */
  function ApiError(message, status, offline, uncertain) {
    this.message = message;
    this.status = status || 0;
    this.offline = !!offline;
    this.uncertain = !!uncertain;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function request(path, options) {
    options = options || {};
    var method = options.method || 'GET';
    var mutating = method !== 'GET';
    var noAnswer = function (status) {
      return mutating ? new ApiError(UNCERTAIN_TEXT, status, true, true) : new ApiError(OFFLINE_TEXT, status, true, false);
    };
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, mutating ? MUTATION_TIMEOUT_MS : REQUEST_TIMEOUT_MS) : null;
    var init = {
      method: method,
      headers: {
        'X-Telegram-Init-Data': tg ? tg.initData : '',
        'Content-Type': 'application/json'
      },
      cache: 'no-store'
    };
    if (controller) init.signal = controller.signal;
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    return fetch(state.api + path, init).then(function (res) {
      clearTimeout(timer);
      return res.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (res.ok) return data;
        // Tunnel/proxy errors (no JSON from our backend) mean the bot is off.
        if (!data && [502, 503, 504, 520, 521, 522, 523, 524, 530].indexOf(res.status) !== -1) {
          throw noAnswer(res.status);
        }
        var detail = data && typeof data.detail === 'string' ? data.detail : 'Ошибка сервера (' + res.status + ')';
        throw new ApiError(detail, res.status, false);
      });
    }, function () {
      clearTimeout(timer);
      throw noAnswer(0);
    });
  }

  function errorText(err) {
    return err && err.message ? err.message : 'Что-то пошло не так';
  }

  // ------------------------------------------------------------ generic screens

  function messageScreen(opts) {
    setMainButton(null);
    var box = el('div', { class: 'screen screen--center' },
      el('div', { class: 'message' },
        el('div', { class: 'message__icon', 'aria-hidden': 'true', text: opts.icon || '!' }),
        el('h1', { class: 'message__title', text: opts.title }),
        opts.text ? el('p', { class: 'message__text', text: opts.text }) : null,
        opts.actions || null));
    mount(box);
  }

  function errorScreen(err, retry) {
    haptic('error');
    var actions = [];
    if (retry) actions.push(el('button', { class: 'btn btn--primary', type: 'button', text: 'Повторить', onclick: retry }));
    if (err && !err.offline && currentRoute().name !== 'list') {
      actions.push(el('button', { class: 'btn btn--plain', type: 'button', text: 'К списку событий', onclick: function () { go('#/'); } }));
    }
    messageScreen({
      icon: err && err.offline ? '⚡' : '!',
      title: err && err.offline ? 'Нет связи с сервером' : 'Не получилось загрузить',
      text: errorText(err),
      actions: el('div', { class: 'message__actions' }, actions)
    });
  }

  function loadingScreen(kind) {
    var rows = [];
    for (var i = 0; i < (kind === 'form' ? 3 : 4); i++) rows.push(el('div', { class: 'skeleton skeleton--row' }));
    mount(el('div', { class: 'screen', 'aria-busy': 'true' },
      el('div', { class: 'skeleton skeleton--title' }),
      el('div', { class: 'card' }, rows),
      el('span', { class: 'visually-hidden', text: 'Загрузка…' })));
  }

  function sectionLoading() {
    return el('div', { class: 'card', 'aria-busy': 'true' },
      el('div', { class: 'skeleton skeleton--row' }),
      el('div', { class: 'skeleton skeleton--row' }),
      el('div', { class: 'skeleton skeleton--row' }));
  }

  function emptyState(title, text) {
    return el('div', { class: 'empty' },
      el('p', { class: 'empty__title', text: title }),
      text ? el('p', { class: 'empty__text', text: text }) : null);
  }

  // ------------------------------------------------------------ router

  function currentRoute() {
    var h = location.hash.replace(/^#/, '') || '/';
    var m;
    if (h === '/' || h === '') return { name: 'list' };
    if (h === '/new') return { name: 'create' };
    if ((m = /^\/e\/(\d{1,15})\/add$/.exec(h))) return { name: 'add', id: Number(m[1]) };
    if ((m = /^\/e\/(\d{1,15})(?:\/(expenses|balances|members))?$/.exec(h))) {
      return { name: 'event', id: Number(m[1]), tab: m[2] || 'expenses' };
    }
    return { name: 'list' };
  }

  /** Navigate without growing browser history; Telegram BackButton handles "back". */
  function go(hash) {
    if (location.hash === hash) { render(); return; }
    location.replace(hash);
  }

  function render() {
    state.renderToken++;
    state.busy = false;
    setDirty(false);
    if (!state.me) return; // still booting (loadMe will call render)
    var route = currentRoute();
    if (route.name === 'list') return renderList();
    if (route.name === 'create') return renderCreate();
    if (route.name === 'event') return renderEvent(route.id, route.tab);
    if (route.name === 'add') return renderAdd(route.id);
  }

  /** Returns a function that tells whether the current render is still active. */
  function renderGuard() {
    var token = state.renderToken;
    return function () { return token === state.renderToken; };
  }

  /**
   * Confirm, then run a POST/DELETE once: the button is disabled and further
   * taps are ignored until the request finishes (no double submit).
   */
  function confirmAction(button, question, send, okText, alive) {
    if (state.busy) return;
    showConfirm(question).then(function (ok) {
      if (!ok || state.busy || !alive()) return;
      state.busy = true;
      if (button) button.disabled = true;
      send().then(function () {
        haptic('success');
        toast(okText);
        if (alive()) render(); // re-render resets busy
      }, function (err) {
        haptic('error');
        if (err.uncertain) {
          // Keep the button locked and reload the screen to show what really happened.
          toast(err.message, true);
          if (alive()) render();
          return;
        }
        if (alive()) {
          state.busy = false;
          if (button) button.disabled = false;
        }
        showAlert(errorText(err));
      });
    });
  }

  // ------------------------------------------------------------ screen: events list

  function renderList() {
    setBackButton(null);
    setMainButton(null);
    var alive = renderGuard();
    loadingScreen('list');
    request('/api/events').then(function (events) {
      if (!alive()) return;
      var createBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Создать событие', onclick: function () { go('#/new'); } });
      var content;
      if (!events || !events.length) {
        content = el('div', { class: 'card' }, emptyState('Пока нет событий',
          'Создайте событие — например, «Поездка в Казань» — и пригласите друзей. Мы посчитаем, кто кому должен.'));
      } else {
        content = el('ul', { class: 'card list', role: 'list' }, events.map(function (ev) {
          return el('li', { class: 'list__item' },
            el('a', { class: 'row row--link', href: '#/e/' + ev.id, onclick: function (e) { e.preventDefault(); go('#/e/' + ev.id); } },
              el('div', { class: 'row__main' },
                el('div', { class: 'row__title', text: ev.title }),
                el('div', { class: 'row__sub', text: ev.members_count + ' ' + plural(ev.members_count, 'участник', 'участника', 'участников') + ' · ' + ev.currency })),
              el('div', { class: 'row__side' }, netBadge(ev.my_net, ev.currency)),
              el('span', { class: 'row__chevron', 'aria-hidden': 'true' })));
        }));
      }
      mount(el('div', { class: 'screen' },
        el('header', { class: 'page-header' },
          el('h1', { class: 'page-title', text: 'Мои события' }),
          state.me ? el('p', { class: 'page-sub', text: 'Привет, ' + userName(state.me) + '!' }) : null),
        content,
        el('div', { class: 'actions' }, createBtn)));
    }, function (err) {
      if (alive()) errorScreen(err, render);
    });
  }

  // ------------------------------------------------------------ screen: create event

  function renderCreate() {
    setBackButton(function () { leaveForm('#/'); });
    var titleInput = el('input', {
      class: 'input', id: 'f-title', type: 'text', maxlength: String(TITLE_MAX), autocomplete: 'off',
      autocapitalize: 'sentences', enterkeyhint: 'done',
      placeholder: 'Например, Поездка в Казань', required: 'required',
      oninput: function () { setDirty(titleInput.value.trim() !== ''); }
    });
    var currencySelect = el('select', { class: 'input', id: 'f-currency' }, CURRENCIES.map(function (c) {
      return el('option', { value: c.code, text: c.code + ' — ' + c.name + ' (' + c.symbol + ')' });
    }));
    var errorBox = el('p', { class: 'field-error', role: 'alert', hidden: 'hidden' });

    function submit() {
      if (state.busy) return;
      var title = titleInput.value.trim();
      if (!title) { fieldError(errorBox, 'Введите название события'); titleInput.focus(); return; }
      if (title.length > TITLE_MAX) { fieldError(errorBox, 'Название слишком длинное (максимум ' + TITLE_MAX + ' символов)'); return; }
      fieldError(errorBox, null);
      hideKeyboard();
      var alive = renderGuard();
      setBusy(true);
      request('/api/events', { method: 'POST', body: { title: title, currency: currencySelect.value } }).then(function (ev) {
        haptic('success');
        toast('Событие создано');
        // Stay busy until the next screen renders, so a second tap can't create a duplicate.
        if (alive()) { setDirty(false); go('#/e/' + ev.id + '/members'); }
      }, function (err) {
        haptic('error');
        if (err.uncertain) {
          // Event may have been created: stay locked and show the real list.
          toast(err.message, true);
          if (alive()) { setDirty(false); go('#/'); }
          return;
        }
        if (alive()) setBusy(false);
        showAlert(errorText(err));
      });
    }

    var form = el('form', { class: 'screen', novalidate: 'novalidate', onsubmit: function (e) { e.preventDefault(); submit(); } },
      el('header', { class: 'page-header' }, el('h1', { class: 'page-title', text: 'Новое событие' })),
      el('div', { class: 'card card--form' },
        field('Название', titleInput, 'До ' + TITLE_MAX + ' символов'),
        field('Валюта', currencySelect)),
      errorBox,
      submitFallback('Создать'));
    mount(form);
    setMainButton('Создать', submit);
  }

  function field(label, control, hint) {
    return el('div', { class: 'field' },
      el('label', { class: 'field__label', for: control.id, text: label }),
      control,
      hint ? el('p', { class: 'field__hint', text: hint }) : null);
  }

  function fieldError(box, message) {
    if (message) { box.textContent = message; box.hidden = false; haptic('error'); }
    else { box.textContent = ''; box.hidden = true; }
  }

  /** In-page submit button, shown only when Telegram MainButton is unavailable. */
  function submitFallback(text) {
    if (tg && tg.MainButton) return el('button', { type: 'submit', class: 'visually-hidden', tabindex: '-1', text: text });
    return el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'btn btn--primary btn--block', text: text }));
  }

  function setBusy(on) {
    state.busy = on;
    mainProgress(on);
    var buttons = appRoot.querySelectorAll('button[type="submit"]');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = on;
  }

  // ------------------------------------------------------------ screen: event

  function renderEvent(eventId, tab) {
    setBackButton(function () { go('#/'); });
    setMainButton(null);
    var alive = renderGuard();
    // Tab switches and returns from "add expense" reuse the last event details,
    // so the header and tabs stay in place (no full-screen skeleton flash);
    // fresh details are still fetched and patched in.
    var cached = state.eventCache && state.eventCache.id === eventId ? state.eventCache : null;
    var view = cached ? eventScreen(cached, tab, alive) : null;
    if (!view) loadingScreen('event');
    request('/api/events/' + eventId).then(function (ev) {
      state.eventCache = ev;
      if (!alive()) return;
      if (!view) { view = eventScreen(ev, tab, alive); return; }
      view.updateHeader(ev);
      if (tab === 'members') renderMembers(ev, view.panel);
    }, function (err) {
      if (err.status === 403 || err.status === 404) state.eventCache = null;
      if (!alive()) return;
      // With cached details on screen, the tab content shows its own error.
      if (!view || err.status === 403 || err.status === 404) errorScreen(err, render);
    });
  }

  function eventHeader(ev) {
    return el('header', { class: 'event-header' },
      el('h1', { class: 'page-title', text: ev.title }),
      el('div', { class: 'event-header__meta' },
        el('span', { class: 'page-sub', text: ev.members.length + ' ' + plural(ev.members.length, 'участник', 'участника', 'участников') + ' · ' + ev.currency }),
        netBadge(ev.my_net, ev.currency)));
  }

  function eventScreen(ev, tab, alive) {
    var eventId = ev.id;
    var panel = el('div', { class: 'tab-panel', role: 'tabpanel', id: 'tab-panel', 'aria-labelledby': 'tab-' + tab });
    var tabs = [['expenses', 'Траты'], ['balances', 'Балансы'], ['members', 'Участники']];
    function openTab(name) {
      if (name === tab) return;
      hapticSelect();
      go('#/e/' + eventId + (name === 'expenses' ? '' : '/' + name));
    }
    var tabBar = el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Разделы события' }, tabs.map(function (t) {
      var selected = t[0] === tab;
      return el('button', {
        class: 'tabs__tab' + (selected ? ' is-active' : ''), type: 'button', role: 'tab', id: 'tab-' + t[0],
        'aria-selected': selected ? 'true' : 'false', 'aria-controls': 'tab-panel', tabindex: selected ? '0' : '-1',
        text: t[1], onclick: function () { openTab(t[0]); },
        onkeydown: function (e) {
          var idx = tabs.findIndex(function (x) { return x[0] === tab; });
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            openTab(tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length][0]);
          }
        }
      });
    }));

    var header = eventHeader(ev);
    mount(el('div', { class: 'screen' }, header, tabBar, panel));
    var activeTab = document.getElementById('tab-' + tab);
    if (activeTab && document.activeElement && document.activeElement !== document.body) activeTab.focus({ preventScroll: true });

    if (tab === 'balances') loadBalances(ev, panel, alive);
    else if (tab === 'members') renderMembers(ev, panel);
    else loadExpenses(ev, panel, alive);

    return {
      panel: panel,
      updateHeader: function (fresh) {
        var next = eventHeader(fresh);
        header.parentNode.replaceChild(next, header);
        header = next;
      }
    };
  }

  function fillPanel(panel, nodes) {
    panel.textContent = '';
    append(panel, nodes);
  }

  // --- tab: expenses

  function loadExpenses(ev, panel, alive) {
    fillPanel(panel, sectionLoading());
    request('/api/events/' + ev.id + '/expenses').then(function (items) {
      if (!alive()) return;
      var addBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Добавить трату', onclick: function () { go('#/e/' + ev.id + '/add'); } });
      var total = (items || []).reduce(function (s, x) { return s + x.amount; }, 0);
      var list;
      if (!items || !items.length) {
        list = el('div', { class: 'card' }, emptyState('Трат пока нет', 'Добавьте первую: кто заплатил, сколько и за кого.'));
      } else {
        list = el('ul', { class: 'card list', role: 'list' }, items.map(function (x) { return expenseRow(ev, x, panel, alive); }));
      }
      fillPanel(panel, [
        el('div', { class: 'actions actions--top' }, addBtn),
        items && items.length ? el('p', { class: 'section-title', text: 'Всего потрачено: ' + formatMoney(total, ev.currency) }) : null,
        list
      ]);
    }, function (err) {
      if (!alive()) return;
      fillPanel(panel, panelError(err, function () { loadExpenses(ev, panel, alive); }));
    });
  }

  function expenseRow(ev, x, panel, alive) {
    var myShare = null;
    (x.shares || []).forEach(function (s) { if (isMe(s.user)) myShare = s.amount; });
    var canDelete = state.me && (x.created_by === state.me.id || isMe(x.payer));
    var count = (x.shares || []).length;

    var details = el('details', { class: 'expense__details' },
      el('summary', { text: count + ' ' + plural(count, 'участник', 'участника', 'участников') + (myShare !== null ? ' · ваша доля ' + formatMoney(myShare, ev.currency) : '') }),
      el('ul', { class: 'shares', role: 'list' }, (x.shares || []).map(function (s) {
        return el('li', { class: 'shares__item' },
          el('span', { class: 'shares__name', text: who(s.user) }),
          el('span', { class: 'shares__amount', text: formatMoney(s.amount, ev.currency) }));
      })));

    var del = null;
    if (canDelete) {
      del = el('button', {
        class: 'btn btn--danger-plain btn--small', type: 'button', text: 'Удалить',
        'aria-label': 'Удалить трату «' + x.description + '»',
        onclick: function () {
          confirmAction(del, 'Удалить трату «' + x.description + '» на ' + formatMoney(x.amount, ev.currency) + '?',
            function () { return request('/api/expenses/' + x.id, { method: 'DELETE' }); }, 'Трата удалена', alive);
        }
      });
    }

    return el('li', { class: 'list__item expense' },
      el('div', { class: 'row' },
        avatar(x.payer),
        el('div', { class: 'row__main' },
          el('div', { class: 'row__title', text: x.description }),
          el('div', { class: 'row__sub', text: (isMe(x.payer) ? 'Оплатили вы' : 'Оплатил(а) ' + userName(x.payer)) + ' · ' + formatDate(x.created_at) })),
        el('div', { class: 'row__side' }, el('span', { class: 'amount', text: formatMoney(x.amount, ev.currency) }))),
      el('div', { class: 'expense__footer' }, details, del));
  }

  function panelError(err, retry) {
    return el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('p', { class: 'empty__title', text: err.offline ? 'Нет связи с сервером' : 'Не получилось загрузить' }),
        el('p', { class: 'empty__text', text: errorText(err) }),
        el('button', { class: 'btn btn--primary', type: 'button', text: 'Повторить', onclick: retry })));
  }

  // --- tab: balances

  function loadBalances(ev, panel, alive) {
    fillPanel(panel, sectionLoading());
    Promise.all([
      request('/api/events/' + ev.id + '/balances'),
      request('/api/events/' + ev.id + '/settlements')
    ]).then(function (res) {
      if (!alive()) return;
      renderBalances(ev, panel, alive, res[0] || { balances: [], transfers: [] }, res[1] || []);
    }, function (err) {
      if (!alive()) return;
      fillPanel(panel, panelError(err, function () { loadBalances(ev, panel, alive); }));
    });
  }

  function renderBalances(ev, panel, alive, data, settlements) {
    var cur = ev.currency;
    var pending = settlements.filter(function (s) { return s.status === 'pending'; });
    var incoming = pending.filter(function (s) { return isMe(s.to); });
    var outgoing = pending.filter(function (s) { return isMe(s.from); });
    var others = pending.filter(function (s) { return !isMe(s.to) && !isMe(s.from); });
    var history = settlements.filter(function (s) { return s.status !== 'pending'; }).slice(0, 20);
    var nodes = [];

    function act(button, question, path, okText) {
      confirmAction(button, question, function () { return request(path, { method: 'POST' }); }, okText, alive);
    }

    if (incoming.length) {
      nodes.push(el('h2', { class: 'section-title', text: 'Нужно подтвердить' }));
      nodes.push(el('ul', { class: 'card list', role: 'list' }, incoming.map(function (s) {
        return el('li', { class: 'list__item' },
          el('div', { class: 'row' },
            avatar(s.from),
            el('div', { class: 'row__main' },
              el('div', { class: 'row__title', text: userName(s.from) + ' вернул(а) вам ' + formatMoney(s.amount, cur) }),
              el('div', { class: 'row__sub', text: formatDate(s.created_at) + ' · подтвердите, если деньги пришли' }))),
          el('div', { class: 'row-actions' },
            el('button', { class: 'btn btn--primary btn--small', type: 'button', text: 'Подтвердить', onclick: function (e) {
              act(e.currentTarget, 'Подтвердить, что ' + userName(s.from) + ' вернул(а) вам ' + formatMoney(s.amount, cur) + '?',
                '/api/settlements/' + s.id + '/confirm', 'Возврат подтверждён');
            } }),
            el('button', { class: 'btn btn--secondary btn--small', type: 'button', text: 'Отклонить', onclick: function (e) {
              act(e.currentTarget, 'Отклонить возврат ' + formatMoney(s.amount, cur) + ' от ' + userName(s.from) + '?',
                '/api/settlements/' + s.id + '/reject', 'Возврат отклонён');
            } })));
      })));
    }

    nodes.push(el('h2', { class: 'section-title', text: 'Кто кому должен' }));
    var transfers = data.transfers || [];
    if (!transfers.length) {
      nodes.push(el('div', { class: 'card' }, emptyState('Все в расчёте', 'Никто никому не должен.')));
    } else {
      nodes.push(el('ul', { class: 'card list', role: 'list' }, transfers.map(function (t) {
        var mine = isMe(t.from);
        var waiting = mine && outgoing.some(function (s) { return s.to.id === t.to.id; });
        var action = null;
        if (waiting) {
          action = el('span', { class: 'badge badge--wait', text: 'Ожидает подтверждения' });
        } else if (mine) {
          action = el('button', { class: 'btn btn--primary btn--small', type: 'button', text: 'Я вернул', onclick: function (e) {
            confirmAction(e.currentTarget,
              'Отметить, что вы вернули ' + formatMoney(t.amount, cur) + ' — ' + userName(t.to) + '? Получатель должен будет подтвердить.',
              function () {
                return request('/api/events/' + ev.id + '/settlements', { method: 'POST', body: { to_id: t.to.id, amount: t.amount } });
              }, 'Отправлено на подтверждение', alive);
          } });
        }
        var isTarget = isMe(t.to);
        return el('li', { class: 'list__item' + (mine || isTarget ? ' list__item--mine' : '') },
          el('div', { class: 'row' },
            el('div', { class: 'row__main' },
              el('div', { class: 'transfer' },
                el('span', { class: 'transfer__name', text: who(t.from) }),
                el('span', { class: 'transfer__arrow', 'aria-label': 'должен', text: '→' }),
                el('span', { class: 'transfer__name', text: isTarget ? 'вам' : userName(t.to) })),
              el('div', { class: 'row__sub ' + (mine ? 'text-minus' : isTarget ? 'text-plus' : ''), text: formatMoney(t.amount, cur) })),
            action ? el('div', { class: 'row__side' }, action) : null));
      })));
    }

    if (outgoing.length) {
      nodes.push(el('h2', { class: 'section-title', text: 'Ваши возвраты' }));
      nodes.push(el('ul', { class: 'card list', role: 'list' }, outgoing.map(function (s) {
        return el('li', { class: 'list__item' }, el('div', { class: 'row' },
          el('div', { class: 'row__main' },
            el('div', { class: 'row__title', text: 'Вы → ' + userName(s.to) + ': ' + formatMoney(s.amount, cur) }),
            el('div', { class: 'row__sub', text: formatDate(s.created_at) })),
          el('div', { class: 'row__side' }, el('span', { class: 'badge badge--wait', text: 'Ожидает подтверждения' }))));
      })));
    }

    if (others.length) {
      nodes.push(el('h2', { class: 'section-title', text: 'Ждут подтверждения' }));
      nodes.push(el('ul', { class: 'card list', role: 'list' }, others.map(function (s) {
        return el('li', { class: 'list__item' }, el('div', { class: 'row' },
          el('div', { class: 'row__main' },
            el('div', { class: 'row__title', text: userName(s.from) + ' → ' + userName(s.to) + ': ' + formatMoney(s.amount, cur) }),
            el('div', { class: 'row__sub', text: formatDate(s.created_at) }))));
      })));
    }

    nodes.push(el('h2', { class: 'section-title', text: 'Балансы участников' }));
    var balances = data.balances || [];
    if (!balances.length) {
      nodes.push(el('div', { class: 'card' }, emptyState('Пока пусто', 'Балансы появятся после первой траты.')));
    } else {
      nodes.push(el('ul', { class: 'card list', role: 'list' }, balances.map(function (b) {
        return el('li', { class: 'list__item' }, el('div', { class: 'row' },
          avatar(b.user),
          el('div', { class: 'row__main' }, el('div', { class: 'row__title', text: who(b.user) })),
          el('div', { class: 'row__side' }, netBadge(b.net, cur, { self: isMe(b.user) }))));
      })));
    }

    if (history.length) {
      nodes.push(el('h2', { class: 'section-title', text: 'История возвратов' }));
      nodes.push(el('ul', { class: 'card list', role: 'list' }, history.map(function (s) {
        var ok = s.status === 'confirmed';
        return el('li', { class: 'list__item' }, el('div', { class: 'row' },
          el('div', { class: 'row__main' },
            el('div', { class: 'row__title', text: who(s.from) + ' → ' + (isMe(s.to) ? 'вам' : userName(s.to)) + ': ' + formatMoney(s.amount, cur) }),
            el('div', { class: 'row__sub', text: formatDate(s.created_at) })),
          el('div', { class: 'row__side' }, el('span', { class: 'badge ' + (ok ? 'badge--ok' : 'badge--no'), text: ok ? 'подтверждён' : 'отклонён' }))));
      })));
    }

    fillPanel(panel, nodes);
  }

  // --- tab: members

  function renderMembers(ev, panel) {
    var nodes = [];
    nodes.push(el('ul', { class: 'card list', role: 'list' }, ev.members.map(function (u) {
      return el('li', { class: 'list__item' }, el('div', { class: 'row' },
        avatar(u),
        el('div', { class: 'row__main' },
          el('div', { class: 'row__title' }, userName(u),
            isMe(u) ? el('span', { class: 'badge badge--me', text: 'вы' }) : null,
            u.id === ev.owner_id ? el('span', { class: 'badge', text: 'создатель' }) : null),
          u.username ? el('div', { class: 'row__sub', text: '@' + u.username }) : null)));
    })));

    if (ev.invite_link) {
      var link = ev.invite_link;
      nodes.push(el('div', { class: 'actions' },
        el('button', { class: 'btn btn--primary btn--block', type: 'button', text: 'Пригласить друзей', onclick: function () {
          openShare(link, 'Присоединяйся к «' + ev.title + '» — считаем, кто кому должен');
        } }),
        el('button', { class: 'btn btn--secondary btn--block', type: 'button', text: 'Скопировать ссылку', onclick: function () {
          copyText(link).then(function (ok) {
            if (ok) { haptic('success'); toast('Ссылка скопирована'); }
            else showAlert('Не удалось скопировать. Ссылка: ' + link);
          });
        } })));
      nodes.push(el('p', { class: 'hint', text: 'Друг откроет ссылку, нажмёт «Запустить» в боте — и сразу окажется в событии.' }));
    } else {
      nodes.push(el('p', { class: 'hint', text: 'Ссылка-приглашение пока недоступна. Попробуйте позже.' }));
    }
    fillPanel(panel, nodes);
  }

  // ------------------------------------------------------------ screen: add expense

  function renderAdd(eventId) {
    setBackButton(function () { leaveForm('#/e/' + eventId); });
    setMainButton(null);
    var alive = renderGuard();
    loadingScreen('form');
    request('/api/events/' + eventId).then(function (ev) {
      if (!alive()) return;
      buildAddForm(ev, alive);
    }, function (err) {
      if (alive()) errorScreen(err, render);
    });
  }

  function buildAddForm(ev, alive) {
    var members = ev.members || [];
    var symbol = SYMBOLS[ev.currency] || ev.currency;
    var amountInput = el('input', {
      class: 'input input--amount', id: 'f-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off',
      enterkeyhint: 'next', placeholder: '0', 'aria-describedby': 'f-amount-hint',
      // Enter / "next" on the keypad moves on to the description.
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); descInput.focus(); } }
    });
    var descInput = el('input', {
      class: 'input', id: 'f-desc', type: 'text', maxlength: String(DESCRIPTION_MAX), autocomplete: 'off',
      autocapitalize: 'sentences', enterkeyhint: 'done', placeholder: 'Например, Ужин в кафе',
      // "Done" just hides the keyboard so payer / participants can be checked before saving.
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); hideKeyboard(); } }
    });
    function updateDirty() { setDirty(amountInput.value.trim() !== '' || descInput.value.trim() !== ''); }
    amountInput.addEventListener('input', updateDirty);
    descInput.addEventListener('input', updateDirty);
    var payerSelect = el('select', { class: 'input', id: 'f-payer' }, members.map(function (u) {
      return el('option', { value: String(u.id), text: isMe(u) ? userName(u) + ' (вы)' : userName(u), selected: isMe(u) });
    }));
    var preview = el('p', { class: 'field__hint', id: 'f-amount-hint', 'aria-live': 'polite' });
    var errorBox = el('p', { class: 'field-error', role: 'alert', hidden: 'hidden' });

    var checkboxes = [];
    var participantList = el('ul', { class: 'checks', role: 'list' }, members.map(function (u) {
      var cb = el('input', { type: 'checkbox', class: 'checks__box', id: 'p-' + u.id, value: String(u.id), checked: true,
        onchange: function () { hapticSelect(); updatePreview(); } });
      checkboxes.push(cb);
      return el('li', { class: 'checks__item' },
        el('label', { class: 'checks__label', for: 'p-' + u.id },
          cb,
          el('span', { class: 'checks__mark', 'aria-hidden': 'true' }),
          avatar(u),
          el('span', { class: 'checks__name', text: isMe(u) ? userName(u) + ' (вы)' : userName(u) })));
    }));

    function setAll(on) {
      checkboxes.forEach(function (cb) { cb.checked = on; });
      updatePreview();
    }

    function selectedIds() {
      return checkboxes.filter(function (cb) { return cb.checked; }).map(function (cb) { return Number(cb.value); });
    }

    function updatePreview() {
      var amount = parseAmount(amountInput.value);
      var n = selectedIds().length;
      if (!amountInput.value.trim()) preview.textContent = 'В ' + symbol + ', можно с копейками: 1500 или 1500,50';
      else if (amount === null || amount <= 0) preview.textContent = 'Введите сумму числом, например 1500,50';
      else if (amount > MAX_AMOUNT) preview.textContent = 'Слишком большая сумма';
      else if (!n) preview.textContent = 'Выберите, на кого делить';
      else preview.textContent = n === 1 ? 'Вся сумма на одного человека' : 'Примерно по ' + formatMoney(Math.floor(amount / n), ev.currency) + ' на человека';
    }
    amountInput.addEventListener('input', updatePreview);
    updatePreview();

    function submit() {
      if (state.busy) return;
      var amount = parseAmount(amountInput.value);
      var desc = descInput.value.trim();
      var ids = selectedIds();
      if (amount === null || amount <= 0) { fieldError(errorBox, 'Введите сумму больше нуля, например 1500 или 1500,50'); amountInput.focus(); return; }
      if (amount > MAX_AMOUNT) { fieldError(errorBox, 'Сумма слишком большая'); amountInput.focus(); return; }
      if (!desc) { fieldError(errorBox, 'Напишите, за что платили'); descInput.focus(); return; }
      if (!ids.length) {
        fieldError(errorBox, 'Выберите хотя бы одного участника');
        hideKeyboard();
        try { errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { errorBox.scrollIntoView(false); }
        return;
      }
      fieldError(errorBox, null);
      hideKeyboard();
      setBusy(true);
      request('/api/events/' + ev.id + '/expenses', {
        method: 'POST',
        body: { amount: amount, description: desc, payer_id: Number(payerSelect.value), participant_ids: ids }
      }).then(function () {
        haptic('success');
        toast('Трата добавлена');
        // Stay busy until the next screen renders, so a second tap can't add a duplicate.
        if (alive()) { setDirty(false); go('#/e/' + ev.id); }
      }, function (err) {
        haptic('error');
        if (err.uncertain) {
          // Expense may have been saved: stay locked and show the real list.
          toast(err.message, true);
          if (alive()) { setDirty(false); go('#/e/' + ev.id); }
          return;
        }
        if (alive()) setBusy(false);
        showAlert(errorText(err));
      });
    }

    var form = el('form', { class: 'screen', novalidate: 'novalidate', onsubmit: function (e) { e.preventDefault(); submit(); } },
      el('header', { class: 'page-header' },
        el('h1', { class: 'page-title', text: 'Новая трата' }),
        el('p', { class: 'page-sub', text: ev.title })),
      el('div', { class: 'card card--form' },
        el('div', { class: 'field' },
          el('label', { class: 'field__label', for: 'f-amount', text: 'Сумма, ' + symbol }),
          amountInput,
          preview),
        field('За что', descInput),
        field('Кто платил', payerSelect)),
      errorBox, // right under the fields, so it is visible when one of them gets focus
      el('div', { class: 'section-head' },
        el('h2', { class: 'section-title', text: 'На кого делим' }),
        el('div', { class: 'section-head__buttons' },
          el('button', { class: 'btn btn--link', type: 'button', text: 'Выбрать всех', onclick: function () { setAll(true); } }),
          el('button', { class: 'btn btn--link', type: 'button', text: 'Никого', onclick: function () { setAll(false); } }))),
      el('div', { class: 'card' }, participantList),
      submitFallback('Сохранить'));
    mount(form);
    setMainButton('Сохранить', submit);
  }

  // ------------------------------------------------------------ boot

  function readParams() {
    var params = new URLSearchParams(location.search);
    var api = (params.get('api') || '').trim();
    if (api.slice(-1) === '/') api = api.slice(0, -1);
    var valid = API_PATTERNS.some(function (re) { return re.test(api); });
    var event = params.get('event');
    return { api: valid ? api : null, rawApi: api, event: event && /^\d{1,15}$/.test(event) ? event : null };
  }

  function loadMe() {
    loadingScreen('list');
    request('/api/me').then(function (me) {
      state.me = me;
      render();
    }, function (err) {
      errorScreen(err, loadMe);
    });
  }

  /** Match Telegram's colors; called at start and on every themeChanged. */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', tg.colorScheme === 'dark' ? 'dark' : 'light');
    // Color keys (not hex) so Telegram re-resolves them itself when the theme changes.
    try {
      if (tgVersion('6.1')) {
        tg.setHeaderColor('secondary_bg_color');
        tg.setBackgroundColor('secondary_bg_color');
      }
    } catch (e) { /* ignore */ }
    try {
      if (tgVersion('7.10') && typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor('secondary_bg_color');
    } catch (e) { /* ignore */ }
  }

  function boot() {
    if (tg) {
      try {
        applyTheme();
        if (typeof tg.onEvent === 'function') {
          tg.onEvent('themeChanged', applyTheme);
          // Keyboard opened/closed or the sheet was resized: keep the focused field visible.
          tg.onEvent('viewportChanged', function (e) { if (!e || e.isStateStable) revealFocused(); });
          tg.onEvent('popupClosed', function () { popupOpen = false; });
        }
        tg.ready();
        tg.expand();
      } catch (e) { /* older clients */ }
    }
    document.addEventListener('focusin', function (e) {
      if (isTextField(e.target)) setTimeout(revealFocused, 350); // after the keyboard animation
    });

    var params = readParams();
    if (!tg || !tg.initData) {
      messageScreen({
        icon: '✈',
        title: 'Откройте через Telegram-бота',
        text: 'Это приложение работает только внутри Telegram. Откройте бота и нажмите кнопку «Открыть».'
      });
      return;
    }
    if (!params.api) {
      messageScreen({
        icon: '!',
        title: 'Неверная ссылка',
        text: params.rawApi
          ? 'Адрес сервера в ссылке не похож на настоящий. Откройте приложение заново кнопкой в боте.'
          : 'В ссылке нет адреса сервера. Откройте приложение кнопкой в боте.'
      });
      return;
    }
    state.api = params.api;

    // Telegram puts its launch params into the hash (#tgWebAppData=...); the SDK has
    // already read them, so replace any non-route hash with our start route.
    if (!/^#\//.test(location.hash)) {
      history.replaceState(null, '', location.pathname + location.search + (params.event ? '#/e/' + params.event : '#/'));
    }
    window.addEventListener('hashchange', render);
    loadMe();
  }

  boot();
})();
