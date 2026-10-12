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
- Internet access the first time the Property Inspector opens: it loads Elgato's
  `sdpi.css` stylesheet from `cdn.elgato.com`. Offline it still works, unstyled.

## Install (development build)

```bash
npm ci
npm run build        # → com.johnmschoonover.decksync.sdPlugin/bin/plugin.js
npm run validate     # official manifest/asset validator
```

Then either `npx streamdeck link com.johnmschoonover.decksync.sdPlugin` (developer mode)
or copy the `.sdPlugin` folder into the Stream Deck plugins directory
(macOS `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`,
Windows `%APPDATA%\Elgato\StreamDeck\Plugins\`) and restart the app.
A **Deck Sync** category with the **Page Anchor** action appears in the actions list.

## Set up

1. **Profiles.** Each device must be on a profile bundled with Deck Sync (the app cannot be
   asked to switch to user-made profiles). Authoring and bundling them is a manual step
   described in [`docs/PROFILES.md`](docs/PROFILES.md): 5 pages, one Page Anchor per page
   with its page index set. Until profiles are bundled, switches fail with a
   `SWITCH failed … profile` warning in the log.
2. **Anchors.** Every page that should sync needs one Page Anchor whose *Page index* is the
   page's 0-based position. Bundled profiles come with them pre-placed; on your own pages
   drag **Deck Sync → Page Anchor** onto any key and set the index in its Property
   Inspector. Turn *Enabled* off to stop a page from driving the others.
3. **Scopes.** Open any Page Anchor's Property Inspector → **Deck Sync setup**:
   - In the device table pick *New scope…* for the first device (it becomes the parent) and
     the same scope for the others (children). Change roles with the *Role* column.
   - *Profile*: leave blank to use the bundled profile for the device type, or enter a
     manifest profile name such as `profiles/original`.
   - *Pages*: how many top-level pages that profile has (default 5).
   - Under the scope, add **overrides** (parent page ↔ child page) where the decks don't line up.
   - Click **Save**. Problems are shown inline and nothing invalid is saved.
4. Flip pages on any deck in the scope; the others follow.

## Reading the log

Logs are written to `com.johnmschoonover.decksync.sdPlugin/logs/` (gitignored). Engine
lines carry the `sync` scope; settings and Property Inspector lines the `DeckSync` scope.
Lines marked *(debug)* appear only while the manifest has `Nodejs.Debug` enabled (the
development build does); a release build logs info and above.

| Line | Meaning |
|---|---|
| `START devices=[P,C1] scopes=1 ttlMs=3000 graceMs=30000` | engine started after connect |
| `SETTINGS applied (start\|update) scopes=[…] detachedPending=0` | configuration (re)loaded |
| `SEND dev=P role=parent scope=desk page=2 canonical=2 seq=7 targets=[C1→profiles/mini#4] skipped=[C2:already-there]` | human navigation fanned out |
| `RECEIVE dev=C1 page=4 seq=7 origin=P (echo consumed; no rebroadcast)` | a switch the plugin issued landed (`late=true`: later than 3 s) |
| `RECEIVE_STALE dev=P … restoring page=1 seq=9` | a switch landed after the device's own later navigation; undone |
| `STARTUP dev=C1 page=0 (armed; no sync)` | first appear after launch/reconnect |
| `SUPPRESSED dev=C1 page=1 … reason=parent-in-flight` | child flip while the parent's switch to it was landing |
| `IGNORED … reason=disabled` / `no-scope` / `no-page-index` (warn, once) | why nothing was sent |
| `IGNORED … reason=duplicate` / `multi-action` *(debug)* | second anchor on the page / not a page marker |
| `SKIP target=C2 … reason=disconnected` / `no-profile` (warn), `no-counterpart` (info), `already-there` *(debug)* | member skipped, with the fix |
| `SWITCH sent …` *(debug)*; `SWITCH failed dev=C1 profile=… error="…"` (warn) | the request was written / the app rejected it |
| `SWITCH unconfirmed dev=C1 profile=… — no appear within 3000ms …` (warn) | a switch never landed: missing anchor, unbundled profile, or already there |
| `DEVICE connected` / `DEVICE disconnected … droppedPending=n` | device events |
| `LEAVE dev=P page=2`, `GC …` *(debug)* | a page was left / an old tag was dropped |
| `Settings: …` (warn, `DeckSync` scope) | a scope was rejected and why; `PI: …` lines concern the Property Inspector |

## Troubleshooting

- **Nothing syncs** — check the device table: both devices in the same scope, one parent,
  Saved. Check the log for `IGNORED … no-scope` or `no-page-index`.
- **`SWITCH failed … profile`** — the target profile is not bundled/registered in
  `manifest.json → Profiles`, or the device type has no default; set *Profile*.
- **One device never follows** — its *Pages* count may be lower than the page being sent
  (`SKIP … no-counterpart`), or it is disconnected (`SKIP … disconnected`).
- **A page flip did nothing once right after a switch** — expected only when the page you
  flipped to is one the plugin had just tried to switch that device to and the switch never
  confirmed (`SWITCH unconfirmed` in the log); see [`docs/SYNC_ENGINE.md`](docs/SYNC_ENGINE.md).
- **The Property Inspector is unstyled** — it could not load `sdpi.css` from
  `cdn.elgato.com`; everything still works.

## Limitations

- Top-level pages only; folders/subpages are detected but not driven (Spike-1 pending).
- Bundled profiles only. None are bundled yet (D1 pending), and the Stream Deck + has no
  default profile name (set *Profile* manually).
- Button state is not synced, only the page.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict, native decorators)
npm run build       # rollup
npm test            # jest — settings, mapping, engine, PI bridge, anchor adapter, profiles, assets (7 suites, coverage thresholds enforced)
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
| `src/piBridge.ts`, `src/piProtocol.ts` | plugin side of the Property Inspector protocol |
| `com.johnmschoonover.decksync.sdPlugin/ui/anchor.html` | marker settings + Deck Sync setup UI |
| `docs/` | engine design, profile authoring, manual test matrix, Spike-1 |

CI runs typecheck, build, validate and tests on Node 22 and 24. See `CLAUDE.md` for how
work in this repo is organised.

## License

[MIT](LICENSE)
