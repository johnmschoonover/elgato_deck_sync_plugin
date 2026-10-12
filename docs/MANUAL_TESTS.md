# Manual test matrix — hardware gates **[gate]**

Everything here needs the Stream Deck app and real devices (PRD §9 "Verification
responsibilities"). Run on at least one macOS and one Windows machine, ideally with two
physical devices of different types. Record results in the table at the end.

**Setup used throughout:** two devices, call them **P** (parent) and **C** (child). Plugin
installed from a build (`npm run build`, then copy the `.sdPlugin` folder, or enable
developer mode once with `npx streamdeck dev` and `npx streamdeck link` it). Plugin log:
the `logs/` folder inside the installed `.sdPlugin` folder (the repo's own when linked).

## Gate A3 — plugin loads

| Step | Expect |
|---|---|
| Install / link the plugin, restart Stream Deck. | "Deck Sync" category appears in the actions list with the Page Anchor action and its icon. |
| Open Preferences → Plugins. | Deck Sync is listed; no warning badge. |
| Open the log file (`logs/com.johnmschoonover.decksync.0.log`). | No error lines. The `sync` scope shows `SETTINGS applied (start) scopes=[] detachedPending=0` and `START devices=[…] scopes=0 ttlMs=3000 graceMs=30000 queued=0`, one `DEVICE connected dev=…` line per plugged-in device (info when the connect event came before the device's first appear; the debug variant `DEVICE connected dev=… (already armed; no change)` when its appear came first — a release build does not show that one) and one `STARTUP dev=… page=N` line per device on its current page — in any order relative to the two start lines (the SDK lists a device as connected only once the app has announced it; the case to record is a device with neither line that later shows `SKIP … reason=disconnected` on every sync). |
| `npm run validate` on the same build. | "Validation successful". |

## Gate B — configuration persists (PRD §7.2)

| Step | Expect |
|---|---|
| Drag a Page Anchor onto any key of P. Open its Property Inspector. | *Page index* empty, *Enabled* on, "This marker is on device P". Log: one `IGNORED dev=P action=… reason=no-page-index — open this Page Anchor's Property Inspector and set its page index` (warn, once per anchor) — expected, not an error. Opening the panel without editing must log **no** `ANCHOR updated` line (record it if one appears: `docs/SYNC_ENGINE.md`, hardware item 11). Tab through the panel: the *Enabled* box takes keyboard focus and toggles with Space (if it is skipped, the sdpi stylesheet hides the native checkbox — record it). |
| Set *Page index* to `0`. Click another key, then the anchor again. | *Page index* still shows `0` (PI hydration, PRD §8.3). Log: `ANCHOR updated dev=P action=… page=none→0 enabled=true (no sync)` — one line per keystroke, since every keystroke saves. |
| In **Deck Sync setup (all devices)**: for P choose *New scope…*; for C choose *Scope 1*. | P shows role Parent, C shows Child; the scope box reads "Scope 1: parent P, 1 child". Status "Unsaved changes." |
| Click **Save**. | Status "Saved." Log (`DeckSync` scope): `Settings saved: 1 scope(s).` |
| Change P's role to Child and Save. | Status "Not saved — fix these and try again: • Scope 'scope-1' ignored: a scope needs exactly one parent; found 0." Nothing persisted. Click **Discard changes** → P is Parent again. |
| Quit and relaunch Stream Deck; open the anchor's PI. | The scope, roles and names are exactly as saved. |

## Gate C — sync behaviour (PRD §7.3)

Prerequisite: bundled profiles exist (D1) and both devices are on them, each page carrying
one anchor with the right page index (docs/PROFILES.md). Scope: P parent, C child,
positional mapping.

| # | Step | Expect |
|---|---|---|
| C-1 | Launch Stream Deck with both devices connected. Touch nothing for 10 s. | **Nothing moves.** Log shows the startup appears classified as startup/ignored, no `SEND`. |
| C-2 | On P press the page-right key: page 0 → 1. | C goes to page 1. Log: one `SEND` line for P page 1 naming C as target, then a `RECEIVE` (echo) line for C page 1. No further `SEND`/`RECEIVE` lines (debug `LEAVE` / `SWITCH sent` lines are expected in the dev build). |
| C-3 | On C press page-right: 1 → 2. | P goes to page 2 (peer follow). Log: `SEND` from C, `RECEIVE` on P. |
| C-4 | On P press left/right rapidly 10 times, ending on page 3. | C ends on page 3; the two devices do not oscillate afterwards. Log shows one `SEND` per press and one `RECEIVE` per landed switch, no `SEND` caused by a `RECEIVE`. |
| C-5 | With P on page 2, open its page-2 anchor's PI and switch *Enabled* off (the log shows `ANCHOR updated dev=P action=… page=2→2 enabled=false (no sync)`; nothing moves). Flip P to page 1, then back to page 2. | C follows to page 1 and does **not** follow back to 2. Log: `SEND dev=P … page=1 …`, then `IGNORED dev=P page=2 scope=… reason=disabled` (info) and no `SEND` for it. Switch *Enabled* back on afterwards (`ANCHOR updated … enabled=true`). |
| C-6 | Add override P page 1 ↔ C page 4, Save. Flip P to page 1. | C goes to page 4. Flip C to page 4 by hand from elsewhere → P goes to page 1. |
| C-7 | Unplug C. Flip P. | P flips normally; log: a `warn` naming C as disconnected/skipped. No error dialogs. |
| C-8 | Plug C back in (it shows its last page). | **Nothing moves** on reconnect. Log: C's appears classified as startup/ignored. Then flip P → C follows again. |
| C-9 | Simultaneously (as close as you can) flip P to page 0 and C to page 3. | Both end on **page 0** (parent wins). Record which flip the log reports first. P first: `SEND dev=P …`, then `SUPPRESSED dev=C page=3 … reason=parent-in-flight`, then C's `RECEIVE` on 0 — nothing else moves. C first: `SEND dev=C …`, `SEND dev=P …`, then C's switch lands on P as `RECEIVE_STALE dev=P page=3 … restoring page=0` — **P shows page 3 for a moment and jumps back to 0 once**; that single flicker is expected. The failure is repeated back-and-forth, or anyone ending anywhere but page 0. |
| C-10 | Set both devices to *— not synced —* (or click **Remove scope**) and Save. Flip P. | Nothing happens on C. Log: `IGNORED dev=P page=N reason=no-scope — …` once at warn (debug on later flips). Re-create the scope afterwards. |
| C-11 | Rapid burst: on P press right, right, left, left as fast as possible (0→1→2→1→0). | C ends on page 0. Log, one of: a `RECEIVE` line on C for every intermediate page (1, 2, 1); or, for pages the app skipped before one it did show, `GC … reason=superseded` debug lines at that landing; or — if C shows nothing at all because it was already on 0 — four `SWITCH unconfirmed` warnings about 3 s later (the coalesced case C-16 measures). Record which — it tells us whether the app applies every switch, only the last, or none when the net result is the current page. Only a `SEND` from C without a human flip is a failure. Also record, for P, whether `LEAVE dev=P page=N` debug lines appear *between* P's `SEND` lines: present means the app reports the old page's disappear before the new page's appear; absent means appear first (the engine then has nothing left to forget). And record whether C's log shows `LEAVE dev=C page=0` followed by `IGNORED dev=C page=0 … reason=duplicate` for the switch back to the page C already shows — that is the app re-emitting a shown page's anchors (`docs/SYNC_ENGINE.md` hardware item 2). |
| C-12 | Put the Mac/PC to sleep for a minute right after flipping P, then wake it. Flip nothing else. | After wake, nothing moves on its own. If a `RECEIVE … late=true` line appears in the log, that is the late echo being absorbed correctly; a `SEND` line without a human flip would be a bug. |
| C-13 | Open the PI, rename the scope, then flip P and click **Save** within a second. | C still lands on P's page; nothing moves afterwards. Log: `SETTINGS applied (update) … detachedPending=0` (a rename keeps P the parent, so its switch stays expected) and C's landing as a plain `RECEIVE` (or `late=true` if it took longer than 3 s) — never a `SEND` from C. Variant: make C the parent instead of renaming, then flip the (old) parent and Save: `detachedPending=1` and C's landing as `RECEIVE … detached=true`. |
| C-14 | Quit Stream Deck. Relaunch it and flip P, then C, the moment the devices light up (before the plugin has loaded its settings). | Everyone ends on **C's** page (nothing was in flight before start, so the parent's earlier flip is not a conflict: it is replayed without driving C, whose own later flip is replayed next). Log: `QUEUED … reason=not-started` for both (debug), `START … queued=2`, `SEND dev=P … skipped=[C:queued-later]`, then `SEND dev=C …`. If a flip was too early for the plugin to see at all, nothing is logged for it — that is fine; repeat a little later. |
| C-15 | On P, copy the page-1 anchor key onto page 2 **without** changing its page index (page 2 now carries anchors saying 1 and 2). Flip P to page 2, then back to page 1. | Two `SEND` lines for P, one per anchor (record their order), a `CONFLICT dev=P page=… also=[…]` debug line for the second, and on leaving page 2 a `CONFLICT dev=P pages=[1,2]` debug line; no `conflicting-anchors` warning (that takes a cycle of such pages on both decks). C ends on whichever index the app reported last — a single stray anchor silently overturns a navigation. Delete the copied anchor afterwards. (The other wrong-index shape — a page whose *only* anchor says the wrong index — reports a single index and cannot cycle: a re-emit of the shown page is a duplicate. Only pages that cross-label each other across both decks cycle, and that ends with `IGNORED … reason=overturned-switches` on a child after 13 hops, `docs/SYNC_ENGINE.md` rule 10b.) |
| C-16 | Flip P right then left quickly (0 → 1 → 0, well under a second). Within 2 s, flip C to page 3. | Record what happens. Either C's flip syncs (`SEND dev=C …`: the app applied both switches and C showed page 1 briefly), or it is `SUPPRESSED … reason=parent-in-flight` and nobody follows until C's next flip after 3 s (the app coalesced the burst, leaving C's tags dangling). The second outcome is the engine's documented cost (`docs/SYNC_ENGINE.md`, "The bounded cost"); how often it happens decides whether the 3 s TTL should change (PRD §8.6). |
| C-17 | With P on page 2, open its page-2 anchor's PI and change *Page index* to 3, then back to 2 — select the digit and overtype it. | Nothing moves. Log: `ANCHOR updated dev=P action=… page=2→3 enabled=true (no sync)` then `… page=3→2 …`. (Deleting the digit before retyping logs an extra `… page=3→none (page index cleared; …)` and then `… page=none→2 …` instead — also fine.) Then flip C to page 2: P is skipped as `already-there` (it is), nothing oscillates. |

## Gate D3 — install → customise → sync

| Step | Expect |
|---|---|
| Install the plugin fresh with both devices connected. | Stream Deck prompts to add the bundled profiles; they appear under Preferences → Profiles as "Deck Sync — <Device>". |
| Switch both devices to their Deck Sync profiles; change a few key titles/icons (not the anchors). | Edits stick. |
| Build the scope in the PI (Gate B steps) and Save. | Saved. |
| Flip pages on either device. | The other follows (positional). |

## Spike-1 — subpage targeting

See `docs/SPIKE1.md` for the procedure and the result slot.

## Icons (PRD §7.7)

| Step | Expect |
|---|---|
| Actions list, category header, a placed key, Preferences → Plugins. | Icons render crisply at 1× and on a Retina/HiDPI display (the `@2x` files). |

## Results

| Date | Machine / OS | Devices (P / C) | Stream Deck version | A3 | B | C-1…C-17 | D3 | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
