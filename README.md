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
- Two or more Stream Deck devices. Bundled profiles exist for the Original/MK.2, Mini, XL
  and Neo once they are authored (see below); other device types need a profile name set
  in the configuration UI.

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

`com.johnmschoonover.decksync.sdPlugin/logs/` — one line per event, scope `sync`:

| Line | Meaning |
|---|---|
| `SEND dev=P role=parent scope=desk page=2 canonical=2 seq=7 targets=[C1→profiles/mini#4] skipped=[C2:already-there]` | human navigation fanned out |
| `RECEIVE dev=C1 page=4 seq=7 origin=P (echo consumed; no rebroadcast)` | a switch the plugin issued landed |
| `STARTUP dev=C1 page=0 (armed; no sync)` | first appear after launch/reconnect |
| `SUPPRESSED dev=C1 page=1 … reason=parent-in-flight` | child flip while the parent's switch was landing |
| `IGNORED … reason=disabled` / `no-scope` / `no-page-index` / `duplicate` | why nothing was sent |
| `SKIP target=C2 … reason=disconnected` (warn) | member skipped, with the fix |
| `SWITCH failed dev=C1 profile=… error="…"` (warn) | the app rejected a switch |
| `SETTINGS applied … droppedPending=0` | configuration (re)loaded |

## Troubleshooting

- **Nothing syncs** — check the device table: both devices in the same scope, one parent,
  Saved. Check the log for `IGNORED … no-scope` or `no-page-index`.
- **`SWITCH failed … profile`** — the target profile is not bundled/registered in
  `manifest.json → Profiles`, or the device type has no default; set *Profile*.
- **One device never follows** — its *Pages* count may be lower than the page being sent
  (`SKIP … no-counterpart`), or it is disconnected (`SKIP … disconnected`).
- **A page flip did nothing once right after a switch** — expected only if the target page
  had no anchor; see the GC notes in [`docs/SYNC_ENGINE.md`](docs/SYNC_ENGINE.md).

## Limitations

- Top-level pages only; folders/subpages are detected but not driven (Spike-1 pending).
- Bundled profiles only; no Stream Deck + profile is bundled yet (set *Profile* manually).
- Button state is not synced, only the page.

## Development

```bash
npm run typecheck   # tsc --noEmit (strict, native decorators)
npm run build       # rollup
npm test            # jest — settings, mapping, engine, PI bridge, assets
npm run validate    # streamdeck validate
npm run icons       # regenerate placeholder icons
```

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
