# Manual test matrix — hardware gates **[gate]**

Everything here needs the Stream Deck app and real devices (PRD §9 "Verification
responsibilities"). Run on at least one macOS and one Windows machine, ideally with two
physical devices of different types. Record results in the table at the end.

**Setup used throughout:** two devices, call them **P** (parent) and **C** (child). Plugin
installed from a build (`npm run build`, then copy or `streamdeck link` the `.sdPlugin`
folder). Plugin log: `com.johnmschoonover.decksync.sdPlugin/logs/`.

## Gate A3 — plugin loads

| Step | Expect |
|---|---|
| Install / link the plugin, restart Stream Deck. | "Deck Sync" category appears in the actions list with the Page Anchor action and its icon. |
| Open Preferences → Plugins. | Deck Sync is listed; no warning badge. |
| Open the log file. | No errors at startup; a `DeckSync` scope line showing it connected. |
| `npm run validate` on the same build. | "Validation successful". |

## Gate B — configuration persists (PRD §7.2)

| Step | Expect |
|---|---|
| Drag a Page Anchor onto any key of P. Open its Property Inspector. | *Page index* empty, *Enabled* on, "This marker is on device P". |
| Set *Page index* to `0`. Click another key, then the anchor again. | *Page index* still shows `0` (PI hydration, PRD §8.3). |
| In **Deck Sync setup**: for P choose *New scope…*; for C choose *scope-1*. | P shows role Parent, C shows Child; the scope box lists "parent P, 1 child". Status "Unsaved changes." |
| Click **Save**. | Status "Saved." Log: `Settings saved: 1 scope(s).` |
| Change P's role to Child and Save. | Status "Not saved: … a scope needs exactly one parent; found 0." Nothing persisted. Click **Discard** → P is Parent again. |
| Quit and relaunch Stream Deck; open the anchor's PI. | The scope, roles and names are exactly as saved. |

## Gate C — sync behaviour (PRD §7.3)

Prerequisite: bundled profiles exist (D1) and both devices are on them, each page carrying
one anchor with the right page index (docs/PROFILES.md). Scope: P parent, C child,
positional mapping.

| # | Step | Expect |
|---|---|---|
| C-1 | Launch Stream Deck with both devices connected. Touch nothing for 10 s. | **Nothing moves.** Log shows the startup appears classified as startup/ignored, no `SEND`. |
| C-2 | On P press the page-right key: page 0 → 1. | C goes to page 1. Log: one `SEND` line for P page 1 naming C as target, then a `RECEIVE` (echo) line for C page 1. No further lines. |
| C-3 | On C press page-right: 1 → 2. | P goes to page 2 (peer follow). Log: `SEND` from C, `RECEIVE` on P. |
| C-4 | On P press left/right rapidly 10 times, ending on page 3. | C ends on page 3; the two devices do not oscillate afterwards. Log shows one `SEND` per press and one `RECEIVE` per landed switch, no `SEND` caused by a `RECEIVE`. |
| C-5 | Disable the page-2 anchor on P (PI → *Enabled* off). Flip P to page 2. | C does **not** move. Log: appear on P page 2 classified as disabled/ignored. Re-enable afterwards. |
| C-6 | Add override P page 1 ↔ C page 4, Save. Flip P to page 1. | C goes to page 4. Flip C to page 4 by hand from elsewhere → P goes to page 1. |
| C-7 | Unplug C. Flip P. | P flips normally; log: a `warn` naming C as disconnected/skipped. No error dialogs. |
| C-8 | Plug C back in (it shows its last page). | **Nothing moves** on reconnect. Log: C's appears classified as startup/ignored. Then flip P → C follows again. |
| C-9 | Simultaneously (as close as you can) flip P to page 0 and C to page 3. | Both end on **page 0** (parent wins). No oscillation. |
| C-10 | Remove C from the scope and Save. Flip P. | Nothing happens on C; log: a warning that P's scope has no other members / C has no scope (wording may differ). |

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

| Date | Machine / OS | Devices (P / C) | Stream Deck version | A3 | B | C-1…C-10 | D3 | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
