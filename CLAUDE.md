# Reddit Notifications Floating Panel — project notes

## Dark Reader blanks Reddit (black screen) — not NoScript/uBlock

**Symptom:** `www.reddit.com` paints normally for a moment, then the whole viewport goes flat
dark (`rgb(24, 26, 27)` — Dark Reader's default background). No JS errors, no blocked requests.

**Cause:** Dark Reader injects its three override `<style>` elements by calling
`attachShadow()` on `shreddit-app`. Reddit's `shreddit-app` renders its entire page from
**light DOM** and its shadow root contains **no `<slot>`**, so attaching one detaches the whole
page from rendering. `shreddit-app` collapses to 56px (just its `pt-[var(--page-y-padding)]`)
and `<body>` follows.

**How to recognize it fast** (run in the console on the black page):

```js
document.querySelector('shreddit-app').shadowRoot?.children.length   // 3 = Dark Reader
```

Also diagnostic: `getComputedStyle(document.querySelector('reddit-header-large')).display`
returns `""` and `.length` is ~475 instead of ~2000 — Chrome's signature for an element that
is **not rendered** because it is an unslotted light-DOM child of a shadow host.

**Live proof / temporary unblank** (survives until reload):

```js
document.querySelector('shreddit-app').shadowRoot.appendChild(document.createElement('slot'))
```

**Real fix:** disable Dark Reader for reddit.com (Dark Reader popup → toggle off for this site),
or use Reddit's own dark theme.

**Don't chase these — all ruled out 2026-09-02:**
- NoScript / uBlock: `redditstatic.com` scripts (6) and `styles-css-*.css` all loaded fine.
- Custom elements: only 17 `:not(:defined)`, all lazy/ad/player elements. `customElements` fine.
- This userscript: the panel is a 440x620 fixed element built only on right-clicking the bell.
  It cannot blank the page, and it is not loaded when the blanking happens.
