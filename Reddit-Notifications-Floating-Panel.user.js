// ==UserScript==
// @name         Reddit Notifications Floating Panel
// @namespace    https://github.com/VitaKaninen
// @version      5.5.0
// @description  Right-click the Reddit notifications bell to open a floating, movable, resizable panel
// @author       VitaKaninen
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_openInTab
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/VitaKaninen/Reddit-Notifications-Floating-Panel/main/Reddit-Notifications-Floating-Panel.user.js
// @updateURL    https://raw.githubusercontent.com/VitaKaninen/Reddit-Notifications-Floating-Panel/main/Reddit-Notifications-Floating-Panel.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window !== window.top) return;

  if (document.getElementById('vm-notif-panel-loaded')) return;
  const marker = document.createElement('meta');
  marker.id = 'vm-notif-panel-loaded';
  document.head.appendChild(marker);

  const STORAGE_KEY    = 'reddit_notif_panel_v2';
  const PANEL_ID       = 'vm-notif-panel';
  const Z_INDEX        = 2147483647;
  const NOTIF_URL      = 'https://www.reddit.com/notifications/';
  const MIN_W = 180, MIN_H = 32, EDGE = 6;
  function snapPx(v) { const dpr = window.devicePixelRatio || 1; return Math.round(v * dpr) / dpr; }
  const LOAD_TIMEOUT   = 15000;
  const REFRESH_OPTIONS = [
    { label: '30s',     ms: 30000   },
    { label: '1 min',   ms: 60000   },
    { label: '2 min',   ms: 120000  },
    { label: '5 min',   ms: 300000  },
    { label: '10 min',  ms: 600000  },
    { label: 'Off',     ms: 0       },
    { label: 'Custom…', ms: -1      },
  ];
  const DEFAULT_REFRESH_MS = 120000;
  const DEFAULT_STATE = { x: 80, y: 80, w: 440, h: 620 };

  function loadState() {
    try { return Object.assign({}, DEFAULT_STATE, JSON.parse(GM_getValue(STORAGE_KEY, '{}'))) }
    catch { return { ...DEFAULT_STATE }; }
  }
  function saveState(s) { GM_setValue(STORAGE_KEY, JSON.stringify({ ...s, vw: window.innerWidth, vh: window.innerHeight })); }

  function repositionForViewport(s) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const nw = Math.min(s.w, vw), nh = Math.min(s.h, vh);
    let nx = s.x, ny = s.y;
    if (s.vw && s.vh) {
      if (s.vw === vw && s.vh === vh) return s;
      const distLeft = s.x, distRight  = s.vw - (s.x + s.w);
      const distTop  = s.y, distBottom = s.vh - (s.y + s.h);
      nx = distRight  <= distLeft  ? vw - distRight  - nw : distLeft;
      ny = distBottom <= distTop   ? vh - distBottom - nh : distTop;
    } else {
      // No saved viewport — anchor from nearest edge of current viewport
      const distLeft = s.x, distRight  = vw - (s.x + s.w);
      const distTop  = s.y, distBottom = vh - (s.y + s.h);
      nx = distRight  <= distLeft ? vw - nw : s.x;
      ny = distBottom <= distTop  ? vh - nh : s.y;
    }
    nx = Math.max(0, Math.min(nx, vw - nw));
    ny = Math.max(0, Math.min(ny, vh - nh));
    return { x: nx, y: ny, w: nw, h: nh };
  }
  function getThemeColors() {
    const cs = getComputedStyle(panel);
    return {
      bg2:    cs.getPropertyValue('--vm-bg2').trim()        || '#272729',
      text:   cs.getPropertyValue('--vm-text').trim()       || '#d7dadc',
      muted:  cs.getPropertyValue('--vm-text-muted').trim() || '#818384',
      border: cs.getPropertyValue('--vm-btn-border').trim() || '#555',
    };
  }

  function syncTheme() {
    if (!panel) return;
    const cs = getComputedStyle(document.documentElement);
    const get = v => cs.getPropertyValue(v).trim();
    const bg = get('--color-neutral-background-strong') || get('--background') || '';
    const isLight = bg && (bg.startsWith('#F') || bg.startsWith('#f') || bg.startsWith('rgb(2') || bg === '#FFFFFF' || bg === '#ffffff');
    if (isLight) {
      const bg2    = get('--color-neutral-background-weak') || '#F6F8F9';
      const border = get('--color-neutral-border-weak')     || '#E5E8EB';
      const text   = get('--color-neutral-content-strong')  || '#1c1c1c';
      const muted  = get('--color-neutral-content-weak')    || '#5C6C74';
      panel.style.setProperty('--vm-bg',         bg);
      panel.style.setProperty('--vm-bg2',        bg2);
      panel.style.setProperty('--vm-border',     border);
      panel.style.setProperty('--vm-text',       text);
      panel.style.setProperty('--vm-text-muted', muted);
      panel.style.setProperty('--vm-btn-bg',     '#d0d5d8');
      panel.style.setProperty('--vm-btn-border', '#b0b8be');
      panel.style.setProperty('--vm-btn-hover',  '#e2e6e9');
    } else {
      panel.style.removeProperty('--vm-bg');
      panel.style.removeProperty('--vm-bg2');
      panel.style.removeProperty('--vm-border');
      panel.style.removeProperty('--vm-text');
      panel.style.removeProperty('--vm-text-muted');
      panel.style.removeProperty('--vm-btn-bg');
      panel.style.removeProperty('--vm-btn-border');
      panel.style.removeProperty('--vm-btn-hover');
    }
  }

  const STYLE = `
    #${PANEL_ID} {
      --vm-bg:         #1a1a1b;
      --vm-bg2:        #272729;
      --vm-border:     #343536;
      --vm-text:       #d7dadc;
      --vm-text-muted: #818384;
      --vm-accent:     #ff4500;
      --vm-btn-bg:     #444;
      --vm-btn-hover:  #343536;
      --vm-btn-border: #555;
      position: fixed;
      background: var(--vm-bg);
      border: 1px solid var(--vm-border);
      border-radius: 8px;
      box-shadow: 0 8px 15px rgba(0,0,0,.75);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      color: var(--vm-text);
      z-index: ${Z_INDEX};
      min-width: ${MIN_W}px;
      min-height: ${MIN_H}px;
    }
    #${PANEL_ID} .vm-header {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 0;
      height: 33px;
      max-height: 33px;
      box-sizing: border-box;
      background: var(--vm-bg2);
      border-bottom: 1px solid var(--vm-border);
      cursor: grab;
      user-select: none;
      flex-shrink: 0;
      min-width: 0;
    }
    #${PANEL_ID} .vm-header:active { cursor: grabbing; }
    #${PANEL_ID} .vm-title {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: .4px;
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      flex-shrink: 1000;
      overflow: hidden;
      padding-left: 10px;
      transition: color .3s;
    }
    #${PANEL_ID} .vm-title svg { flex-shrink: 0; transition: fill .3s; }
    #${PANEL_ID} .vm-title-text {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      min-width: 0;
    }
    #${PANEL_ID} .vm-title.has-unread { color: var(--vm-accent); }
    #${PANEL_ID} .vm-title.has-unread svg { fill: var(--vm-accent); }
    #${PANEL_ID} .vm-title:not(.has-unread) { color: var(--vm-text-muted); }
    #${PANEL_ID} .vm-title:not(.has-unread) svg { fill: var(--vm-text-muted); }
    @keyframes vm-ring {
      0%,100% { transform: rotate(0deg); }
      15%      { transform: rotate(15deg); }
      30%      { transform: rotate(-12deg); }
      45%      { transform: rotate(10deg); }
      60%      { transform: rotate(-8deg); }
      75%      { transform: rotate(5deg); }
    }
    #${PANEL_ID} .vm-title.has-unread svg { animation: vm-ring 1s ease .2s; }
    #${PANEL_ID} .vm-controls { display: flex; flex-direction: row-reverse; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; }
    #${PANEL_ID} .vm-controls > * { flex-shrink: 0; }
    #${PANEL_ID} .vm-btn {
      background: none;
      border: 1px solid var(--vm-btn-border);
      border-radius: 4px;
      color: var(--vm-text-muted);
      cursor: pointer;
      font-size: 11px;
      padding: 0 7px;
      height: 22px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      transition: background .15s, color .15s;
      white-space: nowrap;
    }
    #${PANEL_ID} .vm-btn.minimize        { width: 24px; padding: 0; }
    #${PANEL_ID} .vm-btn.reload          { width: 24px; padding: 0; }
    #${PANEL_ID} .vm-btn.close           { width: 24px; padding: 0; }
    #${PANEL_ID} .vm-btn.vm-settings-btn { width: 24px; padding: 0; }
    #${PANEL_ID} .vm-btn:hover        { background: var(--vm-btn-hover); color: var(--vm-text); }
    #${PANEL_ID} .vm-btn.close:hover  { background: #c0392b; color: #fff; border-color: #c0392b; }
    #${PANEL_ID} .vm-btn:disabled     { opacity: .4; cursor: not-allowed; }
    #${PANEL_ID} {
    }
    #${PANEL_ID}.minimized .vm-loading,
    #${PANEL_ID}.minimized .vm-error { display: none !important; }
    #${PANEL_ID}.minimized .vm-iframe {
      display: none !important;
    }
    #${PANEL_ID}.minimized { height: auto !important; min-height: 0 !important; }
    #${PANEL_ID} .vm-settings-wrap { position: relative; display: flex; align-items: center; }
    #${PANEL_ID} .vm-settings-dropdown {
      display: none;
      position: fixed;
      background: var(--vm-bg2);
      border: 1px solid var(--vm-btn-border);
      border-radius: 6px;
      padding: 10px 12px;
      min-width: 160px;
      box-shadow: 0 4px 20px rgba(0,0,0,.6);
      z-index: ${Z_INDEX};
    }
    #${PANEL_ID} .vm-settings-dropdown.open { display: block; }
    #${PANEL_ID} .vm-settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    #${PANEL_ID} .vm-settings-row label {
      font-size: 11px;
      color: var(--vm-text-muted);
      white-space: nowrap;
    }
    #${PANEL_ID} .vm-settings-row.nested {
      margin-top: 4px;
      padding-left: 14px;
      position: relative;
    }
    #${PANEL_ID} .vm-settings-row.nested::before {
      content: '↳';
      position: absolute;
      left: 0;
      color: #555;
      font-size: 11px;
      top: 50%;
      transform: translateY(-50%);
    }
    #${PANEL_ID} .vm-settings-row.nested.disabled::before { opacity: .35; }
    #${PANEL_ID} .vm-settings-row.nested.disabled label { opacity: .35; cursor: not-allowed; }
    #${PANEL_ID} .vm-settings-row.nested.disabled input { opacity: .35; cursor: not-allowed; pointer-events: none; }
    #${PANEL_ID} .vm-split {
      display: flex;
      align-items: stretch;
      border: 1px solid var(--vm-btn-border);
      border-radius: 4px;
      overflow: hidden;
      height: 22px;
      box-sizing: border-box;
      transition: border-color .15s;
    }
    #${PANEL_ID} .vm-split:hover { border-color: #888; }
    #${PANEL_ID} .vm-split .vm-btn { border: none; border-radius: 0; padding: 0 7px; height: 22px; line-height: 1; }
    #${PANEL_ID} .vm-split .vm-btn:hover { background: var(--vm-btn-hover); color: var(--vm-text); }
    #${PANEL_ID} .vm-split-divider { width: 1px; background: var(--vm-btn-bg); flex-shrink: 0; }
    #${PANEL_ID} .vm-refresh-wrap { position: relative; display: flex; align-items: center; }
    #${PANEL_ID} .vm-refresh-dropdown {
      display: none;
      position: fixed;
      background: var(--vm-bg2);
      border: 1px solid var(--vm-btn-border);
      border-radius: 6px;
      padding: 6px 0;
      min-width: 90px;
      box-shadow: 0 4px 20px rgba(0,0,0,.6);
      z-index: ${Z_INDEX};
    }
    #${PANEL_ID} .vm-refresh-dropdown.open { display: block; }
    #${PANEL_ID} .vm-refresh-item {
      display: block;
      width: 100%;
      padding: 5px 12px;
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
      text-align: left;
      background: none;
      border: none;
      box-sizing: border-box;
    }
    #${PANEL_ID} .vm-refresh-item:hover { background: var(--vm-btn-hover); }
    #${PANEL_ID} .vm-refresh-item.selected { font-weight: bold; }
    #${PANEL_ID} .vm-refresh-custom-row { display: flex; align-items: center; gap: 4px; padding: 4px 8px; }
    #${PANEL_ID} .vm-refresh-custom-input { width: 56px; background: var(--vm-bg); color: var(--vm-text); border: 1px solid var(--vm-border); border-radius: 3px; padding: 2px 4px; font-size: 12px; outline: none; }
    #${PANEL_ID} .vm-refresh-custom-confirm { background: var(--vm-btn-bg); color: var(--vm-text); border: none; border-radius: 3px; padding: 2px 6px; cursor: pointer; font-size: 12px; }
    #${PANEL_ID} .vm-refresh-custom-confirm:hover { background: var(--vm-btn-hover); }
    #${PANEL_ID} .vm-iframe {
      flex: 1;
      width: 100%;
      border: none;
      display: block;
      background: var(--vm-bg);
      visibility: hidden;
    }
    #${PANEL_ID} .vm-iframe.loaded { visibility: visible; }
    #${PANEL_ID} .vm-loading {
      position: absolute;
      inset: 40px 0 0 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: var(--vm-bg);
      color: var(--vm-text-muted);
      font-size: 13px;
      pointer-events: none;
      transition: opacity .3s;
    }
    #${PANEL_ID} .vm-loading.hidden { opacity: 0; pointer-events: none; }
    #${PANEL_ID} .vm-spinner {
      width: 28px; height: 28px;
      border: 3px solid #343536;
      border-top-color: var(--vm-accent);
      border-radius: 50%;
      animation: vm-spin .7s linear infinite;
    }
    @keyframes vm-spin { to { transform: rotate(360deg); } }
    #${PANEL_ID} .vm-error {
      display: none;
      position: absolute;
      inset: 40px 0 0 0;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: var(--vm-bg);
      color: #ff6b6b;
      font-size: 13px;
      text-align: center;
      padding: 20px;
      z-index: 5;
    }
    #${PANEL_ID} .vm-error.visible { display: flex; }
    #${PANEL_ID} .vm-error button {
      margin-top: 6px;
      padding: 6px 14px;
      background: var(--vm-accent);
      color: #fff;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
    }
    #${PANEL_ID} .vm-edge { position: absolute; z-index: 10; }
    #${PANEL_ID} .vm-edge.n  { top:-1px;    left:${EDGE}px;  right:${EDGE}px;  height:${EDGE}px; cursor:n-resize;  }
    #${PANEL_ID} .vm-edge.s  { bottom:-1px; left:${EDGE}px;  right:${EDGE}px;  height:${EDGE}px; cursor:s-resize;  }
    #${PANEL_ID} .vm-edge.w  { left:-1px;   top:${EDGE}px;   bottom:${EDGE}px; width:${EDGE}px;  cursor:w-resize;  }
    #${PANEL_ID} .vm-edge.e  { right:-1px;  top:${EDGE}px;   bottom:${EDGE}px; width:${EDGE}px;  cursor:e-resize;  }
    #${PANEL_ID} .vm-edge.nw { top:-1px;  left:-1px;    width:${EDGE+4}px; height:${EDGE+4}px; cursor:nw-resize; }
    #${PANEL_ID} .vm-edge.ne { top:-1px;  right:-1px;   width:${EDGE+4}px; height:${EDGE+4}px; cursor:ne-resize; }
    #${PANEL_ID} .vm-edge.sw { bottom:-1px; left:-1px;  width:${EDGE+4}px; height:${EDGE+4}px; cursor:sw-resize; }
    #${PANEL_ID} .vm-edge.se { bottom:-1px; right:-1px; width:${EDGE+4}px; height:${EDGE+4}px; cursor:se-resize; }
    #vm-notif-ctx {
      position: fixed;
      background: var(--vm-bg);
      border: 1px solid var(--vm-btn-border);
      border-radius: 6px;
      box-shadow: 0 4px 20px rgba(0,0,0,.6);
      padding: 4px 0;
      z-index: ${Z_INDEX};
      min-width: 200px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      color: var(--vm-text);
      list-style: none;
      margin: 0;
    }
    #vm-notif-ctx li {
      padding: 8px 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 9px;
      transition: background .1s;
    }
    #vm-notif-ctx li:hover { background: var(--vm-bg2); color: var(--vm-accent); }
    #vm-notif-ctx li svg { flex-shrink: 0; transition: stroke .1s; stroke: var(--vm-text-muted); }
    #vm-notif-ctx li:hover svg { stroke: var(--vm-accent); }
  `;

  const IFRAME_CSS = `
    shreddit-app, body, html {
      padding: 0 !important;
      margin: 0 !important;
      overflow-x: hidden !important;
    }
    body { overflow-y: auto !important; }
    shreddit-header, reddit-header-large, reddit-header-small,
    header, nav, #reddit-header, header.v2, .header-container,
    h1, h2, h3, [role="heading"],
    .title, .page-title, .notifications-title,
    [data-testid*="title"], shreddit-navbar,
    [aria-label*="settings"],
    .actions-bar, .top-actions, .gear, .settings-icon,
    [data-testid="subreddit-sidebar"] { display: none !important; }
    [role="listitem"] { padding: 8px 12px !important; margin-bottom: 4px !important; }
    notifications-main-manager,
    .notifications-feed,
    [role="main"],
    [role="list"] { padding: 0 !important; margin: 0 !important; width: 100% !important; }
  `;

  const styleEl = document.createElement('style');
  styleEl.textContent = STYLE;
  document.head.appendChild(styleEl);

  let ctxMenu = null;
  function removeCtxMenu() {
    if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
  }

  function showContextMenu(e) {
    removeCtxMenu();
    const ul = document.createElement('ul');
    ul.id = 'vm-notif-ctx';
    const panelOpen = !!(panel && panel.isConnected);
    const toggleAction = () => panelOpen ? closePanel() : openPanel();
    const items = [
      { icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>', label: 'Open Reddit Notifications Page', action: () => GM_openInTab(NOTIF_URL, { active: true, insert: true }) },
      { icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>', label: panelOpen ? 'Hide Notifications Panel' : 'Show Notifications Panel', action: toggleAction },
      { icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/></svg>', label: 'Reset Panel Location', action: resetPanel },
    ];
    items.forEach(({ icon, label, action }) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${icon}</span><span>${label}</span>`;
      li.addEventListener('click', () => { removeCtxMenu(); action(); });
      ul.appendChild(li);
    });
    document.body.appendChild(ul);
    ctxMenu = ul;
    const mw = ul.offsetWidth || 200, mh = ul.offsetHeight || 90;
    const bell = document.querySelector('#notifications-inbox-button');
    let x, y;
    if (bell) {
      const r = bell.getBoundingClientRect();
      x = r.left;
      y = r.bottom + 8;
    } else {
      x = e.clientX;
      y = e.clientY;
    }
    if (x + mw > window.innerWidth)  x = window.innerWidth  - mw - 8;
    if (y + mh > window.innerHeight) y = window.innerHeight - mh - 8;
    ul.style.left = x + 'px';
    ul.style.top  = y + 'px';
    // Apply colors — read from panel if open, otherwise detect theme directly
    {
      let bg = '#1a1a1b', text = '#d7dadc', border = '#555';
      if (panel) {
        const cs = getComputedStyle(panel);
        bg     = cs.getPropertyValue('--vm-bg').trim()         || bg;
        text   = cs.getPropertyValue('--vm-text').trim()       || text;
        border = cs.getPropertyValue('--vm-btn-border').trim() || border;
      } else {
        // Detect theme from Reddit's CSS variables directly
        const cs = getComputedStyle(document.documentElement);
        const rdBg = cs.getPropertyValue('--color-neutral-background-strong').trim();
        const isLight = rdBg && (rdBg.startsWith('#F') || rdBg.startsWith('#f') || rdBg.startsWith('rgb(2'));
        if (isLight) { bg = '#F6F8F9'; text = '#1c1c1c'; border = '#b0b8be'; }
      }
      ul.style.background  = bg;
      ul.style.color       = text;
      ul.style.borderColor = border;
      ul.querySelectorAll('li').forEach(li => li.style.color = text);
    }
  }

  document.addEventListener('click', removeCtxMenu, true);

  // Reddit writes "/notifications":"inbox" into the shared sessionStorage
  // pathname-page-type-map when the notifications page loads in our iframe.
  // This leaks into the main page and breaks notification item layout.
  // Strip it out so it only ever reflects pages the user actually visited.
  function cleanNotifPageTypeEntry() {
    try {
      const raw = sessionStorage.getItem('pathname-page-type-map');
      if (!raw) return;
      const map = JSON.parse(raw);
      if ('/notifications' in map) {
        delete map['/notifications'];
        sessionStorage.setItem('pathname-page-type-map', JSON.stringify(map));
      }
    } catch(e) {}
  }

  let panel = null, iframe = null, loadTimer = null, autoRefreshTimer = null;

  function injectIframeCSS() {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc || !doc.head) return;
      if (doc.__vmObs) { doc.__vmObs.disconnect(); doc.__vmObs = null; }
      const s = doc.createElement('style');
      s.textContent = IFRAME_CSS;
      doc.head.appendChild(s);
      let debounceTimer = null;
      let found = { title: false, padding: false };
      function cleanup() {
        if (doc.__vmObs) { doc.__vmObs.disconnect(); doc.__vmObs = null; }
        clearTimeout(debounceTimer);
      }
      function applyFixes() {
        if (!found.title) {
          for (const el of doc.querySelectorAll('h1, h2, h3')) {
            const noChildEls = !Array.from(el.childNodes).some(n => n.nodeType === 1);
            if (noChildEls && (el.textContent || '').trim() === 'Notifications') {
              el.style.setProperty('display', 'none', 'important');
              const p = el.parentElement;
              if (p) {
                p.style.setProperty('min-height', '0', 'important');
                p.style.setProperty('height',     '0', 'important');
                p.style.setProperty('overflow',   'hidden', 'important');
                p.style.setProperty('padding',    '0', 'important');
                p.style.setProperty('margin',     '0', 'important');
              }
              found.title = true;
              break;
            }
          }
        }
        if (!found.padding && doc.body) {
          const pt = parseInt(doc.defaultView.getComputedStyle(doc.body).paddingTop);
          if (pt > 0) {
            doc.body.style.setProperty('padding-top', '0', 'important');
            doc.body.style.setProperty('margin-top',  '0', 'important');
            found.padding = true;
          }
        }
        if (found.title && found.padding) cleanup();
      }
      doc.__vmObs = new doc.defaultView.MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(applyFixes, 50);
      });
      doc.__vmObs.observe(doc.documentElement, { childList: true, subtree: true });
      setTimeout(cleanup, 8000);
      applyFixes();
    } catch (_) {}
  }

  function guardIframeNavigation(f) {
    try {
      const win = f.contentWindow;
      const doc = f.contentDocument || win.document;

      // Watch for "Mark all as read" — clear badge immediately, don't wait for refresh
      const markAllBtn = doc.querySelector('mark-all-messages-read');
      if (markAllBtn) {
        markAllBtn.addEventListener('click', () => updateBadge(0));
      }

      // MutationObserver — recount whenever rpl-inbox-row attributes change
      // (covers new notifications arriving, items being marked read, etc.)
      const unreadObserver = new win.MutationObserver(() => {
        countUnreadFromIframe();
      });
      // Watch the notifications list for attribute changes on rows
      const notifList = doc.querySelector('notifications-main-manager, [role="list"], [role="main"]');
      if (notifList) {
        unreadObserver.observe(notifList, {
          subtree: true,
          attributes: true,
          attributeFilter: ['selected'],
          childList: true  // catch new rows being added
        });
      } else {
        // Fallback — watch the whole document
        unreadObserver.observe(doc.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['selected'],
          childList: false
        });
      }

      doc.addEventListener('click', e => {
        const a = e.target.closest('a[href]');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        const absolute = href.startsWith('http') ? href : 'https://www.reddit.com' + href;
        if (absolute.includes('/notifications')) return;
        e.preventDefault();
        const newTab    = GM_getValue('vm_notif_new_tab', true);
        const switchTab = newTab && GM_getValue('vm_notif_switch_tab', true);
        setTimeout(() => {
          if (newTab) {
            if (typeof GM_openInTab === 'function') {
              GM_openInTab(absolute, { active: switchTab, insert: true });
            } else {
              window.open(absolute, '_blank', 'noopener');
            }
          } else {
            window.location.href = absolute;
          }
          setTimeout(countUnreadFromIframe, 1000);
        }, 100);
      }, false);
      const origPush    = win.history.pushState.bind(win.history);
      const origReplace = win.history.replaceState.bind(win.history);
      win.history.pushState = function(state, title, url) {
        if (url && !String(url).includes('/notifications')) {
          const abs = url.startsWith('http') ? url : 'https://www.reddit.com' + url;
          const newTab    = GM_getValue('vm_notif_new_tab', true);
          const switchTab = newTab && GM_getValue('vm_notif_switch_tab', true);
          if (newTab) {
            if (typeof GM_openInTab === 'function') {
              GM_openInTab(abs, { active: switchTab, insert: true });
            } else {
              window.open(abs, '_blank', 'noopener');
            }
          } else {
            window.location.href = abs;
          }
          return;
        }
        origPush(state, title, url);
      };
      win.history.replaceState = function(state, title, url) {
        if (url && !String(url).includes('/notifications')) return;
        origReplace(state, title, url);
      };
      const navGuardInterval = setInterval(() => {
        if (!f.isConnected) { clearInterval(navGuardInterval); return; }
        try {
          const current = f.contentWindow.location.href;
          if (!current.includes('/notifications')) {
            clearInterval(navGuardInterval);
            buildIframe();
          }
        } catch(_) { clearInterval(navGuardInterval); }
      }, 500);
    } catch(_) {}
  }

  function buildIframe() {
    const reloadBtn = panel && panel.querySelector('.vm-btn.reload');
    if (reloadBtn) reloadBtn.disabled = true;
    clearTimeout(loadTimer);
    if (iframe) {
      try {
        const oldDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (oldDoc && oldDoc.__vmObs) { oldDoc.__vmObs.disconnect(); oldDoc.__vmObs = null; }
      } catch(_) {}
      iframe.remove();
      iframe = null;
    }
    const errorEl = panel.querySelector('.vm-error');
    if (errorEl) errorEl.classList.remove('visible');
    let loadingEl = panel.querySelector('.vm-loading');
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'vm-loading';
      loadingEl.innerHTML = '<div class="vm-spinner"></div><span>Loading notifications…</span>';
      panel.appendChild(loadingEl);
    }
    loadingEl.style.display = '';
    loadingEl.classList.remove('hidden');
    const f = document.createElement('iframe');
    f.className      = 'vm-iframe';
    f.src            = NOTIF_URL;
    f.referrerPolicy = 'same-origin';
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    f.addEventListener('load', () => {
      clearTimeout(loadTimer);
      try {
        const doc = f.contentDocument || f.contentWindow.document;
        if (doc && doc.head) {
          injectIframeCSS();
          f.classList.add('loaded');
          loadingEl.classList.add('hidden');
          if (reloadBtn) reloadBtn.disabled = false;
          guardIframeNavigation(f);
          countUnreadFromIframe();
          setTimeout(countUnreadFromIframe,  500);
          setTimeout(countUnreadFromIframe, 1000);
          setTimeout(countUnreadFromIframe, 1500);
          setTimeout(countUnreadFromIframe, 2000);
          cleanNotifPageTypeEntry();
          setTimeout(cleanNotifPageTypeEntry,  500);
          setTimeout(cleanNotifPageTypeEntry, 1500);
          setTimeout(cleanNotifPageTypeEntry, 3000);
        } else {
          showError('Reddit returned an unexpected page.');
        }
      } catch(e) {
        showError('Could not access notifications page.');
      }
    }, { once: true });
    loadTimer = setTimeout(() => {
      if (!f.classList.contains('loaded')) showError('Timed out — Reddit may be slow. Try again.');
    }, LOAD_TIMEOUT);
    panel.insertBefore(f, loadingEl);
    iframe = f;
  }

  function showError(msg) {
    clearTimeout(loadTimer);
    const errorEl  = panel && panel.querySelector('.vm-error');
    const loadingEl = panel && panel.querySelector('.vm-loading');
    const reloadBtn = panel && panel.querySelector('.vm-btn.reload');
    if (loadingEl) loadingEl.classList.add('hidden');
    if (errorEl) { errorEl.querySelector('span').textContent = msg; errorEl.classList.add('visible'); }
    if (reloadBtn) reloadBtn.disabled = false;
  }

  function countUnreadFromIframe() {
    if (!iframe || !panel) return;
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc) return;
      const win = iframe.contentWindow;
      // Known colors:
      // read not hovered:   rgb(14, 17, 19)
      // read hovered:       rgb(24, 28, 31)
      // unread not hovered: rgb(14, 17, 19) + selected attribute
      // unread hovered:     rgb(42, 50, 54)
      const READ_COLOR   = 'rgb(14, 17, 19)';
      const READ_HOVER   = 'rgb(24, 28, 31)';
      const UNREAD_HOVER = 'rgb(42, 50, 54)';
      let count = 0;
      doc.querySelectorAll('rpl-inbox-row').forEach(el => {
        const bg = win.getComputedStyle(el).backgroundColor;
        const isSelected = el.hasAttribute('selected');
        // Unread hovered — distinct color
        if (bg === UNREAD_HOVER) { count++; return; }
        // Read hovered — skip
        if (bg === READ_HOVER) return;
        // Not hovered — use selected attribute to distinguish unread from read
        if (isSelected) count++;
      });
      updateBadge(count);
    } catch(_) {}
  }

  function updateBadge(count) {
    if (!panel) return;
    const titleEl   = panel.querySelector('.vm-title');
    const titleText = panel.querySelector('.vm-title-text');
    if (!titleEl || !titleText) return;
    if (count > 0) {
      titleEl.classList.add('has-unread');
      titleText.textContent = 'New Notifications!';
      const bell = titleEl.querySelector('.vm-bell');
      if (bell) { bell.style.animation = 'none'; bell.offsetHeight; bell.style.animation = ''; }
    } else {
      titleEl.classList.remove('has-unread');
      titleText.textContent = 'Notifications';
    }
  }

  function startAutoRefresh(ms) {
    stopAutoRefresh();
    if (ms === undefined) ms = GM_getValue('vm_notif_refresh_ms', DEFAULT_REFRESH_MS);
    if (!ms) return;
    autoRefreshTimer = setInterval(() => {
      if (!document.hidden && panel && panel.isConnected) buildIframe();
    }, ms);
  }
  function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  }

  function getDockPark() {
    const saved = GM_getValue('vm_notif_saved_full', null);
    if (!saved) return null;
    if (typeof saved.x !== 'number' || typeof saved.y !== 'number' ||
        typeof saved.w !== 'number' || typeof saved.h !== 'number' ||
        isNaN(saved.x) || isNaN(saved.y) || isNaN(saved.w) || isNaN(saved.h)) return null;
    const vh = window.innerHeight;
    const dockBottom = Math.abs(saved.y + saved.h - vh) < SNAP_THRESHOLD;
    return { x: saved.x, y: dockBottom ? saved.y + saved.h - 32 : saved.y, w: saved.w, dockBottom };
  }

  function resetPanel() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w  = 350;
    const top = Math.round(vh * 0.25);
    const h   = vh - top - 1;
    const x   = vw - w - 1;
    const y   = top;
    saveState({ x, y, w, h });
    GM_setValue('vm_notif_saved_full', { x, y, w, h });
    if (panel) {
      if (panel.classList.contains('minimized')) {
        panel.classList.remove('minimized');
        sessionStorage.removeItem('vm_notif_minimized');
        const minBtn = panel.querySelector('.vm-btn.minimize');
        if (minBtn) { minBtn.textContent = '─'; minBtn.title = 'Minimize'; }
      }
      panel.style.left   = snapPx(x) + 'px';
      panel.style.top    = snapPx(y) + 'px';
      panel.style.width  = w + 'px';
      panel.style.height = h + 'px';
      snapState.right  = true;
      snapState.left   = false;
      snapState.bottom = true;
      snapState.top    = false;
    }
  }

  function openPanel() {
    document.querySelectorAll('#' + PANEL_ID).forEach(el => el.remove());
    panel = null;
    iframe = null;
    let s = loadState();
    if (GM_getValue(STORAGE_KEY, null) === null) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const w = 350, top = Math.round(vh * 0.25), h = vh - top - 1;
      s = { x: vw - w - 1, y: top, w, h };
      saveState(s);
      GM_setValue('vm_notif_saved_full', s);
    } else {
      const repositioned = repositionForViewport(s);
      if (repositioned !== s) {
        s = repositioned;
        saveState(s);
        const savedFull = GM_getValue('vm_notif_saved_full', null);
        if (savedFull) GM_setValue('vm_notif_saved_full', repositionForViewport(savedFull));
      }
    }
    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = `left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;`;
    panel.innerHTML = `
      <div class="vm-edge n"  data-dir="n"></div>
      <div class="vm-edge s"  data-dir="s"></div>
      <div class="vm-edge w"  data-dir="w"></div>
      <div class="vm-edge e"  data-dir="e"></div>
      <div class="vm-edge nw" data-dir="nw"></div>
      <div class="vm-edge ne" data-dir="ne"></div>
      <div class="vm-edge sw" data-dir="sw"></div>
      <div class="vm-edge se" data-dir="se"></div>
      <div class="vm-header">
        <div class="vm-title">
          <svg class="vm-bell" width="15" height="15" viewBox="0 0 24 24" style="flex-shrink:0;">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6V11c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
          </svg>
          <span class="vm-title-text">Notifications</span>
        </div>
        <div class="vm-controls">
          <button class="vm-btn close">✕</button>
          <button class="vm-btn minimize" title="Minimize">─</button>
          <div class="vm-split">
            <button class="vm-btn reload" title="Reload notifications"><span style="font-size:16px;line-height:1;margin-top:-4px;">⟳</span></button>
            <div class="vm-split-divider"></div>
            <div class="vm-refresh-wrap"><button class="vm-btn vm-refresh-btn" title="Auto-refresh interval">▼</button><div class="vm-refresh-dropdown"></div></div>
          </div>
          <div class="vm-settings-wrap">
            <button class="vm-btn vm-settings-btn" title="Settings">⚙︎</button>
            <div class="vm-settings-dropdown">
              <div class="vm-settings-row">
                <label for="vm-open-new-tab">Open links in a new tab</label>
                <input type="checkbox" id="vm-open-new-tab" class="vm-open-new-tab">
              </div>
              <div class="vm-settings-row nested" id="vm-switch-tab-row">
                <label for="vm-switch-tab">Switch to new tab?</label>
                <input type="checkbox" id="vm-switch-tab" class="vm-switch-tab">
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="vm-error"><span></span><button>Try Again</button></div>
    `;
    document.body.appendChild(panel);
    const vw = window.innerWidth, vh = window.innerHeight;
    snapState.left   = Math.abs(s.x) < SNAP_THRESHOLD;
    snapState.right  = Math.abs(s.x + s.w - vw) < SNAP_THRESHOLD;
    snapState.top    = Math.abs(s.y) < SNAP_THRESHOLD;
    snapState.bottom = Math.abs(s.y + s.h - vh) < SNAP_THRESHOLD;
    panel.querySelector('.vm-btn.close').addEventListener('click',  closePanel);
    panel.querySelector('.vm-btn.reload').addEventListener('click', reloadIframe);

    panel.querySelector('.vm-error button').addEventListener('click', reloadIframe);

    const minBtn = panel.querySelector('.vm-btn.minimize');
    const isMinimized = sessionStorage.getItem('vm_notif_minimized') === '1';
    if (isMinimized) { panel.classList.add('minimized'); minBtn.textContent = '□'; minBtn.title = 'Restore'; }
    minBtn.addEventListener('click', () => {
      if (!panel.classList.contains('minimized')) {
        // MINIMIZING
        minBtn.textContent = '□';
        minBtn.title = 'Restore';
        sessionStorage.setItem('vm_notif_minimized', '1');
        if (iframe) iframe.style.pointerEvents = '';
        const curY = parseFloat(panel.style.top);
        const curH = panel.offsetHeight;
        const bottomSnapped = snapState.bottom;
        panel.style.transition = bottomSnapped
          ? 'height .1s cubic-bezier(.4,0,.2,1), top .1s cubic-bezier(.4,0,.2,1)'
          : 'height .1s cubic-bezier(.4,0,.2,1)';
        panel.offsetHeight;
        requestAnimationFrame(() => {
          if (bottomSnapped) panel.style.top = snapPx(curY + curH - 32) + 'px';
          panel.style.height = '32px';
          setTimeout(() => {
            panel.style.transition = '';
            panel.classList.add('minimized');
            const dock = getDockPark();
            if (dock) {
              panel.style.left  = snapPx(dock.x) + 'px';
              panel.style.top   = snapPx(dock.y) + 'px';
              panel.style.width = dock.w + 'px';
              const vw2 = window.innerWidth, vh2 = window.innerHeight, bw2 = panel.offsetWidth;
              snapState.left   = Math.abs(dock.x) < SNAP_THRESHOLD;
              snapState.right  = Math.abs(dock.x + bw2 - vw2) < SNAP_THRESHOLD;
              snapState.top    = !dock.dockBottom && Math.abs(dock.y) < SNAP_THRESHOLD;
              snapState.bottom = dock.dockBottom;
            }
          }, 110);
        });
      } else {
        // RESTORING
        const s = loadState();
        const dock = getDockPark();
        const dockBottom = dock ? dock.dockBottom : false;
        minBtn.textContent = '─';
        minBtn.title = 'Minimize';
        sessionStorage.removeItem('vm_notif_minimized');
        if (iframe) iframe.style.pointerEvents = '';
        panel.style.left  = snapPx(s.x) + 'px';
        panel.style.width = s.w + 'px';
        panel.style.height = '32px';
        if (!dockBottom) panel.style.top = snapPx(s.y) + 'px';
        panel.classList.remove('minimized');
        panel.style.transition = dockBottom
          ? 'height .1s cubic-bezier(.4,0,.2,1), top .1s cubic-bezier(.4,0,.2,1)'
          : 'height .1s cubic-bezier(.4,0,.2,1)';
        panel.offsetHeight;
        requestAnimationFrame(() => {
          if (dockBottom) panel.style.top = snapPx(s.y) + 'px';
          panel.style.height = s.h + 'px';
          setTimeout(() => {
            panel.style.transition = '';
            const vw2 = window.innerWidth, vh2 = window.innerHeight;
            const rx = parseFloat(panel.style.left), ry = parseFloat(panel.style.top);
            const rw = panel.offsetWidth, rh = parseFloat(panel.style.height);
            snapState.right  = Math.abs(rx + rw - vw2) < SNAP_THRESHOLD;
            snapState.bottom = Math.abs(ry + rh - vh2) < SNAP_THRESHOLD;
          }, 110);
        });
      }
    });
    if (isMinimized) {
      requestAnimationFrame(() => {
        const dock = getDockPark();
        if (dock) {
          panel.style.left  = snapPx(dock.x) + 'px';
          panel.style.top   = snapPx(dock.y) + 'px';
          panel.style.width = dock.w + 'px';
          const vwL = window.innerWidth, vhL = window.innerHeight, bwL = panel.offsetWidth;
          snapState.left   = Math.abs(dock.x) < SNAP_THRESHOLD;
          snapState.right  = Math.abs(dock.x + bwL - vwL) < SNAP_THRESHOLD;
          snapState.top    = !dock.dockBottom && Math.abs(dock.y) < SNAP_THRESHOLD;
          snapState.bottom = dock.dockBottom;
        }
      });
    }

    const settingsBtn      = panel.querySelector('.vm-settings-btn');
    const settingsDropdown = panel.querySelector('.vm-settings-dropdown');
    settingsBtn.addEventListener('click', e => {
      e.stopPropagation();
      const opening = !settingsDropdown.classList.contains('open');
      settingsDropdown.classList.toggle('open');
      if (opening) {
        const rect = settingsBtn.getBoundingClientRect();
        settingsDropdown.style.top  = rect.bottom + 'px';
        settingsDropdown.style.left = rect.left + 'px';
        const dw = settingsDropdown.offsetWidth;
        const dh = settingsDropdown.offsetHeight;
        if (rect.bottom + dh > window.innerHeight) {
          settingsDropdown.style.top = (rect.top - dh) + 'px';
        }
        if (rect.left + dw > window.innerWidth) {
          settingsDropdown.style.left = (window.innerWidth - dw) + 'px';
        }
        const { bg2, text, muted, border } = getThemeColors();
        settingsDropdown.style.background  = bg2;
        settingsDropdown.style.color       = text;
        settingsDropdown.style.borderColor = border;
        settingsDropdown.querySelectorAll('label').forEach(l => l.style.color = muted);
      }
    });
    document.addEventListener('click', function closeSettings(e) {
      if (!settingsDropdown.contains(e.target)) settingsDropdown.classList.remove('open');
    });
    settingsDropdown.addEventListener('click', e => e.stopPropagation());

    const newTabChk    = panel.querySelector('.vm-open-new-tab');
    const switchTabChk = panel.querySelector('.vm-switch-tab');
    const switchTabRow = panel.querySelector('#vm-switch-tab-row');
    function applyTabState() { switchTabRow.classList.toggle('disabled', !newTabChk.checked); }
    newTabChk.checked    = GM_getValue('vm_notif_new_tab', true);
    switchTabChk.checked = GM_getValue('vm_notif_switch_tab', true);
    applyTabState();
    newTabChk.addEventListener('change', () => { GM_setValue('vm_notif_new_tab', newTabChk.checked); applyTabState(); });
    switchTabChk.addEventListener('change', () => { GM_setValue('vm_notif_switch_tab', switchTabChk.checked); });

    const refreshBtn      = panel.querySelector('.vm-refresh-btn');
    const refreshDropdown = panel.querySelector('.vm-refresh-dropdown');
    let currentRefreshMs  = GM_getValue('vm_notif_refresh_ms', DEFAULT_REFRESH_MS);
    let customRefreshMs   = null;

    function msLabel(ms) {
      const secs = ms / 1000;
      if (secs < 60) return `${secs}s`;
      const mins = secs / 60;
      if (mins === Math.floor(mins)) return `${mins} min`;
      return `${Math.floor(mins)} min ${secs % 60}s`;
    }

    function buildRefreshDropdown() {
      refreshDropdown.innerHTML = '';
      const options = [...REFRESH_OPTIONS];
      if (customRefreshMs !== null) {
        options.splice(options.length - 1, 0, { label: msLabel(customRefreshMs), ms: customRefreshMs, custom: true });
      }
      options.forEach(opt => {
        const item = document.createElement('button');
        item.className = 'vm-refresh-item' + (opt.ms === currentRefreshMs ? ' selected' : '');
        item.textContent = opt.label;
        item.addEventListener('click', () => {
          if (opt.ms === -1) {
            refreshDropdown.innerHTML = '';
            const row = document.createElement('div');
            row.className = 'vm-refresh-custom-row';
            const inp = document.createElement('input');
            inp.type = 'number'; inp.min = '0'; inp.placeholder = 'sec'; inp.value = '60';
            inp.className = 'vm-refresh-custom-input';
            const confirmBtn = document.createElement('button');
            confirmBtn.textContent = '✓'; confirmBtn.className = 'vm-refresh-custom-confirm';
            const sLabel = document.createElement('span');
            sLabel.textContent = 's';
            sLabel.style.fontSize = '12px';
            row.appendChild(inp); row.appendChild(sLabel); row.appendChild(confirmBtn);
            refreshDropdown.appendChild(row);
            // Apply theme colors inline
            const { bg2, text, muted, border } = getThemeColors();
            inp.style.borderColor = border;
            inp.style.background  = bg2;
            inp.style.color       = text;
            sLabel.style.color    = muted;
            // Reposition now that content has changed size
            const pr = panel.getBoundingClientRect();
            const rr = refreshBtn.getBoundingClientRect();
            const dw = refreshDropdown.offsetWidth, dh = refreshDropdown.offsetHeight;
            let dtop  = rr.bottom, dleft = rr.left;
            if (dtop  + dh > pr.bottom) dtop  = rr.top - dh;
            if (dleft + dw > pr.right)  dleft = pr.right - dw;
            if (dleft < pr.left)        dleft = pr.left;
            refreshDropdown.style.top  = dtop  + 'px';
            refreshDropdown.style.left = dleft + 'px';
            inp.addEventListener('focus', () => { inp.style.boxShadow = `0 0 0 2px ${muted}`; });
            inp.addEventListener('blur',  () => { inp.style.boxShadow = ''; });
            requestAnimationFrame(() => { inp.focus(); inp.select(); });
            function applyCustom() {
              const secs = parseInt(inp.value);
              if (isNaN(secs) || secs < 0) return;
              customRefreshMs = secs * 1000;
              currentRefreshMs = customRefreshMs;
              GM_setValue('vm_notif_refresh_ms', currentRefreshMs);
              startAutoRefresh(currentRefreshMs);
              refreshDropdown.classList.remove('open');
              buildRefreshDropdown();
            }
            confirmBtn.addEventListener('click', applyCustom);
            inp.addEventListener('keydown', e => {
              if (e.key === 'Enter') applyCustom();
              if (e.key === 'Escape') { refreshDropdown.classList.remove('open'); buildRefreshDropdown(); }
            });
            return;
          } else {
            currentRefreshMs = opt.ms;
          }
          GM_setValue('vm_notif_refresh_ms', currentRefreshMs);
          startAutoRefresh(currentRefreshMs);
          refreshDropdown.classList.remove('open');
          buildRefreshDropdown();
        });
        refreshDropdown.appendChild(item);
      });
    }

    // Restore custom option if saved value is non-standard
    (function() {
      const saved = GM_getValue('vm_notif_refresh_ms', DEFAULT_REFRESH_MS);
      const isStandard = REFRESH_OPTIONS.some(o => o.ms === saved);
      if (!isStandard && saved >= 0) customRefreshMs = saved;
    })();
    buildRefreshDropdown();

    refreshBtn.addEventListener('click', e => {
      e.stopPropagation();
      const opening = !refreshDropdown.classList.contains('open');
      if (!opening) { refreshDropdown.classList.remove('open'); return; }
      buildRefreshDropdown();
      refreshDropdown.classList.add('open');
      const pr   = panel.getBoundingClientRect();
      const rect = refreshBtn.getBoundingClientRect();
      let dtop  = rect.bottom, dleft = rect.left;
      const dw = refreshDropdown.offsetWidth, dh = refreshDropdown.offsetHeight;
      if (dtop  + dh > pr.bottom) dtop  = rect.top - dh;
      if (dleft + dw > pr.right)  dleft = pr.right - dw;
      if (dleft < pr.left)        dleft = pr.left;
      if (dtop  < pr.top)         dtop  = pr.top;
      refreshDropdown.style.top  = dtop  + 'px';
      refreshDropdown.style.left = dleft + 'px';
      const { bg2, text, muted, border } = getThemeColors();
      refreshDropdown.style.background  = bg2;
      refreshDropdown.style.borderColor = border;
      refreshDropdown.querySelectorAll('.vm-refresh-item').forEach(i => i.style.color = i.classList.contains('selected') ? text : muted);
    });
    document.addEventListener('click', e => {
      if (!refreshDropdown.contains(e.target)) {
        refreshDropdown.classList.remove('open');
        buildRefreshDropdown();
      }
    });
    refreshDropdown.addEventListener('click', e => e.stopPropagation());

    makeDraggable(panel, panel.querySelector('.vm-header'));
    makeResizable(panel);
    buildIframe();
    startAutoRefresh();
    syncTheme();
    sessionStorage.setItem('vm_notif_open', '1');
  }

  function closePanel() {
    stopAutoRefresh();
    clearTimeout(loadTimer);
    if (panel) { panel.remove(); panel = null; iframe = null; }
    sessionStorage.removeItem('vm_notif_open');
  }

  function reloadIframe() {
    if (!panel) return;
    buildIframe();
  }

  const SNAP_THRESHOLD = 7;
  const snapState = { left: false, right: false, top: false, bottom: false };

  function applyMagneticSnap(x, y, w, h) {
    const vw = window.innerWidth, vh = window.innerHeight;
    snapState.left = snapState.right = snapState.top = snapState.bottom = false;
    if (Math.abs(x) < SNAP_THRESHOLD)           { x = 0;          snapState.left   = true; }
    if (Math.abs(x + w - vw) < SNAP_THRESHOLD)  { x = vw - w + 1; snapState.right  = true; }
    if (Math.abs(y) < SNAP_THRESHOLD)            { y = 0;          snapState.top    = true; }
    if (Math.abs(y + h - vh) < SNAP_THRESHOLD)  { y = vh - h + 1; snapState.bottom = true; }
    return { x, y };
  }

  function onWindowResize() {
    if (!panel || !panel.isConnected) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const isMin = panel.classList.contains('minimized');
    let x = parseInt(panel.style.left), y = parseInt(panel.style.top);
    let w = panel.offsetWidth, h = isMin ? 32 : panel.offsetHeight;
    panel.style.transition = 'none';
    if (w > vw) { w = vw; panel.style.width = w + 'px'; }
    if (!isMin && h > vh) { h = vh; panel.style.height = h + 'px'; }
    if (snapState.right)  x = vw - w + 1;
    if (snapState.left)   x = 0;
    if (snapState.bottom) y = vh - h + 1;
    if (snapState.top)    y = 0;
    panel.style.left = snapPx(x) + 'px';
    panel.style.top  = snapPx(y) + 'px';
    if (isMin) {
      const s = loadState();
      const fullY = snapState.bottom ? y - (s.h - 32) : y;
      const newSaved = { x, y: fullY, w, h: s.h };
      GM_setValue('vm_notif_saved_full', newSaved);
      saveState(newSaved);
    } else {
      const nx = parseInt(panel.style.left), ny = parseInt(panel.style.top);
      saveState({ x: nx, y: ny, w, h });
      if (snapState.bottom || snapState.right) {
        GM_setValue('vm_notif_saved_full', { x: nx, y: ny, w, h });
      }
    }
    requestAnimationFrame(() => { if (panel) panel.style.transition = ''; });
  }

  window.addEventListener('resize', onWindowResize);

  function makeDraggable(el, handle) {
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('button, input, a')) return;
      e.preventDefault();
      iframe && (iframe.style.pointerEvents = 'none');
      el.style.transition = 'none';
      const ox = e.clientX - el.getBoundingClientRect().left;
      const oy = e.clientY - el.getBoundingClientRect().top;
      function onMove(e) {
        const s = applyMagneticSnap(e.clientX - ox, e.clientY - oy, el.offsetWidth, el.offsetHeight);
        el.style.left = snapPx(s.x) + 'px'; el.style.top = snapPx(s.y) + 'px';
      }
      function onUp() {
        iframe && (iframe.style.pointerEvents = '');
        el.style.transition = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        if (el.classList.contains('minimized')) {
          const barX = parseInt(el.style.left), barY = parseInt(el.style.top);
          const barW = parseFloat(el.style.width), h = loadState().h;
          const dockBottom = Math.abs(barY + 32 - window.innerHeight) < SNAP_THRESHOLD;
          GM_setValue('vm_notif_saved_full', { x: barX, y: dockBottom ? barY - (h - 32) : barY, w: barW, h });
        } else {
          saveState({ ...loadState(), x: parseInt(el.style.left), y: parseInt(el.style.top) });
        }
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  function makeResizable(el) {
    el.querySelectorAll('.vm-edge').forEach(handle => {
      handle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        iframe && (iframe.style.pointerEvents = 'none');
        el.style.transition = 'none';
        const dir = handle.dataset.dir;
        const wasMinimized = el.classList.contains('minimized');
        const startX = e.clientX, startY = e.clientY;
        const startL = el.offsetLeft, startT = el.offsetTop;
        const startW = parseFloat(el.style.width), startH = parseFloat(el.style.height);
        let unminimized = false;
        function onMove(e) {
          const dx = e.clientX - startX, dy = e.clientY - startY;
          let newL = startL, newT = startT, newW = startW, newH = startH;
          if (dir.includes('e')) newW = Math.max(MIN_W, startW + dx);
          if (dir.includes('s')) newH = Math.max(MIN_H, startH + dy);
          if (dir.includes('w')) { newW = Math.max(MIN_W, startW - dx); newL = startL + (startW - newW); }
          if (dir.includes('n')) { newH = Math.max(MIN_H, startH - dy); newT = startT + (startH - newH); }
          // Un-minimize when dragging south down or north up from minimized state
          if (wasMinimized && !unminimized &&
              ((dir.includes('s') && dy > 0) || (dir.includes('n') && dy < 0))) {
            el.classList.remove('minimized');
            sessionStorage.removeItem('vm_notif_minimized');
            const minBtn = el.querySelector('.vm-btn.minimize');
            if (minBtn) { minBtn.textContent = '─'; minBtn.title = 'Minimize'; }
            unminimized = true;
          }
          el.style.left = snapPx(newL) + 'px'; el.style.top  = snapPx(newT) + 'px';
          el.style.width = newW + 'px'; el.style.height = newH + 'px';
        }
        function onUp() {
          iframe && (iframe.style.pointerEvents = '');
          el.style.transition = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup',   onUp);
          // Re-minimize if height collapsed back to minimum
          if (!el.classList.contains('minimized') && parseFloat(el.style.height) <= MIN_H) {
            el.classList.add('minimized');
            sessionStorage.setItem('vm_notif_minimized', '1');
            const minBtn = el.querySelector('.vm-btn.minimize');
            if (minBtn) { minBtn.textContent = '□'; minBtn.title = 'Restore'; }
          }
          if (el.classList.contains('minimized')) {
            const barX = parseInt(el.style.left), barY = parseInt(el.style.top);
            const barW = parseFloat(el.style.width), h = loadState().h;
            const dockBottom = Math.abs(barY + 32 - window.innerHeight) < SNAP_THRESHOLD;
            GM_setValue('vm_notif_saved_full', { x: barX, y: dockBottom ? barY - (h - 32) : barY, w: barW, h });
          } else {
            saveState({ x: parseInt(el.style.left), y: parseInt(el.style.top), w: parseFloat(el.style.width), h: el.offsetHeight });
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
      });
    });
  }

  const BELL_SELECTORS = [
    '#notifications-inbox-button',
    'shreddit-notifications',
    '[slot="notifications"]',
    'a[href="/notifications/"]',
    '[aria-label="Notifications"]',
    '[aria-label="notifications"]',
    'button[aria-label*="notif" i]',
    '[data-click-id="notifications"]',
    '#header-bottom-right a[href*="message/inbox"]',
  ];

  function isBellOrChild(target) {
    let el = target;
    while (el && el !== document.body) {
      for (const sel of BELL_SELECTORS) {
        try { if (el.matches && el.matches(sel)) return true; } catch (_) {}
      }
      const label = ((el.getAttribute && (
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid') || ''
      )) || '').toLowerCase();
      if (label.includes('notif') || label.includes('inbox')) return true;
      el = el.parentElement;
    }
    return false;
  }

  function bindBell(el) {
    if (el.__vmBound) return;
    el.__vmBound = true;
    el.addEventListener('click', e => { e.preventDefault(); e.stopImmediatePropagation(); showContextMenu(e); }, true);
    el.addEventListener('contextmenu', e => { e.preventDefault(); e.stopImmediatePropagation(); showContextMenu(e); }, true);
  }

  function tryBindBell() {
    const el = document.querySelector('#notifications-inbox-button');
    if (el) { bindBell(el); return true; }
    return false;
  }

  if (!tryBindBell()) {
    const obs = new MutationObserver(() => { if (tryBindBell()) obs.disconnect(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 30000);
  }

  document.addEventListener('contextmenu', e => {
    if (panel && panel.contains(e.target)) return;
    const bell = document.querySelector('#notifications-inbox-button');
    if (bell && !bell.__vmBound) bindBell(bell);
    if (!isBellOrChild(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation(); showContextMenu(e);
  }, true);

  document.addEventListener('click', e => {
    if (panel && panel.contains(e.target)) return;
    const bell = document.querySelector('#notifications-inbox-button');
    if (bell && !bell.__vmBound) bindBell(bell);
    if (!isBellOrChild(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation(); showContextMenu(e);
  }, true);

  if (sessionStorage.getItem('vm_notif_open') === '1') openPanel();

})();