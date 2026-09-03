// ==UserScript==
// @name         Reddit Notifications Floating Panel
// @namespace    https://github.com/VitaKaninen
// @version      6.15.0
// @description  Right-click the Reddit notifications bell to open a floating, movable, resizable panel that lists your notifications and lets you mark them read
// @author       VitaKaninen
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @connect      www.reddit.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/Reddit-Notifications-Floating-Panel/main/Reddit-Notifications-Floating-Panel.user.js
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/Reddit-Notifications-Floating-Panel/main/Reddit-Notifications-Floating-Panel.user.js
// ==/UserScript==

/*
 * v6 is a ground-up rewrite. The panel no longer embeds reddit.com/notifications in an
 * iframe. It fetches the same server-rendered partial that Reddit's own inbox page uses
 * (`/svc/shreddit/notifications-inbox-content/<n>/route?render-mode=partial`), parses the
 * `<notification-item>` elements out of it, and renders its own list. Marking read goes
 * through the same GraphQL operations Reddit's page uses (`MarkNotificationRead`,
 * `MarkInboxAsRead`), authenticated by the `csrf_token` cookie.
 *
 * All injected DOM is built with createElement/textContent (no innerHTML) so the script
 * survives Trusted Types CSPs.
 */

(function () {
  'use strict';

  if (window !== window.top) return;
  if (document.getElementById('rnfp-loaded')) return;
  const loadedMarker = document.createElement('meta');
  loadedMarker.id = 'rnfp-loaded';
  document.head.appendChild(loadedMarker);

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const ORIGIN        = 'https://www.reddit.com';
  const NOTIF_PAGE    = ORIGIN + '/notifications/';
  const INBOX_PARTIAL = ORIGIN + '/svc/shreddit/notifications-inbox-content/20/route?render-mode=partial';
  const GRAPHQL_URL   = ORIGIN + '/svc/shreddit/graphql';
  const IS_OLD_REDDIT = location.hostname === 'old.reddit.com';
  const BELL_ID       = IS_OLD_REDDIT ? 'notifications' : 'notifications-inbox-button';

  const PANEL_ID   = 'rnfp-panel';
  const CTX_ID     = 'rnfp-ctx';
  const Z_INDEX    = 2147483646;
  const HEADER_H   = 34;
  const MIN_W      = 260;
  const MIN_H      = 120;
  const EDGE       = 6;
  const SNAP       = 8;
  const MIN_REFRESH_MS = 10000;
  const REQUEST_TIMEOUT_MS = 20000;

  // Edge anchoring. The panel's LEFT edge is held at an offset from the page's right sidebar,
  // so the panel never creeps over the post column as the window widens. Its TOP, RIGHT and
  // BOTTOM edges are held at offsets from the window's own edges, so nothing about the page's
  // vertical layout — scroll position above all — can change the panel's height. Dragging or
  // resizing the panel simply rewrites those four offsets, so it keeps tracking afterwards.
  // FOLLOW_INSET is the left/top offset a reset starts from. `box` is the element whose top
  // we read (the sticky container on www); `inner` gives the left edge (the 306px card).
  const FOLLOW_INSET = 20;
  const SIDEBAR = IS_OLD_REDDIT
    ? { box: '.side', inner: '.side' }
    : { box: '#right-sidebar-container', inner: '#right-sidebar-contents' };

  // Crib sheet shown under the custom-interval box. Seconds stop being readable somewhere
  // around "how long is 21600", which is exactly when someone wants a multi-hour interval.
  const LONG_INTERVALS = [
    ['30 min', 1800],
    ['1 hour', 3600],
    ['2 hours', 7200],
    ['6 hours', 21600],
    ['12 hours', 43200],
    ['24 hours', 86400],
  ];

  const REFRESH_OPTIONS = [
    { label: '30 sec', ms: 30000 },
    { label: '1 min',  ms: 60000 },
    { label: '2 min',  ms: 120000 },
    { label: '5 min',  ms: 300000 },
    { label: '10 min', ms: 600000 },
    { label: 'Off',    ms: 0 },
  ];

  const KEY_GEOMETRY = 'rnfp.geometry';
  const KEY_SETTINGS = 'rnfp.settings';
  const KEY_PAGES    = 'rnfp.pages';
  const SS_MINIMIZED = 'rnfp.minimized';

  const DEFAULT_SETTINGS = {
    refreshMs: 120000,
    newTab: true,
    switchTab: true,
    markReadOnOpen: true,
    titleCount: true,
    titleFlash: true,
    // 'never' | 'listings' | 'all' — what an untouched page does on arrival.
    startOpen: 'listings',
    // Manual opens/closes are recorded per page and override startOpen.
    rememberPages: true,
  };
  const START_OPEN_VALUES = ['never', 'listings', 'all'];

  // Per-page memory. Entries are created ONLY by a manual open/close, never by merely
  // visiting, so the budget is not spent on pages the panel was never touched on.
  // A year of inactivity is the real eviction rule; the count is a backstop that a normal
  // user will never reach (see CLAUDE.md for the sizing).
  const PAGE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
  const PAGE_MAX    = 5000;

  // Tab title indicator: how many times the title blinks when the unread count goes up.
  const FLASH_CYCLES = 2;
  const FLASH_MS     = 800;

  // ---------------------------------------------------------------------------
  // Small DOM helpers (no innerHTML anywhere)
  // ---------------------------------------------------------------------------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'style') node.style.cssText = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function svgIcon(paths, size, opts) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    const o = Object.assign({ fill: 'none', stroke: 'currentColor', width: 2, viewBox: '0 0 24 24' }, opts || {});
    svg.setAttribute('viewBox', o.viewBox);
    svg.setAttribute('fill', o.fill);
    svg.setAttribute('stroke', o.stroke);
    svg.setAttribute('stroke-width', String(o.width));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  const ICON = {
    // Reddit's own header bell (`icon-name="notifications"`, 20x20), copied verbatim so the
    // panel header mirrors the top bar.
    bell:     () => svgIcon(['m18.176 14.218-.925-1.929a2.577 2.577 0 01-.25-1.105V8c0-3.86-3.142-7-7-7-3.86 0-7 3.14-7 7v3.184c0 .38-.088.762-.252 1.105l-.927 1.932A1.103 1.103 0 002.82 15.8h3.26A4.007 4.007 0 0010 19a4.008 4.008 0 003.918-3.2h3.26a1.1 1.1 0 00.934-.514 1.1 1.1 0 00.062-1.068h.002ZM10 17.2c-.93 0-1.722-.583-2.043-1.4h4.087a2.197 2.197 0 01-2.043 1.4ZM3.925 14l.447-.933c.28-.584.43-1.235.43-1.883V8c0-2.867 2.331-5.2 5.198-5.2A5.205 5.205 0 0115.2 8v3.184c0 .648.147 1.299.428 1.883l.447.933H3.925Z'], 20, { fill: 'currentColor', stroke: 'none', viewBox: '0 0 20 20' }),
    check:    () => svgIcon(['M20 6 9 17l-5-5'], 14),
    checkAll: () => svgIcon(['M18 6 7 17l-5-5', 'm22 10-7.5 7.5L13 16'], 14),
    reload:   () => svgIcon(['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'], 14),
    chevron:  () => svgIcon(['m6 9 6 6 6-6'], 12),
    gear:     () => svgIcon(['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'], 14),
    minimize: () => svgIcon(['M5 12h14'], 14),
    restore:  () => svgIcon(['M4 6h16v12H4z'], 14),
    close:    () => svgIcon(['M18 6 6 18', 'm6 6 12 12'], 14),
    external: () => svgIcon(['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'], 14),
    reset:    () => svgIcon(['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'], 14),
    panel:    () => svgIcon(['M3 5h18v14H3z', 'M3 9h18'], 14),
    user:     () => svgIcon(['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'], 18),
  };

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------
  function loadJSON(key, fallback) {
    try {
      const raw = GM_getValue(key, null);
      if (raw === null || raw === undefined) return { ...fallback };
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Object.assign({}, fallback, parsed);
    } catch (_) { return { ...fallback }; }
  }
  function saveJSON(key, value) { GM_setValue(key, JSON.stringify(value)); }

  const settings = loadJSON(KEY_SETTINGS, DEFAULT_SETTINGS);
  function saveSettings() { saveJSON(KEY_SETTINGS, settings); }

  // v6.6 stored the same choice as two booleans. Fold them into startOpen once, then drop
  // them, so a save written by 6.6 keeps behaving the way its owner set it up.
  if (typeof settings.autoOpenSub === 'boolean') {
    settings.startOpen = !settings.autoOpenSub ? 'never' : (settings.autoOpenAll ? 'all' : 'listings');
    delete settings.autoOpenSub;
    delete settings.autoOpenAll;
    saveSettings();
  }
  if (!START_OPEN_VALUES.includes(settings.startOpen)) settings.startOpen = DEFAULT_SETTINGS.startOpen;

  // ---------------------------------------------------------------------------
  // Per-page memory
  //
  // One GM value holding { "<path>": { o: 1|0, t: <ms of last visit> } }. Read once at
  // boot, swept, and written back only when something actually changes — a recency bump
  // alone is flushed lazily on pagehide, because bumps happen on every navigation and the
  // whole map is rewritten as a single value.
  // ---------------------------------------------------------------------------
  let pages = {};
  let pagesDirty = false;

  // What counts as "a page": the pathname, lowercased, without a trailing slash, and with
  // the query and hash dropped — so /r/pics, /r/pics/, /r/pics/?f=x and /r/pics#foo are one
  // page, and old.reddit shares its state with www.
  function pageKey(path) {
    let p = (path === undefined ? location.pathname : path).toLowerCase();
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p || '/';
  }

  function loadPages() {
    const raw = loadJSON(KEY_PAGES, {});
    const cutoff = Date.now() - PAGE_TTL_MS;
    const kept = Object.entries(raw)
      .filter(([, v]) => v && typeof v.t === 'number' && v.t >= cutoff)
      .sort((a, b) => b[1].t - a[1].t)   // newest first, so slice() drops the stalest
      .slice(0, PAGE_MAX);
    if (kept.length !== Object.keys(raw).length) pagesDirty = true;
    pages = Object.fromEntries(kept);
  }

  function savePages() { if (pagesDirty) { saveJSON(KEY_PAGES, pages); pagesDirty = false; } }

  // The remembered state for this page, or null if it has never been set here.
  function pageState(key) {
    const e = pages[key === undefined ? pageKey() : key];
    return e ? !!e.o : null;
  }

  // Record a manual open/close. Written through immediately — this is the user making a
  // decision, and losing it to a crashed tab would be the one failure they would notice.
  function setPageState(open) {
    pages[pageKey()] = { o: open ? 1 : 0, t: Date.now() };
    pagesDirty = true;
    if (Object.keys(pages).length > PAGE_MAX) loadPages();
    savePages();
  }

  // Revisiting a remembered page moves it back to the top, so only pages left alone for a
  // year fall off. Pages with no entry are deliberately not created here.
  function touchPage() {
    const k = pageKey();
    if (!pages[k]) return;
    pages[k].t = Date.now();
    pagesDirty = true;
  }

  loadPages();
  window.addEventListener('pagehide', savePages);
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePages(); });

  // ---------------------------------------------------------------------------
  // Viewport geometry. clientWidth/clientHeight exclude the scrollbars, which is
  // the whole reason the old panel used to sit under them (innerWidth includes them).
  // ---------------------------------------------------------------------------
  function viewport() {
    const de = document.documentElement;
    return { w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight };
  }

  function defaultGeometry() {
    const vp = viewport();
    const w = Math.min(380, vp.w);
    const h = Math.min(Math.max(Math.round(vp.h * 0.6), MIN_H), vp.h);
    return { x: vp.w - w, y: vp.h - h, w, h, vw: vp.w, vh: vp.h };
  }

  function clampGeometry(g) {
    const vp = viewport();
    const w = Math.min(Math.max(g.w, MIN_W), vp.w);
    const h = Math.min(Math.max(g.h, MIN_H), vp.h);
    const x = Math.max(0, Math.min(g.x, vp.w - w));
    const y = Math.max(0, Math.min(g.y, vp.h - h));
    return { x, y, w, h };
  }

  // Re-anchor a saved geometry to the current viewport: keep whichever edge the panel
  // was closer to (so a right-docked panel stays right-docked when the window changes).
  function adaptGeometry(saved) {
    const vp = viewport();
    let g = { x: saved.x, y: saved.y, w: saved.w, h: saved.h };
    if (saved.vw && saved.vh && (saved.vw !== vp.w || saved.vh !== vp.h)) {
      const dl = saved.x, dr = saved.vw - (saved.x + saved.w);
      const dt = saved.y, db = saved.vh - (saved.y + saved.h);
      if (dr <= dl) g.x = vp.w - dr - g.w;
      if (db <= dt) g.y = vp.h - db - g.h;
    }
    return clampGeometry(g);
  }

  function snapGeometry(g) {
    const vp = viewport();
    const out = { ...g };
    if (Math.abs(out.x) <= SNAP) out.x = 0;
    if (Math.abs(out.x + out.w - vp.w) <= SNAP) out.x = vp.w - out.w;
    if (Math.abs(out.y) <= SNAP) out.y = 0;
    if (Math.abs(out.y + out.h - vp.h) <= SNAP) out.y = vp.h - out.h;
    return out;
  }

  function snappedEdges(g) {
    const vp = viewport();
    return {
      left:   Math.abs(g.x) <= SNAP,
      right:  Math.abs(g.x + g.w - vp.w) <= SNAP,
      top:    Math.abs(g.y) <= SNAP,
      bottom: Math.abs(g.y + g.h - vp.h) <= SNAP,
    };
  }

  // Left edge of the page's right sidebar, or null when the page has none or Reddit has
  // hidden it (below its `s` breakpoint the container is display:none, so its rect collapses
  // to 0x0). Vertical scrolling never moves this, which is why only the left edge tracks it.
  function sidebarLeft() {
    const box = document.querySelector(SIDEBAR.box);
    if (!box) return null;
    const inner = document.querySelector(SIDEBAR.inner) || box;
    const b = box.getBoundingClientRect();
    const i = inner.getBoundingClientRect();
    if (b.width < 1 || b.height < 1 || i.width < 1) return null;
    return i.left;
  }

  // Where the sidebar's top edge sits with the page scrolled to the top. Reddit's sidebar is
  // position:sticky, so both its live rect.top and its offsetTop shrink as you scroll (both
  // verified 2026-09-02) and reading either would make a reset — or a reload that lands
  // mid-page — open a taller panel than intended. The nearest non-sticky ancestor keeps the
  // layout position we actually want: 192 on a subreddit, 56 on home, at any scroll offset.
  function sidebarTopUnscrolled() {
    const box = document.querySelector(SIDEBAR.box);
    if (!box) return null;
    const r = box.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    let ref = box;
    while (ref && getComputedStyle(ref).position === 'sticky') ref = ref.parentElement;
    if (!ref) ref = box;
    return Math.max(0, Math.round(ref.getBoundingClientRect().top + window.scrollY));
  }

  // anchor -> geometry. Null when there is no usable sidebar (or no room left for the panel),
  // in which case callers keep whatever geometry they already have.
  function anchorToGeometry(a) {
    const sx = sidebarLeft();
    if (sx === null || !a) return null;
    const vp = viewport();
    const x = sx + a.left, y = a.top;
    if (vp.w - a.right - x < MIN_W || vp.h - a.bottom - y < MIN_H) return null;
    return clampGeometry({ x, y, w: vp.w - a.right - x, h: vp.h - a.bottom - y });
  }

  // geometry -> anchor, after a drag or a resize. With the sidebar hidden there is nothing to
  // measure the left edge against, so that one offset keeps its previous value.
  function geometryToAnchor(g) {
    const sx = sidebarLeft();
    const vp = viewport();
    return {
      left:   sx === null ? (anchor ? anchor.left : FOLLOW_INSET) : Math.round(g.x - sx),
      top:    Math.round(g.y),
      right:  Math.round(vp.w - (g.x + g.w)),
      bottom: Math.round(vp.h - (g.y + g.h)),
    };
  }

  // The reset placement: FOLLOW_INSET inside the sidebar's top-left corner, right and bottom
  // edges flush with the window.
  function defaultAnchor() {
    const top = sidebarTopUnscrolled();
    if (top === null) return null;
    return { left: FOLLOW_INSET, top: top + FOLLOW_INSET, right: 0, bottom: 0 };
  }

  function validAnchor(a) {
    return !!a && ['left', 'top', 'right', 'bottom'].every(k => typeof a[k] === 'number' && isFinite(a[k]));
  }

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------
  function getCsrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function httpRequest({ url, method = 'GET', body = null, headers = {} }) {
    if (!IS_OLD_REDDIT) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      return fetch(url, { method, credentials: 'include', headers, body, signal: ctrl.signal })
        .then(async r => ({ status: r.status, text: await r.text() }))
        .finally(() => clearTimeout(timer));
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        url, method, headers, data: body,
        timeout: REQUEST_TIMEOUT_MS,
        onload:    r => resolve({ status: r.status, text: r.responseText }),
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  async function graphql(operation, variables) {
    const csrf = getCsrfToken();
    if (!csrf) throw new Error('Not logged in (no CSRF cookie)');
    const res = await httpRequest({
      url: GRAPHQL_URL,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, variables, csrf_token: csrf }),
    });
    let json = null;
    try { json = JSON.parse(res.text); } catch (_) { /* fallthrough */ }
    const payload = json && json.data && Object.values(json.data)[0];
    if (res.status !== 200 || !payload || payload.ok !== true) {
      const msg = (json && json.errors && json.errors[0] && json.errors[0].message)
        || (payload && payload.errors && payload.errors[0] && payload.errors[0].message)
        || ('HTTP ' + res.status);
      throw new Error(operation + ' failed: ' + msg);
    }
    return payload;
  }

  function markNotificationRead(item) {
    return graphql('MarkNotificationRead', {
      input: { notificationId: item.id, groupType: item.groupType, groupContentId: item.groupContentId },
    });
  }

  function markAllRead() {
    return graphql('MarkInboxAsRead', { input: { types: ['NOTIFICATIONS'] } });
  }

  function withPartialMode(url) {
    try {
      const u = new URL(url, ORIGIN);
      if (!u.searchParams.has('render-mode')) u.searchParams.set('render-mode', 'partial');
      return u.href;
    } catch (_) { return url; }
  }

  // Parse the server-rendered inbox partial into plain objects.
  function parseInbox(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const items = [];
    for (const node of doc.querySelectorAll('notification-item')) {
      const row  = node.querySelector('rpl-inbox-row');
      const link = row ? row.querySelector('a[href]') : null;
      const leafSpans = link
        ? Array.from(link.querySelectorAll('span')).filter(s => s.children.length === 0 && s.textContent.trim())
        : [];
      const timeEl = row ? row.querySelector('time[datetime]') : null;
      const img    = row ? row.querySelector('img') : null;
      const hrefRaw = (link && link.getAttribute('href')) || (row && row.getAttribute('inaccessiblehref')) || '';
      let href = '';
      try { href = hrefRaw ? new URL(hrefRaw, ORIGIN).href : ''; } catch (_) { href = ''; }
      items.push({
        id:             node.getAttribute('notification-id') || '',
        type:           node.getAttribute('message-type') || '',
        groupType:      node.getAttribute('group-type') || null,
        groupContentId: node.getAttribute('group-content-id') || null,
        unread:         !!row && row.hasAttribute('selected'),
        title:          leafSpans[0] ? leafSpans[0].textContent.trim() : '',
        body:           leafSpans.slice(1).map(s => s.textContent.trim()).join(' '),
        datetime:       timeEl ? timeEl.getAttribute('datetime') || '' : '',
        timeText:       timeEl ? timeEl.textContent.trim() : '',
        avatar:         img ? (img.getAttribute('src') || '') : '',
        href,
      });
    }
    let more = null;
    for (const p of doc.querySelectorAll('faceplate-partial')) {
      const src = p.getAttribute('src') || '';
      if (/notification/i.test(src)) { more = withPartialMode(src); break; }
    }
    const loggedOut = items.length === 0 && /login|log in|sign up/i.test(doc.body ? doc.body.textContent : '') && !/notification/i.test(html);
    return { items, more, loggedOut };
  }

  async function fetchInbox(url) {
    const res = await httpRequest({ url: url || INBOX_PARTIAL });
    if (res.status === 403 || res.status === 401) throw new Error('Reddit refused the request (are you logged in?)');
    if (res.status !== 200) throw new Error('Reddit returned HTTP ' + res.status);
    return parseInbox(res.text);
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------
  function relativeTime(iso, fallback) {
    const t = Date.parse(iso);
    if (!t) return fallback || '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'now';
    const m = s / 60;   if (m < 60) return Math.floor(m) + 'm';
    const h = m / 60;   if (h < 24) return Math.floor(h) + 'h';
    const d = h / 24;   if (d < 30) return Math.floor(d) + 'd';
    const mo = d / 30;  if (mo < 12) return Math.floor(mo) + 'mo';
    return Math.floor(d / 365) + 'y';
  }

  // "now" already reads as a time; only the elapsed forms take " ago".
  function agoLabel(item) {
    const rel = relativeTime(item.datetime, item.timeText);
    if (!rel || rel === 'now') return rel;
    return item.datetime ? rel + ' ago' : rel;
  }

  function refreshLabel(ms) {
    if (!ms) return 'Off';
    const preset = REFRESH_OPTIONS.find(o => o.ms === ms);
    if (preset) return preset.label;
    const secs = Math.round(ms / 1000);
    if (secs % 60 === 0) return (secs / 60) + ' min';
    return secs + ' sec';
  }

  function localizeHref(href) {
    if (IS_OLD_REDDIT && href.startsWith(ORIGIN)) return 'https://old.reddit.com' + href.slice(ORIGIN.length);
    return href;
  }

  // ---------------------------------------------------------------------------
  // Theme: sample the page's own background so we match both Reddit designs
  // (and RES night mode on old.reddit) without depending on any CSS variable names.
  // ---------------------------------------------------------------------------
  function pageIsDark() {
    for (const node of [document.body, document.documentElement]) {
      if (!node) continue;
      const bg = getComputedStyle(node).backgroundColor || '';
      const nums = bg.match(/[\d.]+/g);
      if (!nums || nums.length < 3) continue;
      if (nums.length >= 4 && parseFloat(nums[3]) === 0) continue;
      const [r, g, b] = nums.map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
    }
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const STYLE = `
    #${PANEL_ID}, #${CTX_ID} {
      --bg:        #1a1a1b;
      --bg2:       #232325;
      --bg3:       #2d2d30;
      --border:    #343536;
      --text:      #d7dadc;
      --muted:     #8a8d91;
      --check:     #89b4fa;   /* every accent in the panel: checks, radios, selected rows, spinner */
      --badge:     #d93900;   /* Reddit's --color-brand-background. THE ONLY ORANGE — unread count only */
      --danger:    #c0392b;
      --shadow:    0 8px 24px rgba(0,0,0,.6);
      /* Native checkboxes and radios take their unchecked look from the color-scheme in
         force, which is the HOST page's unless we say otherwise — on a page that does not
         declare one they render as bright white discs against this dark menu, louder than
         the checked ones. Pin it to whichever theme the panel itself is wearing. */
      color-scheme: dark;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.35;
      color: var(--text);
      box-sizing: border-box;
    }
    #${PANEL_ID}.rnfp-light, #${CTX_ID}.rnfp-light {
      color-scheme: light;
      --bg:      #ffffff;
      --bg2:     #f3f5f7;
      --bg3:     #e6e9ec;
      --border:  #d5d9dd;
      --text:    #1c1c1c;
      --muted:   #5c6c74;
      --shadow:  0 8px 24px rgba(0,0,0,.25);
    }
    #${PANEL_ID} *, #${CTX_ID} * { box-sizing: border-box; text-transform: none; letter-spacing: normal; }
    #${PANEL_ID} button { font: inherit; color: inherit; }

    #${PANEL_ID} {
      position: fixed;
      z-index: ${Z_INDEX};
      display: flex;
      flex-direction: column;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
      min-width: ${MIN_W}px;
    }
    #${PANEL_ID}.rnfp-minimized { height: ${HEADER_H}px !important; min-height: 0; }
    #${PANEL_ID}.rnfp-minimized .rnfp-body,
    #${PANEL_ID}.rnfp-minimized .rnfp-foot,
    #${PANEL_ID}.rnfp-minimized .rnfp-edge.s,
    #${PANEL_ID}.rnfp-minimized .rnfp-edge.n,
    #${PANEL_ID}.rnfp-minimized .rnfp-edge.ne,
    #${PANEL_ID}.rnfp-minimized .rnfp-edge.nw,
    #${PANEL_ID}.rnfp-minimized .rnfp-edge.se,
    #${PANEL_ID}.rnfp-minimized .rnfp-edge.sw { display: none; }
    #${PANEL_ID}.rnfp-dragging, #${PANEL_ID}.rnfp-dragging * { user-select: none; cursor: grabbing !important; }

    /* Header */
    #${PANEL_ID} .rnfp-header {
      flex: 0 0 ${HEADER_H}px;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 4px 0 8px;
      background: var(--bg2);
      border-bottom: 1px solid var(--border);
      cursor: grab;
      user-select: none;
    }
    #${PANEL_ID} .rnfp-title {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
      transition: color .15s, font-size .15s;
    }
    #${PANEL_ID} .rnfp-title .rnfp-title-text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    /* Bell + badge: a copy of Reddit's top-bar inbox button. The 20px icon sits in a 28px slot
       so the badge, which hangs off its top-right corner, has room to grow to the right. */
    #${PANEL_ID} .rnfp-bell {
      position: relative;
      flex: 0 0 28px;
      width: 28px;
      height: 20px;
      color: var(--muted);
      transition: color .15s;
    }
    #${PANEL_ID} .rnfp-bell svg { display: block; width: 20px; height: 20px; transform-origin: 50% 15%; }
    /* Unread header: brighter, larger text and a full-strength bell; the badge alone carries
       colour, exactly like Reddit's own header. */
    #${PANEL_ID} .rnfp-title.has-unread { color: var(--text); font-size: 14px; }
    #${PANEL_ID} .rnfp-title.has-unread .rnfp-bell { color: var(--text); }
    #${PANEL_ID} .rnfp-title.has-unread .rnfp-bell svg { animation: rnfp-ring .9s ease .1s; }
    @keyframes rnfp-ring {
      0%,100% { transform: rotate(0); } 15% { transform: rotate(15deg); } 30% { transform: rotate(-12deg); }
      45% { transform: rotate(10deg); } 60% { transform: rotate(-8deg); } 75% { transform: rotate(5deg); }
    }
    /* Reddit's <dynamic-badge appearance="ALERT"> as measured live (2026-09-02): 16px pill,
       10px/16px semibold, 0 4px padding, min-width 8px, anchored 14px in and 6px up from the
       20px icon's top-left. */
    #${PANEL_ID} .rnfp-count {
      position: absolute;
      top: -6px;
      left: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 16px;
      min-width: 16px;   /* Reddit's 8px min-width + 4px padding each side; we are border-box */
      padding: 0 4px;
      border-radius: 9999px;
      background: var(--badge);
      color: #fff;
      font-size: 10px;
      font-weight: 600;
      line-height: 16px;
      letter-spacing: -.01px;
      text-align: center;
      white-space: nowrap;
      pointer-events: none;
    }
    #${PANEL_ID} .rnfp-count:empty { display: none; }

    /* Kept tight so "Notifications" still fits when the panel follows the 306px sidebar. */
    #${PANEL_ID} .rnfp-controls { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; }
    #${PANEL_ID} .rnfp-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      min-width: 22px;
      padding: 0 4px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--muted);
      cursor: pointer;
      transition: background .12s, color .12s;
    }
    #${PANEL_ID} .rnfp-btn:hover { background: var(--bg3); color: var(--text); }
    #${PANEL_ID} .rnfp-btn:disabled { opacity: .4; cursor: default; background: transparent; }
    #${PANEL_ID} .rnfp-btn.rnfp-close:hover { background: var(--danger); color: #fff; }
    #${PANEL_ID} .rnfp-btn.rnfp-busy svg { animation: rnfp-spin .8s linear infinite; }
    @keyframes rnfp-spin { to { transform: rotate(360deg); } }
    #${PANEL_ID} .rnfp-split { display: inline-flex; align-items: center; }
    #${PANEL_ID} .rnfp-split .rnfp-btn:first-child { border-radius: 5px 0 0 5px; }
    #${PANEL_ID} .rnfp-split .rnfp-btn:last-child  { border-radius: 0 5px 5px 0; min-width: 14px; padding: 0 1px; }

    /* Body */
    #${PANEL_ID} .rnfp-body {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      scrollbar-width: thin;
      scrollbar-color: var(--bg3) transparent;
    }
    #${PANEL_ID} .rnfp-list { list-style: none; margin: 0; padding: 0; }
    #${PANEL_ID} .rnfp-item {
      position: relative;
      display: flex;
      gap: 10px;
      padding: 9px 10px 9px 12px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background .12s;
    }
    #${PANEL_ID} .rnfp-item:hover { background: var(--bg2); }
    #${PANEL_ID} .rnfp-avatar {
      flex: 0 0 32px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--bg3);
      object-fit: cover;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      overflow: hidden;
    }
    #${PANEL_ID} .rnfp-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    /* Unread is marked by contrast, not hue: an unread row sits at full strength and a
       read one recedes. Nothing here depends on a color, so it works in both themes. */
    #${PANEL_ID} .rnfp-item-title { font-weight: 600; color: var(--muted); overflow-wrap: anywhere; }
    #${PANEL_ID} .rnfp-item.unread .rnfp-item-title { font-weight: 700; color: var(--text); }
    #${PANEL_ID} .rnfp-item:not(.unread) .rnfp-avatar { opacity: .5; }
    #${PANEL_ID} .rnfp-item:not(.unread) .rnfp-item-body,
    #${PANEL_ID} .rnfp-item:not(.unread) .rnfp-item-meta { opacity: .65; }
    #${PANEL_ID} .rnfp-item:hover .rnfp-avatar,
    #${PANEL_ID} .rnfp-item:hover .rnfp-item-body,
    #${PANEL_ID} .rnfp-item:hover .rnfp-item-meta { opacity: 1; }
    #${PANEL_ID} .rnfp-item-body {
      color: var(--muted);
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow-wrap: anywhere;
    }
    #${PANEL_ID} .rnfp-item-body:empty { display: none; }
    #${PANEL_ID} .rnfp-item-meta { font-size: 11px; color: var(--muted); }
    #${PANEL_ID} .rnfp-item-actions {
      position: absolute;
      right: 8px;
      top: 7px;
      display: none;
      gap: 4px;
    }
    #${PANEL_ID} .rnfp-item:hover .rnfp-item-actions { display: flex; }
    #${PANEL_ID} .rnfp-item-actions .rnfp-btn { background: var(--bg); border-color: var(--border); }
    #${PANEL_ID} .rnfp-item-actions .rnfp-btn:hover { background: var(--bg3); }

    #${PANEL_ID} .rnfp-status {
      display: none;
      padding: 28px 16px;
      text-align: center;
      color: var(--muted);
    }
    #${PANEL_ID} .rnfp-status.visible { display: block; }
    #${PANEL_ID} .rnfp-status.error { color: #ff6b6b; }
    #${PANEL_ID} .rnfp-status .rnfp-retry {
      display: inline-block;
      margin-top: 10px;
      padding: 5px 14px;
      background: var(--bg3);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 5px;
      cursor: pointer;
    }
    #${PANEL_ID} .rnfp-spinner {
      width: 26px; height: 26px;
      margin: 0 auto 10px;
      border: 3px solid var(--bg3);
      border-top-color: var(--check);
      border-radius: 50%;
      animation: rnfp-spin .7s linear infinite;
    }
    #${PANEL_ID} .rnfp-more {
      display: none;
      width: 100%;
      padding: 8px;
      background: var(--bg2);
      border: none;
      border-top: 1px solid var(--border);
      color: var(--muted);
      cursor: pointer;
    }
    #${PANEL_ID} .rnfp-more.visible { display: block; }
    #${PANEL_ID} .rnfp-more:hover { color: var(--text); background: var(--bg3); }

    /* Footer */
    #${PANEL_ID} .rnfp-foot {
      flex: 0 0 auto;
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 3px 10px;
      font-size: 11px;
      color: var(--muted);
      background: var(--bg2);
      border-top: 1px solid var(--border);
      white-space: nowrap;
      overflow: hidden;
    }
    #${PANEL_ID} .rnfp-foot a { color: var(--muted); text-decoration: none; }
    #${PANEL_ID} .rnfp-foot a:hover { color: var(--text); text-decoration: underline; }

    /* Dropdowns */
    #${PANEL_ID} .rnfp-menu {
      position: fixed;
      z-index: ${Z_INDEX};
      display: none;
      min-width: 140px;
      padding: 5px 0;
      background: var(--bg2);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: var(--shadow);
    }
    #${PANEL_ID} .rnfp-menu.open { display: block; }
    #${PANEL_ID} .rnfp-menu-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: 100%;
      padding: 6px 12px;
      background: none;
      border: none;
      text-align: left;
      cursor: pointer;
      color: var(--text);
      white-space: nowrap;
    }
    #${PANEL_ID} .rnfp-menu-item:hover { background: var(--bg3); }
    #${PANEL_ID} .rnfp-menu-item.selected { color: var(--check); font-weight: 600; }
    #${PANEL_ID} .rnfp-menu-item input[type=checkbox],
    #${PANEL_ID} .rnfp-menu-item input[type=radio] { margin: 0; accent-color: var(--check); }
    #${PANEL_ID} .rnfp-menu-item.nested { padding-left: 26px; }
    /* Heading for the startOpen radio group: a label, not a target — the rows below it are.
       Full-strength and bold, so it reads as the parent of the rows rather than a dimmer
       sibling of them. */
    #${PANEL_ID} .rnfp-menu-head {
      padding: 6px 12px 2px;
      color: var(--text);
      font-weight: 700;
      white-space: nowrap;
      cursor: default;
    }
    /* Action button inside a menu. Hover-brighten plus an :active depress, the same
       feedback Sudokupad Tools gives its panel buttons — see rnfp-pulse for why the click
       flash is an inline filter and not a keyframe animation. */
    #${PANEL_ID} .rnfp-menu-btn {
      display: block;
      width: calc(100% - 24px);
      margin: 4px 12px 2px;
      padding: 6px 10px;
      background: var(--bg3);
      border: 1px solid var(--border);
      border-radius: 5px;
      text-align: center;
      white-space: nowrap;
      cursor: pointer;
      transition: filter .18s ease, transform .07s ease;
    }
    #${PANEL_ID} .rnfp-menu-btn:hover { filter: brightness(1.35); }
    #${PANEL_ID} .rnfp-menu-btn:active { transform: translateY(1px) scale(.98); filter: brightness(.8); }

    /* Custom refresh interval, shown inline at the foot of the interval menu rather than
       behind a "Custom…" click. The box is muted while it merely mirrors the selected
       preset and goes full strength once a custom value is the live setting, so its colour
       is what tells you which of the two you are on. */
    #${PANEL_ID} .rnfp-custom {
      display: flex;
      /* BASELINE, not center - see the input rule below. Centring aligned the input's border
         box with the label's line box and left the browser to decide where the text sat
         inside each; baseline alignment hands the browser the one job it can do exactly. */
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 12px;
      white-space: nowrap;
      cursor: pointer;
    }
    /* The same hover the preset rows above it get — it is one of the choices, not a caption. */
    #${PANEL_ID} .rnfp-custom:hover { background: var(--bg3); }
    #${PANEL_ID} .rnfp-custom .rnfp-secs { display: flex; align-items: baseline; gap: 5px; color: var(--muted); }
    #${PANEL_ID} .rnfp-custom input {
      width: 62px;
      /* The font shorthand sets line-height too, so it has to come FIRST: written after, it
         silently reset the explicit line-height below. Keep the order, but note it is NOT
         what was misaligning anything - line-height: normal measures identically. */
      font: inherit;
      height: 22px;
      line-height: 20px;
      /* padding-bottom: 2px is the whole optical fix, and it is a MEASURED value, not a
         nudge. An input's text does not sit where the box's arithmetic suggests: measured
         2026-09-04, the digits' baseline sat 16.5px below the border-box top, leaving 7.5px
         of box above the digits and 5.5px below - 2px of top-heaviness, plainly visible on a
         bordered box. Chrome centres the line box in the CONTENT box, so padding-bottom
         moves the text up half its value: 2px lands the baseline at 15.5 and the gaps at
         6.5 / 6.5, dead level.
         Four earlier passes missed this because they all measured getBoundingClientRect(),
         which reported the box perfectly centred every single time - it was never the box.
         Measure an input's baseline instead by flipping its parent to display:block for one
         frame and letting the browser baseline-align it against a probe span. */
      padding: 0 5px 2px;
      text-align: center;
      background: var(--bg);
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 4px;
      transition: color .15s ease, border-color .15s ease;
    }
    /* No spinners: they cost ~15px of a narrow menu and the arrow keys still nudge. */
    #${PANEL_ID} .rnfp-custom input::-webkit-outer-spin-button,
    #${PANEL_ID} .rnfp-custom input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    #${PANEL_ID} .rnfp-custom input { -moz-appearance: textfield; }
    #${PANEL_ID} .rnfp-custom input:hover { border-color: var(--muted); }
    #${PANEL_ID} .rnfp-custom input:focus { color: var(--text); border-color: var(--check); outline: none; }
    #${PANEL_ID} .rnfp-custom.active input,
    #${PANEL_ID} .rnfp-custom.active .rnfp-secs { color: var(--text); }
    #${PANEL_ID} .rnfp-custom.invalid input { border-color: var(--danger); color: var(--text); }

    /* Long-interval crib sheet, revealed while the custom box has focus. */
    #${PANEL_ID} .rnfp-reflist { display: none; padding: 2px 0 4px; }
    #${PANEL_ID} .rnfp-reflist.open { display: block; }
    #${PANEL_ID} .rnfp-ref {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
      width: 100%;
      padding: 3px 12px 3px 26px;
      background: none;
      border: none;
      text-align: left;
      white-space: nowrap;
      cursor: pointer;
      color: var(--muted);
    }
    #${PANEL_ID} .rnfp-ref:hover { background: var(--bg3); color: var(--text); }
    #${PANEL_ID} .rnfp-ref .rnfp-ref-secs { font-variant-numeric: tabular-nums; }

    /* Title bar of a movable menu. */
    #${PANEL_ID} .rnfp-menu-bar {
      padding: 6px 12px 7px;
      margin-bottom: 3px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      /* Larger than .rnfp-menu-head, which is a section label inside this window, not its
         title. Same 14px the panel's own header uses. */
      font-size: 14px;
      font-weight: 700;
      white-space: nowrap;
      cursor: move;
      user-select: none;
      touch-action: none;
    }
    #${PANEL_ID} .rnfp-menu-item.disabled { opacity: .4; pointer-events: none; }
    #${PANEL_ID} .rnfp-menu-sep { height: 1px; margin: 4px 0; background: var(--border); }

    /* Resize edges */
    #${PANEL_ID} .rnfp-edge { position: absolute; z-index: 3; }
    #${PANEL_ID} .rnfp-edge.n  { top: -1px;    left: ${EDGE}px;  right: ${EDGE}px;  height: ${EDGE}px; cursor: n-resize; }
    #${PANEL_ID} .rnfp-edge.s  { bottom: -1px; left: ${EDGE}px;  right: ${EDGE}px;  height: ${EDGE}px; cursor: s-resize; }
    #${PANEL_ID} .rnfp-edge.w  { left: -1px;   top: ${EDGE}px;   bottom: ${EDGE}px; width: ${EDGE}px;  cursor: w-resize; }
    #${PANEL_ID} .rnfp-edge.e  { right: -1px;  top: ${EDGE}px;   bottom: ${EDGE}px; width: ${EDGE}px;  cursor: e-resize; }
    #${PANEL_ID} .rnfp-edge.nw { top: -1px;    left: -1px;  width: ${EDGE + 4}px; height: ${EDGE + 4}px; cursor: nw-resize; }
    #${PANEL_ID} .rnfp-edge.ne { top: -1px;    right: -1px; width: ${EDGE + 4}px; height: ${EDGE + 4}px; cursor: ne-resize; }
    #${PANEL_ID} .rnfp-edge.sw { bottom: -1px; left: -1px;  width: ${EDGE + 4}px; height: ${EDGE + 4}px; cursor: sw-resize; }
    #${PANEL_ID} .rnfp-edge.se { bottom: -1px; right: -1px; width: ${EDGE + 4}px; height: ${EDGE + 4}px; cursor: se-resize; }

    /* Bell context menu */
    #${CTX_ID} {
      position: fixed;
      z-index: ${Z_INDEX + 1};
      list-style: none;
      margin: 0;
      padding: 4px 0;
      min-width: 220px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: var(--shadow);
    }
    #${CTX_ID} li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    #${CTX_ID} li svg { color: var(--muted); flex: 0 0 auto; }
    #${CTX_ID} li:hover { background: var(--bg2); color: var(--check); }
    #${CTX_ID} li:hover svg { color: var(--check); }
    #${CTX_ID} li.disabled { opacity: .45; pointer-events: none; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  // ---------------------------------------------------------------------------
  // Panel state
  // ---------------------------------------------------------------------------
  let panel = null;
  const ui = {};                 // element refs
  let geometry = null;           // { x, y, w, h } of the *restored* (non-minimized) panel
  let anchor = null;             // { left, top, right, bottom } edge offsets; see "Edge anchoring"
  let anchorRetryTimers = [];    // late re-alignments for sidebars that render after the panel opens
  let minimized = false;
  let items = [];
  let moreUrl = null;
  let loading = false;
  let lastLoadedAt = 0;
  let lastUnread = 0;
  let refreshTimer = null;
  let footClockTimer = null;

  function isOpen() { return !!(panel && panel.isConnected); }

  function applyTheme(node) {
    if (!node) return;
    node.classList.toggle('rnfp-light', !pageIsDark());
  }

  function saveGeometry() {
    if (!geometry) return;
    const vp = viewport();
    saveJSON(KEY_GEOMETRY, { ...geometry, vw: vp.w, vh: vp.h, anchor });
  }

  // Re-derive the geometry from the anchor. Returns false (and changes nothing) when no
  // usable sidebar exists right now, so a sidebar that Reddit hides at a narrow width simply
  // leaves the panel where it last was.
  function applyAnchor(persist) {
    if (!isOpen()) return false;
    if (!anchor) anchor = defaultAnchor();   // only before the panel has ever seen a sidebar
    const g = anchorToGeometry(anchor);
    if (!g) return false;
    geometry = g;
    layoutPanel();
    if (persist) saveGeometry();
    return true;
  }

  // Reddit's right rail is a lazily loaded partial, so it can land after the panel is up
  // (on boot and after SPA navigations). Two delayed re-checks catch that without polling.
  function scheduleAnchorRetries() {
    for (const t of anchorRetryTimers) clearTimeout(t);
    anchorRetryTimers = [800, 2500].map(ms => setTimeout(() => applyAnchor(true), ms));
  }

  // Position the panel element from `geometry` + `minimized`.
  function layoutPanel() {
    if (!panel || !geometry) return;
    const g = geometry;
    const vp = viewport();
    let top = g.y;
    if (minimized) {
      // Keep a bottom-docked panel's bar at the bottom edge.
      if (snappedEdges(g).bottom) top = vp.h - HEADER_H;
      top = Math.max(0, Math.min(top, vp.h - HEADER_H));
    }
    panel.style.left   = g.x + 'px';
    panel.style.top    = top + 'px';
    panel.style.width  = g.w + 'px';
    panel.style.height = (minimized ? HEADER_H : g.h) + 'px';
  }

  function setGeometry(g, persist) {
    geometry = clampGeometry(g);
    layoutPanel();
    if (persist) saveGeometry();
  }

  function onViewportResize() {
    if (!isOpen() || !geometry) return;
    if (applyAnchor(true)) return;
    const saved = loadJSON(KEY_GEOMETRY, null);
    const base = { ...geometry, vw: saved && saved.vw, vh: saved && saved.vh };
    setGeometry(adaptGeometry(base), true);
  }
  window.addEventListener('resize', onViewportResize);

  // ---------------------------------------------------------------------------
  // Panel construction
  // ---------------------------------------------------------------------------
  function buildPanel() {
    ui.titleText = el('span', { class: 'rnfp-title-text', text: 'Notifications' });
    ui.count     = el('span', { class: 'rnfp-count' });
    ui.bell      = el('span', { class: 'rnfp-bell' }, ICON.bell(), ui.count);
    ui.title     = el('div', { class: 'rnfp-title' }, ui.bell, ui.titleText);

    ui.markAllBtn  = el('button', { class: 'rnfp-btn', type: 'button', 'aria-label': 'Mark all as read',
      title: 'Mark every notification in your Reddit inbox as read — not only the ones listed here.',
      onclick: onMarkAllClick }, ICON.checkAll());
    ui.reloadBtn   = el('button', { class: 'rnfp-btn', type: 'button', 'aria-label': 'Reload',
      title: 'Fetch the list from Reddit again right now.',
      onclick: () => refresh(true) }, ICON.reload());
    ui.intervalBtn = el('button', { class: 'rnfp-btn', type: 'button', 'aria-label': 'Auto-refresh interval',
      title: 'How often the panel checks Reddit for new notifications while it is open.',
      onclick: toggleIntervalMenu }, ICON.chevron());
    ui.settingsBtn = el('button', { class: 'rnfp-btn', type: 'button', 'aria-label': 'Settings',
      title: 'Settings for this panel.',
      onclick: toggleSettingsMenu }, ICON.gear());
    ui.minBtn      = el('button', { class: 'rnfp-btn', type: 'button', title: 'Minimize', 'aria-label': 'Minimize', onclick: toggleMinimized }, ICON.minimize());
    ui.closeBtn    = el('button', { class: 'rnfp-btn rnfp-close', type: 'button', 'aria-label': 'Close',
      onclick: closePanelByUser }, ICON.close());
    updateCloseTip();

    ui.header = el('div', { class: 'rnfp-header' },
      ui.title,
      el('div', { class: 'rnfp-controls' },
        ui.markAllBtn,
        el('div', { class: 'rnfp-split' }, ui.reloadBtn, ui.intervalBtn),
        ui.settingsBtn,
        ui.minBtn,
        ui.closeBtn,
      ),
    );

    ui.list   = el('ul', { class: 'rnfp-list' });
    ui.status = el('div', { class: 'rnfp-status' });
    ui.more   = el('button', { class: 'rnfp-more', type: 'button', text: 'Load more',
      title: 'Fetch the next batch of older notifications and add them to the bottom of the list.',
      onclick: loadMore });
    ui.body   = el('div', { class: 'rnfp-body' }, ui.list, ui.status, ui.more);

    ui.footLeft  = el('span', { text: '' });
    ui.footRight = el('a', { href: NOTIF_PAGE, text: 'Open notifications page',
      title: "Open Reddit's own notifications page in a new tab.",
      onclick: e => { e.preventDefault(); openUrl(NOTIF_PAGE, true); } });
    ui.foot = el('div', { class: 'rnfp-foot' }, ui.footLeft, ui.footRight);

    ui.intervalMenu = el('div', { class: 'rnfp-menu', role: 'menu' });
    ui.settingsMenu = el('div', { class: 'rnfp-menu', role: 'menu' });

    const edges = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].map(d => el('div', { class: 'rnfp-edge ' + d, 'data-dir': d }));

    panel = el('div', { id: PANEL_ID }, ...edges, ui.header, ui.body, ui.foot, ui.intervalMenu, ui.settingsMenu);

    makeDraggable();
    makeResizable();

    // Anything clicked inside a menu must not bubble to the document-level "close menus" handler.
    for (const m of [ui.intervalMenu, ui.settingsMenu]) m.addEventListener('click', e => e.stopPropagation());
    return panel;
  }

  function openPanel() {
    if (isOpen()) return;
    if (panel) { panel.remove(); panel = null; }
    buildPanel();

    const saved = loadJSON(KEY_GEOMETRY, null);
    const hasSaved = saved && ['x', 'y', 'w', 'h'].every(k => typeof saved[k] === 'number' && !isNaN(saved[k]));
    anchor = hasSaved && validAnchor(saved.anchor) ? saved.anchor : null;
    // Migrate a pre-6.4 save: `follow: false` meant a manual placement, so turn that rect
    // into the equivalent offsets; anything else was tracking the sidebar and resets.
    if (!anchor && hasSaved && saved.follow === false && saved.vw && saved.vh) {
      const sx = sidebarLeft();
      anchor = {
        left:   sx === null ? FOLLOW_INSET : Math.round(saved.x - sx),
        top:    Math.round(saved.y),
        right:  Math.round(saved.vw - (saved.x + saved.w)),
        bottom: Math.round(saved.vh - (saved.y + saved.h)),
      };
    }
    if (!anchor) anchor = defaultAnchor();
    geometry = anchorToGeometry(anchor);
    if (!geometry) geometry = hasSaved ? adaptGeometry(saved) : clampGeometry(defaultGeometry());
    saveGeometry();

    minimized = sessionStorage.getItem(SS_MINIMIZED) === '1';
    panel.classList.toggle('rnfp-minimized', minimized);
    updateMinButton();

    document.body.appendChild(panel);
    applyTheme(panel);
    layoutPanel();
    scheduleAnchorRetries();

    renderList();
    refresh(true);
    startAutoRefresh();
    footClockTimer = setInterval(updateFoot, 30000);
  }

  function closePanel() {
    stopAutoRefresh();
    clearInterval(footClockTimer);
    footClockTimer = null;
    for (const t of anchorRetryTimers) clearTimeout(t);
    anchorRetryTimers = [];
    clearTitle();
    closeMenus();
    if (panel) panel.remove();
    panel = null;
  }

  // Opening and closing by hand are the only things that write per-page memory. Every
  // other caller (the boot/navigation rule below) goes to openPanel/closePanel directly,
  // so applying the rule never rewrites what the user decided.
  function openPanelByUser()  { openPanel();  if (settings.rememberPages) setPageState(true); }
  function closePanelByUser() { closePanel(); if (settings.rememberPages) setPageState(false); }
  function togglePanel() { if (isOpen()) closePanelByUser(); else openPanelByUser(); }

  // A subreddit's post list: /r/<sub> and its sort tabs, and nothing deeper. Spelling the
  // sorts out rather than excluding /comments/ keeps /wiki/, /about/, /submit and whatever
  // Reddit adds next on the closed side by default.
  const LISTING_PATH = /^\/r\/[^/]+(\/(hot|new|top|rising|controversial|best|gilded))?$/;

  // What this page should do on arrival: true = open, false = close, null = leave alone.
  //
  // A remembered page answers both ways, because closing it somewhere is as explicit an
  // instruction as opening it. The startOpen rule only ever answers `true`: it decides
  // where the panel appears by itself, and pulling an open panel out from under someone
  // mid-read is not something any of its wordings promise.
  function arrivalState() {
    if (settings.rememberPages) {
      const remembered = pageState();
      if (remembered !== null) return remembered;
    }
    if (settings.startOpen === 'all') return true;
    if (settings.startOpen === 'listings' && LISTING_PATH.test(pageKey())) return true;
    return null;
  }

  function applyArrivalState() {
    touchPage();
    const want = arrivalState();
    if (want === true && !isOpen()) openPanel();
    else if (want === false && isOpen()) closePanel();
  }

  // Reset restores the standard offsets: FOLLOW_INSET inside the sidebar's top-left corner,
  // right and bottom flush with the window. Without a sidebar it falls back to the
  // bottom-right default (and takes up the standard offsets once one appears).
  function resetPanel() {
    minimized = false;
    sessionStorage.removeItem(SS_MINIMIZED);
    if (panel) { panel.classList.remove('rnfp-minimized'); updateMinButton(); }
    anchor = defaultAnchor();
    geometry = anchorToGeometry(anchor) || clampGeometry(defaultGeometry());
    saveGeometry();
    if (!isOpen()) openPanel(); else { layoutPanel(); scheduleAnchorRetries(); }
  }

  // Closing means two different things depending on the remember setting, and which one is
  // in force is exactly what a user cannot see. Refreshed whenever that setting changes.
  function updateCloseTip() {
    if (!ui.closeBtn) return;
    ui.closeBtn.title = settings.rememberPages
      ? 'Close the panel. This page is remembered as closed, so it stays shut here until you open it again.'
      : 'Close the panel. Nothing is remembered — the next page decides for itself.';
  }

  function updateMinButton() {
    if (!ui.minBtn) return;
    ui.minBtn.textContent = '';
    ui.minBtn.appendChild(minimized ? ICON.restore() : ICON.minimize());
    ui.minBtn.title = minimized ? 'Restore' : 'Minimize';
    ui.minBtn.setAttribute('aria-label', ui.minBtn.title);
  }

  function toggleMinimized() {
    minimized = !minimized;
    if (minimized) sessionStorage.setItem(SS_MINIMIZED, '1'); else sessionStorage.removeItem(SS_MINIMIZED);
    panel.classList.toggle('rnfp-minimized', minimized);
    updateMinButton();
    closeMenus();
    layoutPanel();
  }

  // Keep the panel attached across Reddit's SPA navigations (the document survives,
  // but be defensive in case body children get replaced).
  function ensureAttached() {
    if (panel && !panel.isConnected) {
      document.body.appendChild(panel);
      layoutPanel();
    }
  }
  // After an SPA navigation the sidebar may be about to render, so re-apply the anchor now
  // and again shortly. Only the left edge can move as a result: the panel's vertical position
  // is measured from the window, so navigating between pages whose sidebars start at
  // different heights (home under the header, a subreddit under its banner) does not shift it.
  //
  // Reddit's SPA navigations do not re-run the script, so this is the only place the
  // arrival rule gets applied after the first load. Without it every wording in the
  // settings would be a lie the moment you clicked a link instead of typing a URL.
  let lastPath = pageKey();
  function onNavigated() {
    ensureAttached();
    const now = pageKey();
    if (now !== lastPath) { lastPath = now; applyArrivalState(); }
    if (!isOpen()) return;
    applyAnchor(true);
    scheduleAnchorRetries();
  }
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigatesuccess', () => setTimeout(onNavigated, 0));
  }
  window.addEventListener('popstate', () => setTimeout(onNavigated, 0));

  // ---------------------------------------------------------------------------
  // Drag & resize (pointer events; the header is the drag handle)
  // ---------------------------------------------------------------------------
  function makeDraggable() {
    ui.header.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, a, .rnfp-menu')) return;
      e.preventDefault();
      closeMenus();
      const rect = panel.getBoundingClientRect();
      const offX = e.clientX - rect.left;
      const offY = e.clientY - rect.top;
      const startMinimized = minimized;
      let moved = false;
      panel.classList.add('rnfp-dragging');
      const move = ev => {
        moved = true;
        const vp = viewport();
        const h = startMinimized ? HEADER_H : geometry.h;
        let x = ev.clientX - offX;
        let y = ev.clientY - offY;
        x = Math.max(0, Math.min(x, vp.w - geometry.w));
        y = Math.max(0, Math.min(y, vp.h - h));
        const snapped = snapGeometry({ x, y, w: geometry.w, h });
        if (startMinimized) {
          // Dragging the minimized bar: store the restored panel's y so that a bar
          // dropped at the bottom edge restores to a bottom-docked panel.
          const atBottom = Math.abs(snapped.y + HEADER_H - vp.h) <= SNAP;
          geometry.x = snapped.x;
          geometry.y = atBottom ? vp.h - geometry.h : Math.min(snapped.y, vp.h - geometry.h);
          panel.style.left = snapped.x + 'px';
          panel.style.top  = snapped.y + 'px';
        } else {
          geometry.x = snapped.x;
          geometry.y = snapped.y;
          panel.style.left = snapped.x + 'px';
          panel.style.top  = snapped.y + 'px';
        }
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        panel.classList.remove('rnfp-dragging');
        // Rewrite the offsets rather than stop tracking: the panel keeps following the
        // sidebar and the window edges, just from wherever the user put it.
        setGeometry(geometry, false);
        if (moved) anchor = geometryToAnchor(geometry);
        saveGeometry();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  function makeResizable() {
    for (const handle of panel.querySelectorAll('.rnfp-edge')) {
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        closeMenus();
        const dir = handle.dataset.dir;
        const start = { x: e.clientX, y: e.clientY, g: { ...geometry } };
        let moved = false;
        panel.classList.add('rnfp-dragging');
        const move = ev => {
          moved = true;
          const vp = viewport();
          const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
          let { x, y, w, h } = start.g;
          if (dir.includes('e')) w = start.g.w + dx;
          if (dir.includes('s')) h = start.g.h + dy;
          if (dir.includes('w')) { w = start.g.w - dx; x = start.g.x + dx; }
          if (dir.includes('n')) { h = start.g.h - dy; y = start.g.y + dy; }
          // Enforce minimums without letting the opposite edge drift.
          if (w < MIN_W) { if (dir.includes('w')) x -= (MIN_W - w); w = MIN_W; }
          if (h < MIN_H) { if (dir.includes('n')) y -= (MIN_H - h); h = MIN_H; }
          // Keep inside the viewport.
          if (x < 0) { w += x; x = 0; }
          if (y < 0) { h += y; y = 0; }
          if (x + w > vp.w) w = vp.w - x;
          if (y + h > vp.h) h = vp.h - y;
          const snapped = snapGeometry({ x, y, w, h });
          // Snapping a moving edge: adjust size, not position, for e/s edges.
          if (dir.includes('e') && snapped.x + w !== vp.w && Math.abs(x + w - vp.w) <= SNAP) w = vp.w - x;
          if (dir.includes('s') && Math.abs(y + h - vp.h) <= SNAP) h = vp.h - y;
          if (dir.includes('w') && Math.abs(x) <= SNAP) { w += x; x = 0; }
          if (dir.includes('n') && Math.abs(y) <= SNAP) { h += y; y = 0; }
          geometry = { x, y, w: Math.max(MIN_W, w), h: Math.max(MIN_H, h) };
          layoutPanel();
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          panel.classList.remove('rnfp-dragging');
          setGeometry(geometry, false);
          if (moved) anchor = geometryToAnchor(geometry);
          saveGeometry();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Menus (auto-refresh interval, settings)
  // ---------------------------------------------------------------------------
  // A brief dim that eases back out, so an instant action still reads as "did something".
  // An inline filter rather than a keyframe animation, for the reason Sudokupad Tools
  // documents: a CSS animation restarts every time the menu goes display:none -> block, so
  // the button would re-flash on each reopen. Clearing the inline value leaves nothing to
  // replay, and it eases back to whatever brightness hover has it at.
  function pulse(btn) {
    btn.style.filter = 'brightness(.5)';
    clearTimeout(btn._pulseTimer);
    btn._pulseTimer = setTimeout(() => { btn.style.filter = ''; }, 200);
  }

  // `centerOn`, when given, centres the menu horizontally on that element instead of
  // right-aligning it to the anchor.
  //
  // When the target is at least as wide as the menu's natural width the menu is given that
  // exact width and simply placed at its left edge. Centring by arithmetic instead used to
  // leave the menu a few pixels off: a `min-width` floor and a `getBoundingClientRect()`
  // measurement disagree about sub-pixel widths and about the border, and half of that
  // difference is a visible offset. Setting the width outright removes the arithmetic.
  // `stretch` additionally gives the menu the target's exact width when the target is the
  // wider of the two, which only the settings menu wants.
  //
  // THE CLAMPS HAVE NO INSET, and that is load-bearing. They used to keep the menu 4px
  // inside the viewport, but the panel docks FLUSH with the window's right and bottom
  // edges, so a panel-width menu placed at the panel's left edge tripped the right-hand
  // clamp every single time and was shoved 4px left of the panel it was supposed to line
  // up with. Any inset here is a permanent misalignment, not a safety margin.
  function positionMenu(menu, anchor, centerOn, stretch) {
    const r = anchor.getBoundingClientRect();
    const vp = viewport();
    menu.style.left = '0px';
    menu.style.top  = '0px';
    menu.style.width = '';
    const natural = menu.offsetWidth;
    let left, mw = natural;
    if (centerOn) {
      const c = centerOn.getBoundingClientRect();
      const target = Math.round(c.width);
      if (stretch && target >= natural) { menu.style.width = target + 'px'; mw = target; left = c.left; }
      else { left = c.left + (c.width - natural) / 2; }
    } else {
      left = r.right - natural;
    }
    const mh = menu.offsetHeight;
    let top = r.bottom + 4;
    if (left + mw > vp.w) left = vp.w - mw;
    if (left < 0) left = 0;
    if (top + mh > vp.h) top = r.top - mh - 4;
    if (top < 0) top = 0;
    menu.style.left = Math.round(left) + 'px';
    menu.style.top  = Math.round(top) + 'px';
  }

  // Keep a menu on screen after its own content has grown (the interval reference list
  // expanding). Only the vertical edge is touched, so a menu the user has dragged keeps the
  // horizontal position they put it at.
  function clampMenuIntoView(menu) {
    const vp = viewport();
    const r = menu.getBoundingClientRect();
    if (r.bottom <= vp.h) return;
    menu.style.top = Math.round(Math.max(0, vp.h - r.height)) + 'px';
  }

  // Drag a menu by its title bar. Deliberately not persisted: the position resets to the
  // anchor every time the menu is reopened, so a menu dragged somewhere odd is never a
  // state the user has to undo.
  function makeMenuDraggable(menu, handle) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const r = menu.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const vp = viewport();
      // Same reasoning as positionMenu: no inset, or the menu cannot be dragged to the
      // window edge the panel itself is docked against.
      const onMove = ev => {
        menu.style.left = Math.round(Math.max(0, Math.min(ev.clientX - dx, vp.w - r.width))) + 'px';
        menu.style.top  = Math.round(Math.max(0, Math.min(ev.clientY - dy, vp.h - r.height))) + 'px';
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  }

  function closeMenus() {
    if (ui.intervalMenu) ui.intervalMenu.classList.remove('open');
    if (ui.settingsMenu) ui.settingsMenu.classList.remove('open');
  }

  document.addEventListener('click', e => {
    if (!panel) return;
    if (ui.intervalMenu.classList.contains('open') && !ui.intervalMenu.contains(e.target) && !ui.intervalBtn.contains(e.target)) ui.intervalMenu.classList.remove('open');
    if (ui.settingsMenu.classList.contains('open') && !ui.settingsMenu.contains(e.target) && !ui.settingsBtn.contains(e.target)) ui.settingsMenu.classList.remove('open');
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMenus(); removeCtxMenu(); } }, true);

  function toggleIntervalMenu(e) {
    e.stopPropagation();
    const opening = !ui.intervalMenu.classList.contains('open');
    closeMenus();
    if (!opening) return;
    buildIntervalMenu();
    ui.intervalMenu.classList.add('open');
    positionMenu(ui.intervalMenu, ui.intervalBtn, panel);
  }

  function setRefresh(ms) {
    settings.refreshMs = ms;
    saveSettings();
    startAutoRefresh();
    updateFoot();
  }

  function buildIntervalMenu() {
    const menu = ui.intervalMenu;
    menu.textContent = '';

    // The live interval, always visible and always editable — no second popup. Muted while
    // it only mirrors the selected preset; `active` (full strength, no preset highlighted)
    // once a custom value is the setting. A <label for> so that clicking anywhere on the
    // row — the word "Custom" included — puts the caret in the box.
    const INPUT_ID = 'rnfp-custom-secs';
    const input = el('input', {
      type: 'number', id: INPUT_ID, min: String(MIN_REFRESH_MS / 1000), step: '5',
      'aria-label': 'Custom refresh interval in seconds',
    });
    const row = el('label', {
      class: 'rnfp-custom', for: INPUT_ID,
      title: 'Any interval you like, in seconds — at least ' + (MIN_REFRESH_MS / 1000) +
             '. Press Enter to apply. Reddit is being asked for your inbox each time, so ' +
             'very short intervals are a lot of requests.',
    }, el('span', { text: 'Custom' }), el('span', { class: 'rnfp-secs' }, input, el('span', { text: 'sec' })));

    const presetBtns = REFRESH_OPTIONS.map(opt => {
      const b = el('button', {
        class: 'rnfp-menu-item', type: 'button', role: 'menuitem', text: opt.label,
        title: opt.ms
          ? 'Check for new notifications every ' + opt.label.replace('sec', 'seconds').replace('min', 'minutes') + '.'
          : 'Never check on its own. The list only updates when you press Reload or reopen the panel.',
        // Stays open and writes its seconds into the box, the same as a crib-sheet row.
        // Picking an interval is a thing you may want to do twice before settling.
        onclick: () => { setRefresh(opt.ms); sync(); },
      });
      b._ms = opt.ms;
      return b;
    });

    // The single place the menu's appearance is derived from settings, so a preset click, a
    // crib-sheet click and a typed value all leave it in the same consistent state without
    // a rebuild (a rebuild drops focus and collapses the crib sheet).
    function sync() {
      const isPreset = REFRESH_OPTIONS.some(o => o.ms === settings.refreshMs);
      input.value = settings.refreshMs ? String(settings.refreshMs / 1000) : '';
      input.placeholder = settings.refreshMs ? '' : 'off';
      row.classList.toggle('active', !isPreset);
      row.classList.remove('invalid');
      for (const b of presetBtns) b.classList.toggle('selected', b._ms === settings.refreshMs);
    }

    const apply = () => {
      const secs = parseInt(input.value, 10);
      if (isNaN(secs) || secs * 1000 < MIN_REFRESH_MS) { row.classList.add('invalid'); return false; }
      setRefresh(secs * 1000);
      sync();
      return true;
    };
    input.addEventListener('input', () => row.classList.remove('invalid'));
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();               // Escape belongs to the input first, not the panel
      if (ev.key === 'Enter') { if (apply()) closeMenus(); }
      else if (ev.key === 'Escape') { sync(); input.blur(); }
    });

    // Seconds get unreadable past a few minutes, so focusing the box drops down a crib
    // sheet of the long intervals. The rows are clickable as well as readable — mousedown
    // is prevented so the input never loses focus and the list never closes underneath the
    // click that is trying to use it.
    const refs = el('div', { class: 'rnfp-reflist' });
    for (const [label, secs] of LONG_INTERVALS) {
      refs.appendChild(el('button', {
        class: 'rnfp-ref', type: 'button', title: 'Set the interval to ' + label + '.',
        onclick: () => { input.value = String(secs); apply(); input.focus(); },
      }, el('span', { text: label }), el('span', { class: 'rnfp-ref-secs', text: String(secs) })));
    }
    refs.addEventListener('mousedown', ev => ev.preventDefault());

    input.addEventListener('focus', () => {
      input.select();
      refs.classList.add('open');
      clampMenuIntoView(menu);
    });
    // Committing on blur as well as Enter, so clicking away from a typed number keeps it
    // rather than silently discarding it.
    input.addEventListener('blur', () => {
      refs.classList.remove('open');
      if (input.value !== '') apply(); else sync();
    });

    for (const b of presetBtns) menu.appendChild(b);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(row);
    menu.appendChild(refs);
    sync();
  }

  function toggleSettingsMenu(e) {
    e.stopPropagation();
    const opening = !ui.settingsMenu.classList.contains('open');
    closeMenus();
    if (!opening) return;
    buildSettingsMenu();
    ui.settingsMenu.classList.add('open');
    // Width and placement both come from positionMenu now: it stretches the menu to the
    // panel's exact width whenever the panel is the wider of the two.
    positionMenu(ui.settingsMenu, ui.settingsBtn, panel, true);
  }

  function buildSettingsMenu() {
    const menu = ui.settingsMenu;
    menu.textContent = '';
    const bar = el('div', { class: 'rnfp-menu-bar', text: 'Settings',
      title: 'Drag to move this window. It goes back under the gear next time you open it.' });
    makeMenuDraggable(menu, bar);
    menu.appendChild(bar);
    function checkRow(label, key, nested, tip, onChange) {
      const cb = el('input', { type: 'checkbox', id: 'rnfp-set-' + key });
      cb.checked = !!settings[key];
      cb.addEventListener('change', () => { settings[key] = cb.checked; saveSettings(); if (onChange) onChange(); });
      const row = el('label', { class: 'rnfp-menu-item' + (nested ? ' nested' : ''), for: cb.id, title: tip },
        el('span', { text: label }), cb);
      return { row, cb };
    }
    // One radio of the startOpen group. Same shape as checkRow so the rows line up.
    function radioRow(label, value, tip, onChange) {
      const rb = el('input', { type: 'radio', name: 'rnfp-startopen', id: 'rnfp-set-startOpen-' + value });
      rb.checked = settings.startOpen === value;
      rb.addEventListener('change', () => {
        if (!rb.checked) return;
        settings.startOpen = value; saveSettings(); if (onChange) onChange();
      });
      const row = el('label', { class: 'rnfp-menu-item nested', for: rb.id, title: tip },
        el('span', { text: label }), rb);
      return { row, rb };
    }
    const switchRow = checkRow('…and switch to the new tab immediately', 'switchTab', true,
      'Bring the new tab to the front as it opens. Off, it opens in the background and you ' +
      'stay on the page you are reading.');
    const newTabRow = checkRow('Open links in a new tab', 'newTab', false,
      'Clicking a notification opens it in a new tab, leaving the page you are on alone. ' +
      'Off, it navigates the current tab.',
      () => switchRow.row.classList.toggle('disabled', !settings.newTab));
    switchRow.row.classList.toggle('disabled', !settings.newTab);
    const markRow = checkRow('Mark comments as read when opened', 'markReadOnOpen', false,
      'Opening a notification marks it read on Reddit, the same as clicking it on the inbox page.');
    const flashRow = checkRow('Flash the tab when they arrive', 'titleFlash', true,
      'When the count goes up, blink the tab twice — the title reads "New Notification!" and the ' +
      'favicon swaps to a red count badge, then both settle back. The count alone is easy to miss. ' +
      'Toggling this runs one now so you can see it.',
      previewFlash);
    const countRow = checkRow('Show the unread count in the tab title', 'titleCount', false,
      'Put the unread count at the front of the tab title, like (3) reddit. ' +
      'Only while the panel is open — that is when the script is polling.',
      () => {
        flashRow.row.classList.toggle('disabled', !settings.titleCount);
        refreshTitle();
      });
    flashRow.row.classList.toggle('disabled', !settings.titleCount);

    const startHead = el('div', { class: 'rnfp-menu-head', text: 'Start with the panel open…',
      title: 'What the panel does when you arrive on a Reddit page — a page load, or clicking ' +
             'through to another page. It only ever opens the panel; it will not close one you ' +
             'are reading.' });
    const neverRow = radioRow('Never', 'never',
      'The panel only ever opens when you open it yourself, from the bell menu.');
    const listRow = radioRow('Only on subreddit pages', 'listings',
      'A subreddit\'s list of posts — /r/pics and its hot/new/top/rising tabs. ' +
      'Not individual comment pages, and not your home feed.');
    const allPagesRow = radioRow('On every Reddit page', 'all',
      'Every page this script runs on, including your home feed, profiles, search and ' +
      'individual posts.');
    const rememberRow = checkRow('Remember open / closed state for any page', 'rememberPages', true,
      'Opening or closing the panel on a page is remembered for that page and overrides the ' +
      'choice above, in both directions. Kept for a year after your last visit, up to ' +
      PAGE_MAX.toLocaleString() + ' pages. Off, nothing is recorded and every page follows the ' +
      'choice above.',
      updateCloseTip);
    menu.appendChild(newTabRow.row);
    menu.appendChild(switchRow.row);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(markRow.row);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(startHead);
    menu.appendChild(neverRow.row);
    menu.appendChild(listRow.row);
    menu.appendChild(allPagesRow.row);
    menu.appendChild(rememberRow.row);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(countRow.row);
    menu.appendChild(flashRow.row);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    const resetBtn = el('button', { class: 'rnfp-menu-btn', type: 'button', role: 'menuitem',
      title: 'Put the panel back in its default place: tucked inside the right sidebar, flush ' +
             'with the bottom-right of the window.',
      text: 'Reset panel position & size',
      onclick: () => { pulse(resetBtn); closeMenus(); resetPanel(); } });
    menu.appendChild(resetBtn);
  }

  // ---------------------------------------------------------------------------
  // Data loading & rendering
  // ---------------------------------------------------------------------------
  function setLoading(on) {
    loading = on;
    if (!panel) return;
    ui.reloadBtn.disabled = on;
    ui.reloadBtn.classList.toggle('rnfp-busy', on);
    ui.more.disabled = on;
  }

  function showStatus(kind, message, retry) {
    ui.status.textContent = '';
    ui.status.className = 'rnfp-status visible' + (kind === 'error' ? ' error' : '');
    if (kind === 'loading') ui.status.appendChild(el('div', { class: 'rnfp-spinner' }));
    ui.status.appendChild(el('div', { text: message }));
    if (retry) ui.status.appendChild(el('button', { class: 'rnfp-retry', type: 'button', text: 'Try again',
      title: 'Ask Reddit for the list again. Most failures here are a dropped request or a ' +
             'signed-out session.',
      onclick: () => refresh(true) }));
  }
  function hideStatus() { if (ui.status) ui.status.className = 'rnfp-status'; }

  async function refresh(showSpinner) {
    if (!isOpen() || loading) return;
    setLoading(true);
    if (showSpinner && items.length === 0) showStatus('loading', 'Loading notifications…');
    try {
      const result = await fetchInbox();
      if (!isOpen()) return;
      items = result.items;
      moreUrl = result.more;
      lastLoadedAt = Date.now();
      hideStatus();
      renderList();
      if (result.loggedOut) showStatus('error', 'You appear to be logged out of Reddit.', true);
    } catch (err) {
      if (!isOpen()) return;
      if (items.length === 0) showStatus('error', err && err.message ? err.message : 'Could not load notifications.', true);
      else updateFoot(err && err.message ? 'Refresh failed: ' + err.message : 'Refresh failed');
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!moreUrl || loading) return;
    setLoading(true);
    const url = moreUrl;
    try {
      const result = await fetchInbox(url);
      const seen = new Set(items.map(i => i.id));
      for (const it of result.items) if (!seen.has(it.id)) items.push(it);
      moreUrl = result.more && result.more !== url ? result.more : null;
      renderList();
    } catch (err) {
      updateFoot('Load more failed: ' + (err && err.message ? err.message : 'unknown error'));
    } finally {
      setLoading(false);
    }
  }

  function renderList() {
    if (!panel) return;
    applyTheme(panel);
    ui.list.textContent = '';
    for (const item of items) ui.list.appendChild(renderItem(item));
    ui.more.classList.toggle('visible', !!moreUrl);
    if (items.length === 0 && !loading && lastLoadedAt) showStatus('empty', 'No notifications.');
    updateBadge();
    updateFoot();
  }

  function renderItem(item) {
    const avatar = item.avatar
      ? el('img', { class: 'rnfp-avatar', src: item.avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
      : el('div', { class: 'rnfp-avatar' }, ICON.user());
    if (avatar.tagName === 'IMG') {
      avatar.addEventListener('error', () => { const ph = el('div', { class: 'rnfp-avatar' }, ICON.user()); avatar.replaceWith(ph); }, { once: true });
    }
    const markBtn = el('button', { class: 'rnfp-btn', type: 'button', 'aria-label': 'Mark as read',
      title: 'Mark just this one as read, without opening it.',
      onclick: e => { e.stopPropagation(); markItemRead(item); } }, ICON.check());
    const openBtn = el('button', { class: 'rnfp-btn', type: 'button', 'aria-label': 'Open in a new tab',
      title: 'Open this notification in a new tab, whatever the new-tab setting says.',
      onclick: e => { e.stopPropagation(); openItem(item, { forceNewTab: true }); } }, ICON.external());
    const li = el('li', { class: 'rnfp-item' + (item.unread ? ' unread' : ''), 'data-id': item.id, role: 'link', tabindex: '0' },
      avatar,
      el('div', { class: 'rnfp-main' },
        el('div', { class: 'rnfp-item-title', text: item.title || '(notification)' }),
        el('div', { class: 'rnfp-item-body', text: item.body }),
        el('div', { class: 'rnfp-item-meta', text: agoLabel(item) }),
      ),
      el('div', { class: 'rnfp-item-actions' }, item.unread ? markBtn : null, openBtn),
    );
    li.addEventListener('click', e => { if (e.target.closest('button')) return; openItem(item, { background: e.ctrlKey || e.metaKey }); });
    li.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); openItem(item, { forceNewTab: true, background: true }); } });
    li.addEventListener('keydown', e => { if (e.key === 'Enter') openItem(item, {}); });
    return li;
  }

  function updateBadge() {
    if (!panel) return;
    const unread = items.filter(i => i.unread).length;
    ui.count.textContent = unread > 0 ? String(unread) : '';
    const had = ui.title.classList.contains('has-unread');
    ui.title.classList.toggle('has-unread', unread > 0);
    ui.title.title = unread === 0
      ? 'Nothing unread in the ' + items.length + ' notification' + (items.length === 1 ? '' : 's') + ' loaded here.'
      : unread + ' unread of the ' + items.length + ' loaded here. Drag this bar to move the panel.';
    ui.markAllBtn.disabled = unread === 0;
    if (unread > lastUnread && had) {
      // Re-trigger the ring animation when more unread arrive while already unread.
      const svg = ui.title.querySelector('svg');
      if (svg) { svg.style.animation = 'none'; void svg.offsetWidth; svg.style.animation = ''; }
    }
    // Only after a real fetch: renderList() also runs with an empty list before the first
    // one, and a count that was already waiting when the panel opened must not flash.
    if (lastLoadedAt) {
      setTitleBadge(unread, titleSeeded);
      titleSeeded = true;
    }
    lastUnread = unread;
  }

  function updateFoot(override) {
    if (!panel) return;
    if (override) { ui.footLeft.textContent = override; ui.footLeft.title = override; return; }
    const parts = [];
    if (lastLoadedAt) parts.push('Updated ' + relativeTime(new Date(lastLoadedAt).toISOString(), '') + (Date.now() - lastLoadedAt >= 60000 ? ' ago' : ''));
    parts.push('Auto: ' + refreshLabel(settings.refreshMs));
    ui.footLeft.textContent = parts.join(' · ');
    ui.footLeft.title = (lastLoadedAt
      ? 'Last fetched from Reddit at ' + new Date(lastLoadedAt).toLocaleTimeString() + '. '
      : 'Not fetched yet. ') +
      (settings.refreshMs
        ? 'Checking again every ' + refreshLabel(settings.refreshMs) + ' while the panel is open.'
        : 'Auto-refresh is off — use Reload.');
  }

  // ---------------------------------------------------------------------------
  // Tab title indicator
  //
  // Needs no @grant and no permission prompt: the tab title is plain DOM. Reddit rewrites it
  // on every SPA navigation, so a MutationObserver on <head> re-applies the badge and adopts
  // anything it did not write itself as the new base title. The badge only tracks while the
  // panel is open, because that is the only time the script polls the inbox.
  // ---------------------------------------------------------------------------
  let baseTitle       = document.title;
  let titleCount      = 0;
  let titleWritten    = null;   // the exact string we last set, to tell our writes from Reddit's
  let titleFlashTimer = null;
  let titleObserver   = null;
  let titleSeeded     = false;  // the first count after opening is shown but never flashed

  function stripBadge(t) {
    const m = t.match(/^\(\d+\)\s([\s\S]+)$/);
    return m ? m[1] : t;
  }

  function writeTitle(text) {
    titleWritten = text;
    if (document.title !== text) document.title = text;
  }

  function badgedTitle() {
    return settings.titleCount && titleCount > 0 ? '(' + titleCount + ') ' + baseTitle : baseTitle;
  }

  function alertTitle() {
    return titleCount > 1 ? titleCount + ' New Notifications!' : 'New Notification!';
  }

  // ---------------------------------------------------------------------------
  // Favicon flashing
  //
  // A page cannot colour its own tab — there is no API for browser chrome, and
  // <meta name="theme-color"> only reaches mobile UI. The favicon is the one pixel of the
  // tab a page owns, and swapping it is how Discord and Slack do the half of their "flash"
  // that is not the title. So the flash alternates a generated badge icon with the page's
  // real one.
  //
  // The icon is built as an SVG data URI rather than a canvas: drawing Reddit's own favicon
  // (served from redditstatic.com) into a canvas would taint it and toDataURL would throw.
  // Note `%23` for the colour — a literal `#` in a data URI starts the fragment and
  // truncates the image.
  // ---------------------------------------------------------------------------
  let savedIcons   = null;   // the page's own <link rel=icon>s, detached while ours is up
  let ourIcon      = null;
  let pageIconHref = null;   // the page's own icon, remembered so it can be put back

  function flashIconHref() {
    const n = titleCount > 99 ? '99+' : String(titleCount);
    const size = n.length > 2 ? 13 : n.length > 1 ? 17 : 20;
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E"
      + "%3Ccircle cx='16' cy='16' r='16' fill='%23d93900'/%3E"
      + "%3Ctext x='16' y='16' fill='white' font-family='Arial,Helvetica,sans-serif'"
      + " font-size='" + size + "' font-weight='bold' text-anchor='middle'"
      + " dominant-baseline='central'%3E" + n + "%3C/text%3E%3C/svg%3E";
  }

  // The badge goes up ONCE when the flash starts and comes down when it ends. It does not
  // blink along with the title, and that is the fix rather than a compromise: a page has no
  // way to observe when the browser actually repaints tab chrome, so two channels told to
  // change at the same instant will drift by whatever the browser's own favicon latency
  // happens to be, and nothing in the page can measure or correct it. Alternating four times
  // put that drift on show twice a second; a badge that simply stays up has one transition at
  // each end and nothing left to be out of step with. It is also what Discord and Slack do —
  // their favicon badge is steady, only the title blinks.
  function beginIconFlash() {
    if (ourIcon || !document.head) return;
    savedIcons = Array.from(document.head.querySelectorAll('link[rel~="icon"]'));
    // The last icon link is the one the browser would have picked; with none declared, the
    // implicit /favicon.ico is the honest thing to put back.
    pageIconHref = savedIcons.length ? savedIcons[savedIcons.length - 1].href : '/favicon.ico';
    for (const l of savedIcons) l.remove();
    ourIcon = el('link', { rel: 'icon', type: 'image/svg+xml', href: flashIconHref() });
    document.head.appendChild(ourIcon);
  }

  function endIconFlash() {
    if (ourIcon) { ourIcon.remove(); ourIcon = null; }
    if (savedIcons) { for (const l of savedIcons) document.head.appendChild(l); savedIcons = null; }
    pageIconHref = null;
  }
  // Never leave Reddit wearing our favicon if the tab goes away mid-flash.
  window.addEventListener('pagehide', endIconFlash);

  function stopTitleFlash() {
    if (titleFlashTimer) { clearTimeout(titleFlashTimer); titleFlashTimer = null; }
    endIconFlash();
  }

  // Blink the whole title, so the change is visible in the few characters a tab actually
  // shows, then settle on the "(n) " badge. The favicon badge is raised for the whole of it.
  function startTitleFlash(onDone) {
    stopTitleFlash();
    beginIconFlash();
    let step = 0;
    const tick = () => {
      if (step >= FLASH_CYCLES * 2) {
        titleFlashTimer = null;
        endIconFlash();
        if (onDone) onDone(); else writeTitle(badgedTitle());
        return;
      }
      writeTitle(step % 2 === 0 ? alertTitle() : badgedTitle());
      step++;
      titleFlashTimer = setTimeout(tick, FLASH_MS);
    };
    tick();
  }

  // Run one flash on demand, so toggling the setting shows what it does rather than making
  // the user wait for a real notification. Deliberately fires on untick too — that is the
  // moment you are deciding whether you want the thing, and it is the same demonstration
  // either way — which is why it does NOT test settings.titleFlash: the caller has just
  // changed it, and a preview is an explicit request rather than the automatic behaviour the
  // setting governs. Stands in a count of 1 when nothing is actually unread (a preview
  // against a count of 0 would blink an empty badge and a "0" favicon) and re-derives the
  // true count when the blink ends, so it cannot leave the tab claiming an unread that is
  // not there.
  function previewFlash() {
    if (!settings.titleCount || !isOpen()) return;
    watchTitle();
    titleCount = Math.max(1, titleCount);
    startTitleFlash(() => {
      titleCount = items.filter(i => i.unread).length;
      writeTitle(badgedTitle());
    });
  }

  function watchTitle() {
    if (titleObserver || !document.head) return;
    baseTitle = stripBadge(document.title);
    titleObserver = new MutationObserver(() => {
      if (document.title === titleWritten) return;   // our own write echoing back
      baseTitle = stripBadge(document.title);
      writeTitle(titleFlashTimer ? alertTitle() : badgedTitle());
    });
    // <head>, not <title>: Reddit may replace the whole element rather than its text node.
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  }

  function setTitleBadge(count, flash) {
    const grew = flash && count > titleCount && count > 0;
    titleCount = count;
    if (!settings.titleCount) { stopTitleFlash(); writeTitle(baseTitle); return; }
    watchTitle();
    if (grew && settings.titleFlash) startTitleFlash();
    else if (!titleFlashTimer) writeTitle(badgedTitle());
  }

  // Called when the settings toggles change.
  function refreshTitle() {
    if (isOpen()) setTitleBadge(titleCount, false);
  }

  function clearTitle() {
    stopTitleFlash();
    titleCount = 0;
    titleSeeded = false;
    if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
    if (titleWritten !== null) { writeTitle(baseTitle); titleWritten = null; }
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function openUrl(url, forceNewTab, background) {
    url = localizeHref(url);
    const newTab = forceNewTab || settings.newTab;
    if (newTab) {
      const active = background ? false : settings.switchTab;
      if (typeof GM_openInTab === 'function') GM_openInTab(url, { active, insert: true, setParent: true });
      else window.open(url, '_blank', 'noopener');
    } else {
      location.href = url;
    }
  }

  function openItem(item, opts) {
    opts = opts || {};
    if (item.unread && settings.markReadOnOpen) markItemRead(item);
    if (!item.href) return;
    openUrl(item.href, !!opts.forceNewTab, !!opts.background);
  }

  function markItemRead(item) {
    if (!item.unread) return;
    item.unread = false;
    renderList();
    markNotificationRead(item).catch(err => {
      item.unread = true;
      renderList();
      updateFoot('Mark read failed: ' + (err && err.message ? err.message : 'unknown error'));
    });
  }

  function onMarkAllClick() {
    doMarkAllRead();
  }

  function doMarkAllRead() {
    const previously = items.map(i => i.unread);
    for (const it of items) it.unread = false;
    if (panel) { renderList(); ui.markAllBtn.disabled = true; }
    markAllRead().then(() => {
      // Refresh so the server's view (including items beyond the loaded page) wins.
      if (isOpen()) refresh(false);
    }).catch(err => {
      items.forEach((it, i) => { it.unread = previously[i]; });
      if (panel) { renderList(); updateFoot('Mark all read failed: ' + (err && err.message ? err.message : 'unknown error')); }
    });
  }

  // ---------------------------------------------------------------------------
  // Auto refresh
  // ---------------------------------------------------------------------------
  function startAutoRefresh() {
    stopAutoRefresh();
    const ms = settings.refreshMs;
    if (!ms || ms < MIN_REFRESH_MS) return;
    refreshTimer = setInterval(() => { if (!document.hidden && isOpen()) refresh(false); }, ms);
  }
  function stopAutoRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !isOpen() || !settings.refreshMs) return;
    if (Date.now() - lastLoadedAt >= settings.refreshMs) refresh(false);
  });

  // ---------------------------------------------------------------------------
  // Bell context menu
  // ---------------------------------------------------------------------------
  let ctxMenu = null;
  function removeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }

  function showContextMenu(e, bell) {
    removeCtxMenu();
    const open = isOpen();
    const unread = items.filter(i => i.unread).length;
    const entries = [
      { icon: ICON.external(), label: 'Open Reddit notifications page', action: () => openUrl(NOTIF_PAGE, true),
        tip: "Leave the panel alone and open Reddit's own inbox page in a new tab." },
      { icon: ICON.panel(),    label: open ? 'Hide notifications panel' : 'Show notifications panel', action: togglePanel,
        tip: open
          ? 'Close the floating panel. Left-clicking the bell does this too.'
          : 'Open the floating panel here. Left-clicking the bell does this too.' },
      { icon: ICON.checkAll(), label: 'Mark all as read', action: doMarkAllRead, disabled: open && unread === 0 && lastLoadedAt > 0,
        tip: 'Mark every notification in your Reddit inbox as read, without opening the panel.' },
      { icon: ICON.reset(),    label: 'Reset panel location', action: resetPanel,
        tip: 'Put the panel back in its default place and size, tucked inside the right sidebar.' },
    ];
    const ul = el('ul', { id: CTX_ID, role: 'menu' });
    for (const it of entries) {
      ul.appendChild(el('li', { role: 'menuitem', title: it.tip, class: it.disabled ? 'disabled' : undefined, onclick: () => { removeCtxMenu(); it.action(); } },
        it.icon, el('span', { text: it.label })));
    }
    applyTheme(ul);
    document.body.appendChild(ul);
    ctxMenu = ul;
    const vp = viewport();
    const mw = ul.offsetWidth, mh = ul.offsetHeight;
    let x, y;
    if (bell) { const r = bell.getBoundingClientRect(); x = r.right - mw; y = r.bottom + 6; }
    else { x = e.clientX; y = e.clientY; }
    x = Math.max(4, Math.min(x, vp.w - mw - 4));
    y = Math.max(4, Math.min(y, vp.h - mh - 4));
    ul.style.left = x + 'px';
    ul.style.top  = y + 'px';
  }

  function bellFromEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (const n of path) {
      if (n && n.nodeType === 1 && n.id === BELL_ID && n.tagName === 'A') return n;
    }
    return null;
  }

  // Capture on window so this runs before Reddit's own handlers and before any other
  // userscript's document-level listeners. Only the bell anchor itself (by id) matches;
  // no fuzzy label matching, which is what used to swallow clicks on the notifications page.
  function onBellEvent(e) {
    if (ctxMenu && ctxMenu.contains(e.target)) return;
    const bell = bellFromEvent(e);
    if (!bell) { if (e.type === 'click') removeCtxMenu(); return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (ctxMenu) { removeCtxMenu(); return; }
    showContextMenu(e, bell);
  }
  window.addEventListener('click', onBellEvent, true);
  window.addEventListener('contextmenu', onBellEvent, true);
  window.addEventListener('auxclick', e => { if (bellFromEvent(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (document.body) applyArrivalState();
  else document.addEventListener('DOMContentLoaded', applyArrivalState, { once: true });
})();
