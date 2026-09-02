// ==UserScript==
// @name         Reddit Notifications Floating Panel
// @namespace    https://github.com/VitaKaninen
// @version      6.0.0
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
  const SS_OPEN      = 'rnfp.open';
  const SS_MINIMIZED = 'rnfp.minimized';

  const DEFAULT_SETTINGS = {
    refreshMs: 120000,
    newTab: true,
    switchTab: true,
    markReadOnOpen: true,
  };

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
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const o = Object.assign({ fill: 'none', stroke: 'currentColor', width: 2 }, opts || {});
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
    bell:     () => svgIcon(['M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z'], 15, { fill: 'currentColor', stroke: 'none' }),
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
      --accent:    #ff4500;
      --accent2:   #ff6a33;
      --danger:    #c0392b;
      --shadow:    0 8px 24px rgba(0,0,0,.6);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.35;
      color: var(--text);
      box-sizing: border-box;
    }
    #${PANEL_ID}.rnfp-light, #${CTX_ID}.rnfp-light {
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
      padding: 0 6px 0 10px;
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
      gap: 7px;
      font-weight: 700;
      font-size: 13px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${PANEL_ID} .rnfp-title svg { flex: 0 0 auto; }
    #${PANEL_ID} .rnfp-title .rnfp-title-text { overflow: hidden; text-overflow: ellipsis; }
    #${PANEL_ID} .rnfp-title.has-unread { color: var(--accent); }
    #${PANEL_ID} .rnfp-title.has-unread svg { animation: rnfp-ring .9s ease .1s; }
    @keyframes rnfp-ring {
      0%,100% { transform: rotate(0); } 15% { transform: rotate(15deg); } 30% { transform: rotate(-12deg); }
      45% { transform: rotate(10deg); } 60% { transform: rotate(-8deg); } 75% { transform: rotate(5deg); }
    }
    #${PANEL_ID} .rnfp-count {
      flex: 0 0 auto;
      background: var(--accent);
      color: #fff;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      padding: 1px 6px;
      line-height: 1.3;
    }
    #${PANEL_ID} .rnfp-count:empty { display: none; }

    #${PANEL_ID} .rnfp-controls { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; }
    #${PANEL_ID} .rnfp-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      min-width: 24px;
      padding: 0 5px;
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
    #${PANEL_ID} .rnfp-split .rnfp-btn:last-child  { border-radius: 0 5px 5px 0; min-width: 18px; padding: 0 2px; }

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
    #${PANEL_ID} .rnfp-item.unread { background: color-mix(in srgb, var(--accent) 7%, var(--bg)); }
    #${PANEL_ID} .rnfp-item.unread:hover { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }
    #${PANEL_ID} .rnfp-item.unread::before {
      content: '';
      position: absolute;
      left: 4px;
      top: 15px;
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
    }
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
    #${PANEL_ID} .rnfp-item-title { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
    #${PANEL_ID} .rnfp-item.unread .rnfp-item-title { color: var(--accent2); }
    #${PANEL_ID}.rnfp-light .rnfp-item.unread .rnfp-item-title { color: #d93a00; }
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
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 5px;
      cursor: pointer;
    }
    #${PANEL_ID} .rnfp-spinner {
      width: 26px; height: 26px;
      margin: 0 auto 10px;
      border: 3px solid var(--bg3);
      border-top-color: var(--accent);
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
    #${PANEL_ID} .rnfp-menu-item.selected { color: var(--accent); font-weight: 600; }
    #${PANEL_ID} .rnfp-menu-item input[type=checkbox] { margin: 0; accent-color: var(--accent); }
    #${PANEL_ID} .rnfp-menu-item.nested { padding-left: 26px; }
    #${PANEL_ID} .rnfp-menu-item.disabled { opacity: .4; pointer-events: none; }
    #${PANEL_ID} .rnfp-menu-row { display: flex; align-items: center; gap: 6px; padding: 6px 12px; }
    #${PANEL_ID} .rnfp-menu-row input[type=number] {
      width: 64px;
      padding: 3px 5px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 4px;
      font: inherit;
    }
    #${PANEL_ID} .rnfp-menu-row .rnfp-ok {
      padding: 3px 8px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
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
    #${CTX_ID} li:hover { background: var(--bg2); color: var(--accent); }
    #${CTX_ID} li:hover svg { color: var(--accent); }
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
    saveJSON(KEY_GEOMETRY, { ...geometry, vw: vp.w, vh: vp.h });
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
    ui.title     = el('div', { class: 'rnfp-title' }, ICON.bell(), ui.titleText, ui.count);

    ui.markAllBtn  = el('button', { class: 'rnfp-btn', type: 'button', title: 'Mark all as read', 'aria-label': 'Mark all as read', onclick: onMarkAllClick }, ICON.checkAll());
    ui.reloadBtn   = el('button', { class: 'rnfp-btn', type: 'button', title: 'Reload', 'aria-label': 'Reload', onclick: () => refresh(true) }, ICON.reload());
    ui.intervalBtn = el('button', { class: 'rnfp-btn', type: 'button', title: 'Auto-refresh interval', 'aria-label': 'Auto-refresh interval', onclick: toggleIntervalMenu }, ICON.chevron());
    ui.settingsBtn = el('button', { class: 'rnfp-btn', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: toggleSettingsMenu }, ICON.gear());
    ui.minBtn      = el('button', { class: 'rnfp-btn', type: 'button', title: 'Minimize', 'aria-label': 'Minimize', onclick: toggleMinimized }, ICON.minimize());
    ui.closeBtn    = el('button', { class: 'rnfp-btn rnfp-close', type: 'button', title: 'Close', 'aria-label': 'Close', onclick: closePanel }, ICON.close());

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
    ui.more   = el('button', { class: 'rnfp-more', type: 'button', text: 'Load more', onclick: loadMore });
    ui.body   = el('div', { class: 'rnfp-body' }, ui.list, ui.status, ui.more);

    ui.footLeft  = el('span', { text: '' });
    ui.footRight = el('a', { href: NOTIF_PAGE, text: 'Open notifications page', onclick: e => { e.preventDefault(); openUrl(NOTIF_PAGE, true); } });
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
    geometry = hasSaved ? adaptGeometry(saved) : clampGeometry(defaultGeometry());
    if (!hasSaved) saveGeometry();

    minimized = sessionStorage.getItem(SS_MINIMIZED) === '1';
    panel.classList.toggle('rnfp-minimized', minimized);
    updateMinButton();

    document.body.appendChild(panel);
    applyTheme(panel);
    layoutPanel();
    sessionStorage.setItem(SS_OPEN, '1');

    renderList();
    refresh(true);
    startAutoRefresh();
    footClockTimer = setInterval(updateFoot, 30000);
  }

  function closePanel() {
    stopAutoRefresh();
    clearInterval(footClockTimer);
    footClockTimer = null;
    closeMenus();
    if (panel) panel.remove();
    panel = null;
    sessionStorage.removeItem(SS_OPEN);
  }

  function togglePanel() { if (isOpen()) closePanel(); else openPanel(); }

  function resetPanel() {
    const g = defaultGeometry();
    minimized = false;
    sessionStorage.removeItem(SS_MINIMIZED);
    if (panel) { panel.classList.remove('rnfp-minimized'); updateMinButton(); }
    geometry = clampGeometry(g);
    saveGeometry();
    if (!isOpen()) openPanel(); else layoutPanel();
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
    if (panel && !panel.isConnected && sessionStorage.getItem(SS_OPEN) === '1') {
      document.body.appendChild(panel);
      layoutPanel();
    }
  }
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigatesuccess', () => setTimeout(ensureAttached, 0));
  }
  window.addEventListener('popstate', () => setTimeout(ensureAttached, 0));

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
      panel.classList.add('rnfp-dragging');
      const move = ev => {
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
        setGeometry(geometry, true);
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
        panel.classList.add('rnfp-dragging');
        const move = ev => {
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
          setGeometry(geometry, true);
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
  function positionMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    const vp = viewport();
    menu.style.left = '0px';
    menu.style.top  = '0px';
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let left = r.right - mw;
    let top  = r.bottom + 4;
    if (left < 4) left = 4;
    if (left + mw > vp.w - 4) left = vp.w - mw - 4;
    if (top + mh > vp.h - 4) top = r.top - mh - 4;
    if (top < 4) top = 4;
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
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
    buildIntervalMenu(false);
    ui.intervalMenu.classList.add('open');
    positionMenu(ui.intervalMenu, ui.intervalBtn);
  }

  function buildIntervalMenu(customMode) {
    const menu = ui.intervalMenu;
    menu.textContent = '';
    if (customMode) {
      const input = el('input', { type: 'number', min: String(MIN_REFRESH_MS / 1000), step: '5', value: String(Math.max(MIN_REFRESH_MS, settings.refreshMs || 60000) / 1000) });
      const apply = () => {
        const secs = parseInt(input.value, 10);
        if (isNaN(secs) || secs * 1000 < MIN_REFRESH_MS) { input.focus(); input.select(); return; }
        settings.refreshMs = secs * 1000;
        saveSettings();
        startAutoRefresh();
        closeMenus();
        updateFoot();
      };
      input.addEventListener('keydown', ev => { if (ev.key === 'Enter') apply(); if (ev.key === 'Escape') closeMenus(); });
      menu.appendChild(el('div', { class: 'rnfp-menu-row' }, input, el('span', { text: 'sec' }), el('button', { class: 'rnfp-ok', type: 'button', text: 'OK', onclick: apply })));
      positionMenu(menu, ui.intervalBtn);
      requestAnimationFrame(() => { input.focus(); input.select(); });
      return;
    }
    const options = REFRESH_OPTIONS.slice();
    const isPreset = options.some(o => o.ms === settings.refreshMs);
    if (!isPreset && settings.refreshMs) options.splice(options.length - 1, 0, { label: refreshLabel(settings.refreshMs), ms: settings.refreshMs });
    for (const opt of options) {
      menu.appendChild(el('button', {
        class: 'rnfp-menu-item' + (opt.ms === settings.refreshMs ? ' selected' : ''),
        type: 'button', role: 'menuitem', text: opt.label,
        onclick: () => { settings.refreshMs = opt.ms; saveSettings(); startAutoRefresh(); closeMenus(); updateFoot(); },
      }));
    }
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(el('button', { class: 'rnfp-menu-item', type: 'button', role: 'menuitem', text: 'Custom…', onclick: () => buildIntervalMenu(true) }));
  }

  function toggleSettingsMenu(e) {
    e.stopPropagation();
    const opening = !ui.settingsMenu.classList.contains('open');
    closeMenus();
    if (!opening) return;
    buildSettingsMenu();
    ui.settingsMenu.classList.add('open');
    positionMenu(ui.settingsMenu, ui.settingsBtn);
  }

  function buildSettingsMenu() {
    const menu = ui.settingsMenu;
    menu.textContent = '';
    function checkRow(label, key, nested, onChange) {
      const cb = el('input', { type: 'checkbox', id: 'rnfp-set-' + key });
      cb.checked = !!settings[key];
      cb.addEventListener('change', () => { settings[key] = cb.checked; saveSettings(); if (onChange) onChange(); });
      const row = el('label', { class: 'rnfp-menu-item' + (nested ? ' nested' : ''), for: cb.id }, el('span', { text: label }), cb);
      return { row, cb };
    }
    const switchRow = checkRow('Switch to the new tab', 'switchTab', true);
    const newTabRow = checkRow('Open links in a new tab', 'newTab', false, () => switchRow.row.classList.toggle('disabled', !settings.newTab));
    switchRow.row.classList.toggle('disabled', !settings.newTab);
    const markRow = checkRow('Mark read when opened', 'markReadOnOpen', false);
    menu.appendChild(newTabRow.row);
    menu.appendChild(switchRow.row);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(markRow.row);
    menu.appendChild(el('div', { class: 'rnfp-menu-sep' }));
    menu.appendChild(el('button', { class: 'rnfp-menu-item', type: 'button', role: 'menuitem', text: 'Reset panel position & size', onclick: () => { closeMenus(); resetPanel(); } }));
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
    if (retry) ui.status.appendChild(el('button', { class: 'rnfp-retry', type: 'button', text: 'Try again', onclick: () => refresh(true) }));
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
    const markBtn = el('button', { class: 'rnfp-btn', type: 'button', title: 'Mark as read', 'aria-label': 'Mark as read',
      onclick: e => { e.stopPropagation(); markItemRead(item); } }, ICON.check());
    const openBtn = el('button', { class: 'rnfp-btn', type: 'button', title: 'Open in a new tab', 'aria-label': 'Open in a new tab',
      onclick: e => { e.stopPropagation(); openItem(item, { forceNewTab: true }); } }, ICON.external());
    const li = el('li', { class: 'rnfp-item' + (item.unread ? ' unread' : ''), 'data-id': item.id, role: 'link', tabindex: '0' },
      avatar,
      el('div', { class: 'rnfp-main' },
        el('div', { class: 'rnfp-item-title', text: item.title || '(notification)' }),
        el('div', { class: 'rnfp-item-body', text: item.body }),
        el('div', { class: 'rnfp-item-meta', text: relativeTime(item.datetime, item.timeText) + (item.datetime ? ' ago' : '') }),
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
    ui.titleText.textContent = unread > 0 ? 'New notifications' : 'Notifications';
    ui.markAllBtn.disabled = unread === 0;
    if (unread > lastUnread && had) {
      // Re-trigger the ring animation when more unread arrive while already unread.
      const svg = ui.title.querySelector('svg');
      if (svg) { svg.style.animation = 'none'; void svg.offsetWidth; svg.style.animation = ''; }
    }
    lastUnread = unread;
  }

  function updateFoot(override) {
    if (!panel) return;
    if (override) { ui.footLeft.textContent = override; return; }
    const parts = [];
    if (lastLoadedAt) parts.push('Updated ' + relativeTime(new Date(lastLoadedAt).toISOString(), '') + (Date.now() - lastLoadedAt >= 60000 ? ' ago' : ''));
    parts.push('Auto: ' + refreshLabel(settings.refreshMs));
    ui.footLeft.textContent = parts.join(' · ');
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
      { icon: ICON.external(), label: 'Open Reddit notifications page', action: () => openUrl(NOTIF_PAGE, true) },
      { icon: ICON.panel(),    label: open ? 'Hide notifications panel' : 'Show notifications panel', action: togglePanel },
      { icon: ICON.checkAll(), label: 'Mark all as read', action: doMarkAllRead, disabled: open && unread === 0 && lastLoadedAt > 0 },
      { icon: ICON.reset(),    label: 'Reset panel location', action: resetPanel },
    ];
    const ul = el('ul', { id: CTX_ID, role: 'menu' });
    for (const it of entries) {
      ul.appendChild(el('li', { role: 'menuitem', class: it.disabled ? 'disabled' : undefined, onclick: () => { removeCtxMenu(); it.action(); } },
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
  if (sessionStorage.getItem(SS_OPEN) === '1') {
    if (document.body) openPanel();
    else document.addEventListener('DOMContentLoaded', openPanel, { once: true });
  }
})();
