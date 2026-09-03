# Reddit Notifications Floating Panel — project notes

## How v6 works (rewrite of 2026-09-02) — no iframe

The panel fetches the same server-rendered partial Reddit's own inbox page uses and renders
its own list. Everything below was verified live in Chrome on 2026-09-02.

| Purpose | Request |
|---|---|
| Notification list | `GET /svc/shreddit/notifications-inbox-content/20/route?render-mode=partial` → ~13 KB of `<notification-item>` elements. Without `render-mode=partial` the same route returns the whole 340 KB `<shreddit-app>` render. |
| Mark one read | `POST /svc/shreddit/graphql` `{"operation":"MarkNotificationRead","variables":{"input":{"notificationId","groupType","groupContentId"}},"csrf_token"}` → `data.readNotificationLoggedIn.ok` |
| Mark all read | same endpoint, `{"operation":"MarkInboxAsRead","variables":{"input":{"types":["NOTIFICATIONS"]}}}` → `data.markInboxAsRead.ok` |
| Messages | `MarkPrivateMessageAsRead` `{"input":{"messageId"}}` exists too (Reddit picks it for message types); not used yet |

- `csrf_token` is a plain cookie on `.reddit.com` (readable from `document.cookie` on both
  `www` and `old`), so the GraphQL calls need no other auth.
- **Unread = `rpl-inbox-row[selected]`.** `notification-item[is-viewed]` is "seen" (badge
  cleared by visiting the page), *not* read — both test items had it while still unread.
- Per item: `notification-item` carries `notification-id`, `message-type` (`COMMENT_REPLY`,
  `POST_REPLY`, …), `group-type`, `group-content-id`. Inside `rpl-inbox-row`: leaf `<span>`s
  under the `<a>` are title then body snippet; `faceplate-timeago > time[datetime]`; `<img>`
  is the avatar.
- Bell: `a#notifications-inbox-button` on www (loaded lazily by the
  `/svc/shreddit/header-action-item-inbox` partial — bind by delegation, never once at boot);
  `a#notifications` on old.reddit. Bell badge markup with unread-unseen items is **not yet
  observed** — check it when a fresh notification exists.
- GraphQL op names live in the redditstatic bundles; grep for `MarkNotificationRead` etc.
  Others seen: `NotificationInboxFeed`, `InboxBadgeIndicator`, `UpdateInboxActivitySeenState`,
  `DeleteInboxNotifications`.

## Unread styling — deliberate, don't "fix" it back to orange

Asked for by the user 2026-09-02. **Rows carry no accent color at all.** Unread is signalled
by contrast, not hue: an unread row sits at full strength (title `--text`, weight 700, avatar
and body at opacity 1) and a read row recedes (title `--muted`, weight 600, avatar `.5`,
body/meta `.65`). Hovering any row restores full opacity. There is no orange row tint and no
unread dot — both were removed in v6.1.0.

The **header** mirrors Reddit's own top-bar inbox button (v6.2.0, asked for 2026-09-02): the
title is always "Notifications"; on unread it goes brighter and larger (`--text`, 14px, from
`--muted`, 13px), the bell goes `--muted` → `--text`, and **only the badge carries colour**.
The bell is Reddit's 20×20 `icon-name="notifications"` path verbatim; the badge is a copy of
its `<dynamic-badge appearance="ALERT">` measured live: 16px pill, `#d93900`
(`--color-brand-background`), 10px/16px weight 600, `0 4px` padding, anchored **14px in and
6px up** from the icon's top-left so it overlaps the bell's top-right corner. Header controls
are deliberately tight (2px gap, 22px buttons, 14px chevron) so "Notifications" at 14px still
fits in the 286px sidebar-following width — widen anything there and it truncates again.

## Geometry: four anchored edges (v6.2.0 → rewritten in v6.4.0)

The panel's placement is stored as **four edge offsets**, not a rectangle:

| Edge | Anchored to | Reset value |
|---|---|---|
| left | the right sidebar's left edge | +20 |
| top | the **window's** top | sidebar's unscrolled top + 20 |
| right | the window's right | 0 (flush) |
| bottom | the window's bottom | 0 (flush) |

Only the left edge tracks the page, and that is the whole point: it keeps the panel off the
post column as the window widens without letting anything vertical about the page move it.
**Dragging or resizing the panel rewrites the offsets and it keeps tracking** — there is no
"stopped following" state any more (the `follow` flag died with v6.3.0; `openPanel` migrates
an old `follow: false` save into equivalent offsets). Resizing the window therefore always
moves the same edges: shrink it vertically and the panel shrinks from the bottom with its top
gap intact; shrink it horizontally and both side edges come in.

**Why the top is window-relative, not sidebar-relative** (user's call, 2026-09-02): Reddit's
sidebar is `position: sticky`, so its top climbs from 192 to 56 as you scroll. Anchoring to it
meant a reload that landed mid-page opened a panel ~136px taller than intended. Two consequences
to keep: navigating between pages whose sidebars start at different heights no longer nudges
the panel, and a reset is the only thing that re-reads the sidebar's top.

**Reading that top is not obvious.** Both `rect.top` *and* `offsetTop` shrink as a sticky
element sticks — measured 2026-09-02: at scrollY 600, `rect.top` 56 and `offsetTop` 656, i.e.
`offsetTop === rect.top + scrollY` in both stuck and unstuck states, so neither is usable.
`sidebarTopUnscrolled()` instead walks up to the nearest **non-sticky** ancestor
(`.main-container`, static, no padding) and takes its document top: 192 on a subreddit and 56
on home, stable at any scroll offset.

Selectors (verified live 2026-09-02): www uses `#right-sidebar-container` (sticky,
316px wide, includes a 10px scrollbar gutter) for the top edge and `#right-sidebar-contents`
(306px, the visible card) for the left one. old.reddit uses `.side` (300px, static) for both.
Reddit's right rail is a lazy `faceplate-partial`, so `applyAnchor` is retried at 0.8s and
2.5s after open / navigation instead of observing for it. When Reddit hides the sidebar
(below its `s` breakpoint the container is `display:none`, its rect collapsing to 0×0) the
anchor cannot resolve: the panel keeps its size and merely stays docked in view via
`adaptGeometry`, and a drag/resize made in that state keeps the old left offset, so it snaps
back to the sidebar-relative column when the sidebar returns.

**Verified live 2026-09-02 (v6.4.0, r/test, real window resizes):** reset gives left inset 20 /
top 212; scrolling 900px then firing a resize changes nothing; re-injecting while scrolled
(reload simulation) still gives top 212; shortening the window 617→457 kept top 212 and shrank
the height 405→245 with the bottom flush; dragging the top edge and then the left edge rewrote
the offsets to `top: 319`, `left: -80` and a further window resize preserved both; reset while
still scrolled 908px restored 20 / 212.

**Verified with the installed v6.0.0 (2026-09-02):** unread detection and badge, per-item
mark read (server confirmed via re-fetch of the partial), Mark all as read issued from
old.reddit through `GM_xmlhttpRequest` (server confirmed on www, Reddit's own bell badge
cleared), old.reddit bell menu + RES night-mode theme detection.

**Not yet verified:** "Load more" (needs >20 notifications; the code looks for a nested
`faceplate-partial` whose `src` contains `notification`).

## Tab title indicator (v6.5.0)

Asked for 2026-09-02: flash the tab twice when a notification arrives, then leave the count at
the front of the title, the way YouTube and Discord do. **No `@grant` and no permission prompt
are involved** — the tab title is plain DOM. (The alternatives, for reference: `GM_notification`
for an OS toast, which does need a grant; the Web Notifications API, which needs a per-origin
permission the user must accept; and repainting the favicon, which is how those sites do the
icon half of the effect.)

- Badge is `(n) ` prefixed to Reddit's own title. Flash = the whole title blinks between
  `New notification` / `n new notifications` and the badged title, twice, 800ms a frame,
  because a tab only shows a dozen or so characters and a change confined to the tail of the
  string is invisible.
- **Reddit rewrites the title on every SPA navigation**, so `watchTitle()` observes `<head>`
  (not `<title>` — the element can be replaced wholesale, not just its text node) and
  re-applies the badge. `titleWritten` holds the exact string we last set so our own writes
  are told apart from Reddit's; anything else becomes the new base title, stripped of any
  leftover `(n) `.
- **Never flashes for a count that was already there.** `updateBadge` only touches the title
  once `lastLoadedAt` is set (`renderList()` also runs with an empty list before the first
  fetch), and `titleSeeded` suppresses the flash on the first loaded count. `closePanel`
  clears both the badge and the seed, so reopening does not flash either.
- Two nested settings, both on by default: `titleCount` ("Show the count in the tab title")
  and `titleFlash` ("Flash the tab when they arrive"), the latter greying out when the former
  is off — the same pattern as the new-tab pair.
- **Limitation, by design:** the badge only tracks while the panel is open, because that is
  the only time the script polls the inbox. Closing the panel restores the plain title. Making
  it work with the panel closed means a background poller, which is a deliberately bigger change.

**Verified live 2026-09-02** on www with the inbox partial stubbed so the first load reported
0 unread and the next reported the real count (no writes to the account): title sequence came
back as `Testing` → `New notification` → `(1) Testing` → `New notification` → `(1) Testing`;
an external `document.title` write and a real SPA navigation to the home page were both
re-badged; dropping to 0 unread, toggling `titleCount` off, and closing the panel each restored
the plain title.

## Why v5 broke (post-mortem, all confirmed live 2026-09-02)

1. **Every click on `/notifications/` was hijacked.** v5's document-level capture handler
   treated any target with an ancestor whose `aria-label`/`title`/`data-testid` contained
   `notif` or `inbox` as the bell. Reddit's page wrapper is `data-testid="notifications-page"`,
   so "Mark all as read", every notification row, everything got `preventDefault` +
   `stopImmediatePropagation` and the bell menu popped instead. That was the "mark read
   doesn't work" bug. Lesson: match the bell **by id via `composedPath()`**, never by fuzzy
   label text.
2. **Blank list in the iframe.** v5 hid the "Notifications" `<h1>` and set its *parent* to
   `height:0; overflow:hidden`. That parent is now the whole content column.
3. **Under the scrollbar.** Snap/clamp used `window.innerWidth/innerHeight` (include
   scrollbars) and then added `+1`. Use `document.documentElement.clientWidth/clientHeight`.

## Testing a build in the live page without installing it

Reddit's CSP blocks `fetch()` to localhost, but the Claude-in-Chrome `javascript_tool` can
`eval`. Channel: `powershell Get-Content -Raw -Encoding UTF8 <file> | Set-Clipboard`, then in
the page create a `<textarea>`, focus it, `computer key ctrl+v`, read `.value`, `(0,eval)(code)`.
Shim `GM_getValue/GM_setValue` (localStorage) and `GM_openInTab` (record into an array) first and
set `sessionStorage['rnfp.open']='1'` so the panel auto-opens. Test on the **home page**, not
`/notifications/`, while the old v5 is still installed (it hijacks clicks there), and close the
v5 panel first. **Also remove the installed build's `<style>`** (every `style` whose text
contains `rnfp-ring`) along with `#rnfp-panel`/`#rnfp-loaded` before eval — otherwise its
rules cascade onto the test build and you debug styling that isn't yours (cost 2026-09-02:
an "orange bell" that was v6.1's stylesheet). The pasted `<textarea>` must be **clicked**
with the `computer` tool before `ctrl+v`; `.focus()` from JS is not enough. The installed
build's `window`-capture bell handler runs first and swallows the right-click, so drive the
test build via its own gear menu, not the bell context menu. The tool's output filter blocks any result containing URL query strings or
cookie-looking values — dump tag/attribute *names* and counts, never `outerHTML`/`href`.

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

## Checkbox blue is shared across the whole Monkey Scripts folder (v6.6.0)

Settings checkmarks are `--check: #89b4fa` — **not** `--accent`. `--accent` stays Reddit orange
`#ff4500` and still owns the spinner, the selected menu item, "Load more" and the context-menu
hover; repointing it would turn all of those blue too, which is why the checkbox got its own
variable. `#89b4fa` is the Catppuccin Mocha blue that Forget-Me-Not, Sudokupad Tools and
Forum-Stumbler all use for their checkboxes — see the parent folder's `CLAUDE.md`.

## Start-open rules and per-page memory (v6.7.0, replaces v6.6.0's two booleans)

The four behaviours the user asked for are **two independent questions**, which is why the menu
is a radio group plus one checkbox rather than a list of toggles:

| Setting | Values | Default |
|---|---|---|
| `startOpen` | `'never'` / `'listings'` / `'all'` — what an *untouched* page does on arrival | `'listings'` |
| `rememberPages` | manual opens/closes are recorded per page and **override** `startOpen` | on |

Mode 1 (remembers per page) is `never` + remember; mode 4 (always closed) is `never` + no
remember. The two useful hybrids fall out for free. `v6.6`'s `autoOpenSub`/`autoOpenAll` are
migrated once at load and deleted.

**`arrivalState()` returns `true` / `false` / `null`, and the `null` is the point.** A remembered
page answers both ways, because closing the panel somewhere is as explicit an instruction as
opening it. The `startOpen` rule only ever answers `true` — it decides where the panel appears by
itself and never force-closes one you are reading, which is also what "Start with the panel
open…" promises. So the rule opens, memory opens *and* closes, and anything else leaves the panel
alone.

**Only `openPanelByUser`/`closePanelByUser` write memory.** The close button and the bell menu go
through those; `applyArrivalState` calls bare `openPanel`/`closePanel`, so applying the rule can
never overwrite what the user decided. Getting this backwards makes every auto-open permanently
"remembered" on first sight.

## The SPA watcher is what makes any of it true (v6.7.0)

Reddit does not re-run the script on in-page navigation, so `onNavigated` (already present for
the sidebar anchor) now also calls `applyArrivalState` when `pageKey()` actually changes. Without
it every wording in the settings is a lie the moment you click a link instead of typing a URL —
mode 4's panel would persist through clicks, mode 2 would not open on a listing you clicked to,
and per-page memory would never fire at all. The `lastPath` guard matters: `navigatesuccess` also
fires for same-page state pushes.

## Per-page memory storage (v6.7.0)

One GM value, `rnfp.pages`, holding `{ "<path>": { o: 1|0, t: <ms of last visit> } }`.

- **A page is the lowercased `pathname`, no trailing slash, query and hash dropped.** So
  `/r/pics`, `/r/pics/`, `/r/pics/?f=x` and `/r/pics#foo` are one page, and old.reddit shares
  state with www.
- **Entries are created only by a manual open/close, never by visiting.** This is what keeps the
  budget meaningful — otherwise the slots fill with pages the panel was never touched on.
  `touchPage()` bumps an *existing* entry's recency and creates nothing.
- **Eviction is a year of inactivity; the 5,000 cap is a backstop.** Because entries need a
  deliberate open/close, a heavy user creates a handful a week, so a year lands in the hundreds
  and the cap never binds. Measured: 5,000 entries with long comment-page paths is 477 KB of
  JSON, which is fine to hold but is rewritten whole on every save — hence the next point.
- **Recency bumps are flushed lazily** (`pagehide` + `visibilitychange`), because they happen on
  every navigation. A manual open/close writes through immediately: that is the user making a
  decision, and losing it to a killed tab is the one failure they would notice.

## Settings menu: tooltips on every row (v6.7.0)

Every row carries a `title` explaining what it does, including the "Reset panel position & size"
button and the radio group's heading. `checkRow(label, key, nested, tip, onChange)` — note `tip`
sits **before** `onChange`; the v6.6 signature had four arguments and callers passed the callback
fourth.

## `rnfp.open` and `rnfp.dismissed` are gone (v6.7.0)

`rnfp.open` (sessionStorage) used to reopen the panel on any reload *regardless of every
setting*, which directly contradicted "always starts closed" — F5 brought it back. Per-page
memory replaces it properly and durably. `ensureAttached` no longer consults it (`panel &&
!panel.isConnected` is the whole condition; `closePanel` nulls `panel`). `rnfp.dismissed` was
a v6.6 stopgap for tab-wide dismissal and is redundant now that closing writes a per-page record.
**`rnfp.minimized` stays per-tab** — minimized is a third axis and folding it into the page
record doubles the states to reason about.

Consequence worth knowing: with `rememberPages` off, manually opening the panel on a page that
`startOpen` does not cover no longer survives a reload. That is the honest reading of the
setting, and the checkbox is the fix.

## Menu chrome: heading, button, and native-control theming (v6.8.0)

- **`color-scheme` is set on the panel**, `dark` on the base and `light` on `.rnfp-light`.
  Native checkboxes and radios take their *unchecked* look from the color-scheme in force,
  which is the **host page's** unless the panel declares one — on a page that does not set it
  they render as bright white discs, louder than the checked ones. Caught by rendering the
  menu standalone (below); www.reddit.com happens to declare dark, so the live page hid it.
- **`.rnfp-menu-head`** (the "Start with the panel open…" heading) is `--text` + weight 700.
  It was `--muted`, which made the group label lighter than its own options.
- **`.rnfp-menu-btn`** is the in-menu action button — bordered, `--bg3`, with
  `:hover{filter:brightness(1.35)}` and `:active{translateY(1px) scale(.98); brightness(.8)}`,
  plus `pulse()` on click. This is Sudokupad Tools' `spdrFxButton` pattern, including the
  reason the click flash is an **inline filter and not a keyframe animation**: a CSS animation
  restarts every time the menu goes `display:none` → `block`, so the button re-flashed on
  every reopen. Clearing the inline value leaves nothing to replay. Only "Reset panel position
  & size" uses it; the interval menu's "Custom…" is still a plain row.
- **The settings menu is centred on the panel**, not right-aligned to the gear —
  `positionMenu(menu, anchor, centerOn)`. Measured 2026-09-03: the menu is ~310px against the
  panel's 286px, so centring costs ~12px of overhang a side instead of ~24px all on one.
  The interval menu still right-aligns to its footer button.

## Rendering the panel's CSS without Reddit

Faster than the live-page eval for anything purely visual: extract the `STYLE` template
literal straight out of the userscript, substitute `${PANEL_ID}`/`${CTX_ID}`/`${Z_INDEX}`, and
write it into a static HTML page with the menu markup. Scraping the row labels back out of
`buildSettingsMenu` with a regex keeps the harness from drifting from the script.

**The file must sit inside the project folder** — the Browser pane renders anything outside it
as a static snapshot with scripts CSP-blocked, so a harness in the scratchpad cannot self-measure
or be screenshotted. Write it to the project root, look at it, then recycle it.

## Custom refresh interval is inline, not a second popup (v6.9.0)

The interval menu's "Custom…" button used to swap the whole menu for a number box + OK. It now
ends in a permanent `Custom [ n ] sec` row that always shows the live interval:

- **The box's colour is the state indicator.** Muted while it merely mirrors a selected preset;
  `.rnfp-custom.active` (full strength, and no preset row highlighted) once a custom value is the
  live setting. `Off` shows an empty box with an `off` placeholder.
- **Commits on Enter *and* on blur**, so clicking away from a typed number keeps it. Escape
  rebuilds the menu, which reverts. Invalid (< `MIN_REFRESH_MS`) adds `.invalid` — a red border —
  rather than silently refusing.
- `keydown` is `stopPropagation`'d so Escape reaches the input before the panel's global handler.
- Spinners are hidden (`-webkit-appearance:none` + `-moz-appearance:textfield`); arrow keys still
  nudge. Sudokupad's `mkNumBox` avoided `type=number` for exactly this reason, but it only had
  inline styles available — a stylesheet can reach the spin-button pseudo-elements.
- The old "inject the non-preset value as an extra row" hack is gone: the box displays it now.
  `.rnfp-menu-row` / `.rnfp-ok` CSS went with it.

## Settings menu is never narrower than the panel (v6.9.0)

`ui.settingsMenu.style.minWidth = panel.offsetWidth + 'px'` on every open (the panel is
resizable, so it must be re-measured). It can still be *wider* — rows are `white-space: nowrap`
and a label will not be truncated to fit. Combined with the v6.8 centring, a menu at exactly the
panel's width now aligns flush with it. Only the settings menu does this; the interval menu is a
short list anchored to a footer control and looks wrong stretched.

## Tooltip coverage (v6.9.0)

Every control now has a `title`. The two dynamic ones are the ones worth knowing about:

- **`updateCloseTip()`** — the close button says something different depending on
  `rememberPages`, because closing means two different things and which one is in force is
  exactly what the user cannot see. Called at build and from the remember checkbox's `onChange`.
- **`ui.title.title`** and **`ui.footLeft.title`** are rebuilt in `updateBadge()` / `updateFoot()`
  with the live counts and fetch time.

Interval presets get "Check for new notifications every X"; `Off` explains that Reload is then
the only way. The bell context menu's four entries carry a `tip` field.

**Audit trick:** grep for `title:` misses multi-line `el(...)` calls. Scan for `el('button'` /
`el('a'` and check the following ~8 lines instead — that is what found the context menu had none.
