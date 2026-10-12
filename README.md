# Deck Sync

Keep several Stream Deck devices on matching pages. Give each device a **role** (parent or
child), group them into a **scope**, and changing pages on any deck in the scope drives the
others to their mapped pages — with the parent always authoritative. Runs entirely inside
the Stream Deck app; no scripts or daemons.

> **Status: pre-release.** The engine, configuration UI and tests are complete and
> verified headless. Loading in the Stream Deck app, real-device sync and the bundled
> profiles still need the hardware gates in [`docs/MANUAL_TESTS.md`](docs/MANUAL_TESTS.md).
> The product spec is [`PRD.md`](PRD.md).

## How it works

- **Page Anchor** — a tiny action you put on every page you want synced. It stores only the
  page's **index** (0 = first page) and an **enabled** flag. When its page appears, the
  plugin learns that the device navigated there; there is no page-change event in the SDK.
- **Scopes and roles** — in the anchor's Property Inspector you assign each device to a
  scope as **parent** or **child**. A scope has exactly one parent and one or more children;
  several scopes can coexist; a device belongs to at most one scope.
- **Send or receive, never both** — a page change caused by a person is a *send*: the other
  members of the scope are switched to their mapped pages. A page change the plugin itself
  caused is a *receive*: recorded, never rebroadcast. The plugin tags every switch it
  issues before issuing it, so an echo is recognised by cause, not by timing. No loops.
- **Parent precedence** — any deck can lead, but a child's navigation while the parent's
  switch to it is still landing is suppressed, and the parent's own choice always wins.
- **Mapping** — positional by default (page N ↔ page N). An **override** pins a parent page
  to a child page in both directions; a pinned page loses its positional counterpart so
  pairs stay one-to-one.
- **Startup guard** — nothing fires when the app launches or a device reconnects.
- Sync targets the **profiles bundled with the plugin** only (an SDK limit), at top-level
  page granularity. Folder/subpage sync is pending [`docs/SPIKE1.md`](docs/SPIKE1.md).

## Requirements

- Stream Deck app **7.1+** on macOS 13+ or Windows 10+ (Node.js 24 runtime is bundled with the app).
- Two or more Stream Deck devices. **No profiles are bundled yet** — they must be exported
  from the Stream Deck app and added per [`docs/PROFILES.md`](docs/PROFILES.md) before sync
  can run. Defaults are wired for the Original/MK.2, Mini, XL and Neo; any other device type
  (including the Stream Deck +) needs a profile name set in the configuration UI.
- Internet access when the Property Inspector opens: it loads Elgato's `sdpi.css`
  stylesheet from `cdn.elgato.com` each time. Offline it still works, unstyled.

## Install (development build)

```bash
npm ci
npm run build        # → com.johnmschoonover.decksync.sdPlugin/bin/plugin.js
npm run validate     # official manifest/asset validator
```

Then either enable developer mode once with `npx streamdeck dev` and run
`npx streamdeck link com.johnmschoonover.decksync.sdPlugin`, or copy the `.sdPlugin` folder into the Stream Deck plugins directory
(macOS `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`,
Windows `%APPDATA%\Elgato\StreamDeck\Plugins\`) and restart the app.
A **Deck Sync** category with the **Page Anchor** action appears in the actions list.

## Set up

1. **Profiles.** Each device must be on a profile bundled with Deck Sync (the app cannot be
   asked to switch to user-made profiles). Authoring and bundling them is a manual step
   described in [`docs/PROFILES.md`](docs/PROFILES.md): 5 pages, one Page Anchor per page
   with its page index set. Until profiles are bundled, the app ignores or rejects each
   switch request: `SWITCH unconfirmed … profile` (written the next time the plugin touches
   that device, at least 3 s later) or `SWITCH failed …` in the log.
2. **Anchors.** Every page that should sync needs one Page Anchor whose *Page index* is the
   page's 0-based position. Bundled profiles come with them pre-placed; on your own pages
   drag **Deck Sync → Page Anchor** onto any key and set the index in its Property
   Inspector. Turn *Enabled* off to stop a page from driving the others.
3. **Scopes.** Open any Page Anchor's Property Inspector → **Deck Sync setup (all devices)**:
   - In the device table pick *New scope…* for the first device (it becomes the parent) and
     the same scope for the others (children). Change roles with the *Role* column.
   - *Profile*: leave blank to use the bundled profile for the device type, or enter a
     manifest profile name such as `profiles/original`.
   - *Pages*: how many top-level pages that profile has (default 5).
   - Under the scope, add **overrides** (parent page ↔ child page) where the decks don't line up.
   - **Add scope** creates an empty scope to assign devices to; choosing *Parent* for a device
     demotes the scope's previous parent to a child; moving the last member out removes the
     scope, and empty scopes are dropped on Save. Each scope box has a **Remove scope** button
     (its devices become unassigned). Devices are listed by name, with "(disconnected)" while
     the app has not announced them, "(id)" when two share a name, and "unknown device <id>"
     for one that is in a saved scope but not plugged in.
     An override must involve the parent, both pages must be below the devices' *Pages*
     counts, a parent page or child page can be pinned only once per child, and changing
     the parent drops overrides that no longer involve it (shown before you Save).
   - Click **Save**. Problems are shown inline and nothing invalid is saved; **Discard
     changes** returns to the saved configuration.

   The marker fields above the setup are saved instantly and never discarded. The setup's
   status line can read:

   | Message | Meaning |
   |---|---|
   | Loading the saved configuration… (table), Waiting for the plugin… | the plugin has not answered yet; **Save** / **Add scope** stay disabled |
   | The plugin did not receive this panel's messages — make sure the device is connected and this page is showing on it, then close and reopen the panel. | three requests went unanswered (the app only delivers a panel's messages while its page is showing) |
   | The plugin did not send its device list — … | only the device list is missing; scopes can still be edited |
   | Unsaved changes. / Saving… | the draft differs from what is saved / a Save is awaiting confirmation |
   | Saved. / Saved; you have further unsaved changes. | confirmed / confirmed, but you kept editing meanwhile: Save again |
   | Saving… (the save already sent cannot be discarded) | **Discard changes** during a save; the panel adopts what the plugin confirms |
   | No reply from the plugin — is it running? Try Save again. | not confirmed within 5 s (a later confirmation is still accepted). Selecting another Page Anchor while a Save is on its way also ends here, because the plugin can only answer the panel that is open: the save itself went through |
   | Not saved — fix these and try again: … | the plugin rejected the save; the reasons follow |
   | The save sent earlier was rejected; the panel shows the last saved configuration: … | rejected after you discarded the draft |
   | Fix the highlighted fields first: <field>. / Pages must be … / … must be a whole number … | a page count or override page is blank or not a whole number; the scope box holding the field is opened and the field focused |
   | Page index must be a whole number, 0 or more. The page index was not saved; Enabled was. | the marker's page index is invalid |
   | Saved settings had problems; invalid scopes were ignored: … | an earlier save held scopes the plugin dropped: fix and Save |
   | Disconnected from Stream Deck — close and reopen this panel. | the app restarted under the panel |
   | No Stream Deck devices known yet. (table) | the app has announced no device; scopes from the saved configuration are still listed |
   | Assign at least a parent and one child to this scope. (scope box) | the scope has no overrides section until it has both |
   | n override(s) no longer involve the parent and will be dropped on Save (Discard changes restores them). | a role change orphaned overrides |
4. Flip pages on any deck in the scope; the others follow.

## Reading the log

Logs are written inside the installed plugin folder, `…/com.johnmschoonover.decksync.sdPlugin/logs/`
(the repo's own `.sdPlugin` folder when linked; gitignored) as `com.johnmschoonover.decksync.<n>.log`; the SDK rotates them (up to 10 files of 50 MB), and
the lowest number is the current file. In the development build (`Nodejs.Debug` on) the same
lines also go to the plugin's stdout. Engine lines carry the `sync` scope; settings and Property Inspector lines
the `DeckSync` scope. Lines marked *(debug)* appear only while the manifest has
`Nodejs.Debug` enabled (the development build does); a release build logs info and above.

| Line | Meaning |
|---|---|
| `START devices=[P,C1] scopes=1 ttlMs=3000 graceMs=30000 queued=0` | engine started after connect (`queued`: flips made before the settings loaded, replayed next) |
| `SETTINGS applied (start\|update) scopes=[…] detachedPending=0` | configuration (re)loaded (`detachedPending`: switches in flight whose origin lost its standing — its device or the target left the scope, or it is no longer the parent; a rename or mapping change detaches nothing) |
| `SEND dev=P role=parent scope=desk page=2 canonical=2 seq=7 targets=[C1→profiles/mini#4] skipped=[C2:already-there]` | human navigation fanned out |
| `RECEIVE dev=C1 page=4 seq=7 origin=P scope=desk (echo consumed; no rebroadcast)` | a switch the plugin issued landed; at most one flag: `late=true` (later than 3 s — a detached one shows this after 3 s too), `detached=true` (issued before a settings change that took its origin's standing away: its device or the target left the scope, or it is no longer the parent), `capped=true` (one of more than 50 switches still awaiting a landing), `superseded=true` (a later landing on this device had passed it by: the app coalesced it, or it repeated a page), `left=true` (the device had left this page before the switch showed) |
| `RECEIVE_STALE dev=P … restoring page=1 seq=9` | a switch landed after the device's own later navigation; undone |
| `STARTUP dev=C1 page=0 (armed; no sync)` | first appear after launch/reconnect |
| `ANCHOR updated dev=P action=… page=2→3 enabled=true (no sync)` — or `… (consumed seq=n) (no sync)`, or `page=2→none (page index cleared; …)` | a visible anchor's settings were edited; the engine now knows the device is on that page (and takes a pending switch to that index as landed), or no longer knows its page |
| `SUPPRESSED dev=C1 page=1 … reason=parent-in-flight` | child flip while the parent's switch to it was landing |
| `IGNORED … reason=disabled` (info) | the page's marker is disabled; nothing sent |
| `IGNORED … reason=no-scope` (warn once per device per saved configuration, then *debug*) / `no-page-index` (warn once per anchor) | the device is in no scope / the anchor has no page index |
| `IGNORED … reason=conflicting-anchors` (warn) | the breaker tripped (a run of 13 conflicts: pages reporting two page indices): a page on that device carries a copied anchor with the wrong page index; its sends resume after a page with a single anchor |
| `IGNORED … reason=overturned-switches` (warn) | the other breaker tripped (13 sends in a row while a switch from another deck to this device never showed): a page on that device reports the wrong page index or has no Page Anchor; its sends resume once a switch lands there, or after a flip made with nothing outstanding |
| `QUEUE full dev=P page=3 reason=not-started — … dropped the oldest (dev=P page=1)` (warn) | more than 20 flips before the settings loaded; the newest are kept |
| `SEND dev=P page=6 scope=desk reason=beyond-page-count pageCount=5 — …` (warn, once per device and page) | the device flipped to a page its *Pages* setting says it does not have; nobody can follow until *Pages* is raised |
| `GC dev=C1 page=1 seq=1 reason=cap — …` (warn) | more than 50 switches to one device still awaiting a landing; the oldest are kept as echo tags only |
| `QUEUED … reason=not-started` (or `… (replaces the disabled anchor's appear queued for this page)`), `CONFLICT …`, `OVERTURN …`, `SETTINGS unchanged (update)` *(debug)* | a flip before the settings loaded (replayed in order once they have; a page's enabled anchor reported after its disabled one is the flip replayed), a page reporting two page indices, a send while another deck's switch to the device has not shown, a reload that changed nothing |
| `IGNORED … reason=duplicate` (with `(consumed seq=n)` or `(a switch to this page waits behind an older one; kept)`) / `multi-action` *(debug)* | second anchor on the page or a re-emit (it stands for a switch to that page only when that switch is the oldest outstanding) / not a page marker |
| `SKIP target=C2 … reason=disconnected` / `no-profile` / `error` (warn), `no-counterpart` (info), `already-there` / `queued-later` *(debug)* | member skipped, with the fix (`queued-later`: its own flip made before the settings loaded is replayed next) |
| `SWITCH sent …` *(debug)*; `SWITCH failed dev=C1 profile=… error="…"` (warn) | the request was written / the app rejected it |
| `SWITCH unconfirmed dev=C1 profile=… — no appear within 3000ms …` (warn) | a switch never landed: missing anchor, unbundled profile, or already there |
| `DEVICE connected` (info for a device not yet armed: new, or after a disconnect; *debug* `(already armed; no change)` otherwise) / `DEVICE disconnected … droppedPending=n` (`droppedQueued=n` when pre-start flips were discarded) | device events |
| `LEAVE dev=P page=2`, `GC … reason=superseded` / `left-page` / `grace-elapsed` / `duplicate-tag` *(debug)* | a page was left / a switch a later landing passed by (kept as a tag for 3 s) or one overtaken by the device leaving its page before it showed (kept for 30 s) / an old tag was dropped |
| `UNEXPECTED handler=onAppear …` / `handler=onDisappear …` / `handler=onAnchorUpdated …` (error) | a bug: the handler threw (caught; a failed disappear or anchor edit changes nothing) — please report it |
| `Settings saved: n scope(s).` (info); `Settings: …` (warn: a scope rejected and why, `rejected a save … with n problem(s)`, `rejected a save … that carried no usable settings`, `Could not save settings (…)`, `could not read global settings (…); using defaults`, `ignoring an unusable global-settings payload`, `no reply from Stream Deck within 15000ms`; *debug*: an event before start, an event or `the late reply` ignored because the panel's save is already applied); `PI: …` (warn: a reply could not be sent; *debug*: no panel open, unknown message, or a request from a panel that is no longer the open one — the reply goes to the open panel); `Startup failed: …` (error) — `DeckSync` scope | configuration and Property Inspector traffic; the plugin could not start |

## Troubleshooting

- **Nothing syncs** — check the device table: both devices in the same scope, one parent,
  Saved. Check the log for `IGNORED … no-scope` or `no-page-index`.
- **`SWITCH failed … profile`** — the target profile is not bundled/registered in
  `manifest.json → Profiles`.
- **`SKIP … no-profile`** — the device type has no bundled default (Stream Deck +, Studio, …);
  set *Profile* for that device in the configuration UI.
- **One device never follows** — `SKIP … no-counterpart` means the page has no mapping:
  the target's *Pages* count is below that page, or an override pins it elsewhere; a
  `SEND … reason=beyond-page-count` warning means the *sending* device's *Pages* is too low;
  `SKIP … disconnected` means the app has not reported the device as connected.
- **A page flip did nothing once right after a switch** — expected only when the page you
  flipped to is one the plugin had just tried to switch that device to: the flip is logged as
  a `RECEIVE` (plain within 3 s, `late=true` after a `SWITCH unconfirmed` warning,
  `superseded=true` when a later landing had passed the switch by, or `left=true` when the
  device had left the page before the switch showed) instead of a `SEND`, and within the
  first 3 s the deck can once jump back to its previous page. The switch never showed because
  the device was already there, the page has no Page Anchor, or the profile is not bundled;
  see [`docs/SYNC_ENGINE.md`](docs/SYNC_ENGINE.md).
- **A child's flip right after a fast parent burst did nothing** — `SUPPRESSED …
  reason=parent-in-flight`: the parent's switches to that child are still expected (3 s).
  Flip again after 3 s; manual check C-16 and `docs/SYNC_ENGINE.md` ("The bounded cost")
  explain the trade-off.
- **The Property Inspector is unstyled** — it could not load `sdpi.css` from
  `cdn.elgato.com`; everything still works.

## Limitations

- Top-level pages only; folders/subpages are detected but not driven (Spike-1 pending).
- Bundled profiles only. None are bundled yet (D1 pending), and the Stream Deck + has no
  default profile name (set *Profile* manually).
- Button state is not synced, only the page.
- Page Anchors inside Multi Actions are ignored (the action is not offered there).
- Copied anchors whose page index was not updated make a page report two indices; a
  conflicting-anchor breaker stops the resulting ping-pong, but the fix is the anchor's index.

## Development

```bash
npm run typecheck   # tsc --noEmit (plugin, Node-only) && tsc -p tsconfig.test.json (tests, jsdom)
npm run watch       # rebuild and restart the plugin on change (needs the Stream Deck app and developer mode: `npx streamdeck dev` once)
npm run build       # rollup (fails on any warning)
npm test            # jest — settings, mapping, engine, plugin wiring, PI bridge, PI page (jsdom), anchor adapter, profiles, assets, log, engine purity (coverage thresholds enforced)
npm run validate    # streamdeck validate
npm run icons       # regenerate placeholder icons
```

Before a release (PRD Epic E5): remove `Nodejs.Debug` from `manifest.json` (it runs the
plugin with `--inspect` and raises log verbosity), replace the placeholder icons, and settle
the final UUID/author domain (PRD OQ-6).

| Path | What |
|---|---|
| `src/plugin.ts` | entry: builds the engine over the SDK, registers the action, starts after connect |
| `src/syncEngine.ts` | the causal send/receive engine (design: `docs/SYNC_ENGINE.md`) |
| `src/settings.ts`, `src/mapping.ts`, `src/profiles.ts` | settings schema + validation, page mapping, default profile names |
| `src/actions/page-anchor.ts` | the Page Anchor action (SDK event → engine input) |
| `src/piBridge.ts`, `src/piProtocol.ts` | plugin side of the Property Inspector protocol, global-settings handler |
| `src/ids.ts`, `src/log.ts` | plugin/action UUIDs (checked against the manifest), logger contract |
| `scripts/make-placeholder-icons.mjs` | placeholder icon generator (`npm run icons`) |
| `com.johnmschoonover.decksync.sdPlugin/ui/anchor.html` | marker settings + "Deck Sync setup (all devices)" UI |
| `docs/` | engine design, profile authoring, manual test matrix, Spike-1 |

CI runs typecheck, build, validate and tests on Node 22 and 24. See `CLAUDE.md` for how
work in this repo is organised.

## License

[MIT](LICENSE)
