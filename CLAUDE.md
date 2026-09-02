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

The **header** is the one place accent survives, because Reddit's own top-bar badge trains you
to look for orange there: on unread the title text goes brighter and larger (`--text`, 14px,
from `--muted`, 13px) while only the bell icon and the count badge are `--accent`.

**Verified with the installed v6.0.0 (2026-09-02):** unread detection and badge, per-item
mark read (server confirmed via re-fetch of the partial), Mark all as read issued from
old.reddit through `GM_xmlhttpRequest` (server confirmed on www, Reddit's own bell badge
cleared), old.reddit bell menu + RES night-mode theme detection.

**Not yet verified:** "Load more" (needs >20 notifications; the code looks for a nested
`faceplate-partial` whose `src` contains `notification`).

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
v5 panel first. The tool's output filter blocks any result containing URL query strings or
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
