# Deck Sync — Product Requirements Document

**Cross-Device Page Synchronization Plugin for Elgato Stream Deck**

| | |
|---|---|
| **Status** | Ready for execution (v2.0 — parent/child scope model) |
| **Author** | John Schoonover |
| **Editors** | Drafted by Summit (v0.1); hardened (v1.0); re-architected to the parent/child/scope model (v2.0) |
| **Last updated** | October 2026 (§6.5 example, §8 and §10 refreshed; the v2.0 model is unchanged) |
| **Repo** | `johnmschoonover/elgato_deck_sync_plugin` |
| **Execution model** | Scoped tasks executed by Claude Code (cloud sessions), one branch/PR per task; John reviews at gates of his choosing (typically after a task set completes). |

> **How to read this document.** §1–6 are product and architecture context. §7 holds the normative feature requirements with **acceptance criteria (AC)** — the contract Claude builds against — each tagged **[agent]** (Claude can verify headless) or **[gate]** (requires John on real hardware). §8 records current repo state and blocking gaps. §9 is the sequenced build plan tasks are cut from. §10 records resolved decisions. **MUST** = hard requirement; **SHOULD** = strong default revisitable at a gate.

---

## 1. Overview

Deck Sync is an Elgato Stream Deck plugin that keeps multiple connected Stream Deck devices contextually in sync. The user assigns each physical device a **role** (parent or child) and groups devices into **scopes**. When the user navigates pages on one deck in a scope, the other decks in that scope follow to their corresponding pages — so flipping the parent to a "Bambu 3D printer" page can drive a child to a "Bambu Connect controls" page, and vice-versa, with the parent always authoritative.

The plugin targets multi-device setups (e.g. a Stream Deck + paired with a Stream Deck Original), runs entirely inside the Stream Deck app with no external software, and is intended for free, open-source distribution on the Elgato Marketplace (macOS and Windows).

## 2. Problem Statement

Power users who own multiple Stream Deck devices maintain parallel page structures across them — a "Home" layout, an app-specific layout, a communications layout, and so on. Stream Deck has no native mechanism to keep multiple connected devices in sync. When a user switches to a new page on one device, the others stay put, forcing manual navigation on each.

This friction compounds with page count: a user with several pages across two devices roughly doubles the navigation overhead for every context switch. As of June 2026 no Marketplace plugin addresses cross-device sync; the few commercial offerings are Windows-only static profile packages rather than sync solutions.

## 3. Goals & Non-Goals

### 3.1 Goals

- Let the user assign each device a **parent** or **child** role and organize devices into independent **scopes** (one parent per scope, one or more children; multiple scopes may coexist on the same machine).
- Automatically navigate the other devices in a scope to their mapped pages when the user changes pages on any device in that scope.
- Give the **parent** authoritative precedence: a parent page change always propagates to its children.
- Map pages **positionally by default** (page N → page N) with **explicit per-pair overrides** when decks don't line up.
- Prevent feedback loops structurally via a **causal send/receive rule** (see §6.3).
- Require no scripts, daemons, or external software beyond the Stream Deck app.
- Provide a configuration UI for roles, scopes, and mappings, plus a lightweight per-page marker action.
- Ship on the Elgato Marketplace as a free, open-source plugin for macOS and Windows.

### 3.2 Non-Goals (v1)

- Syncing button **state** or action output between devices (e.g. a mute toggle reflecting on the other device).
- Chained/transitive scopes (a child of one scope acting as parent of another). Scopes are flat in v1.
- Navigating to user-created profiles not bundled with the plugin (hard SDK constraint — §4.1).
- **Driving a follower into a folder/subpage** — pending the §4.2 spike; treated as out of scope unless the spike proves it works (§7.4, §9 Spike-1).
- A GUI profile/layout builder, cloud sync, or remote device control.

## 4. Key Constraints

### 4.1 SDK profile-switching limitation (hard constraint)

The Stream Deck SDK v2 exposes a single profile-navigation command:

```ts
streamDeck.profiles.switchToProfile(deviceId: string, profile?: string, page?: number): Promise<void>
```

It switches **only** to profiles bundled inside the plugin's own `.sdPlugin` directory and registered in the manifest `Profiles` array; it **cannot** navigate to user-created profiles. (Confirmed against the installed SDK types and `@elgato/schemas`.) This shapes the UX: users build their layouts *inside* Deck Sync's bundled profiles, not their own freeform profiles.

### 4.2 Page addressing — flat index only; subpages unverified

`switchToProfile`'s `page` argument is a **flat page index from 0** (the Elgato SDK documentation says it requires Stream Deck app v6.5+, satisfied by our v7.1 floor; the installed type definitions only document the index). There is **no parameter to address a folder/subpage**. Consequences, confirmed against the installed SDK:

- **Detection of subpage navigation works.** `onWillAppear`/`onWillDisappear` fire when the user navigates to "another page, profile, **folder**, etc.", so a marker on a subpage lets the plugin know the user descended into it.
- **Driving a follower into a subpage is not supported by the public API.** The plugin can push a device to a profile + top-level page index, but cannot command it into a folder/subpage.
- **Open spike (§9 Spike-1):** whether the flat page index can reach folder pages at all is undocumented and must be confirmed on real hardware before any subpage-targeting behavior is committed. Until then, sync operates at **top-level page** granularity.

### 4.3 No global "page changed" event

The SDK has no event for "the active page changed." The plugin can only learn a device's current page from an action instance that fires `onWillAppear` when that page becomes active. **Therefore every syncable page needs a marker action on it** (the Page Anchor) for the plugin to detect navigation. Configuration (roles, scopes, mapping) lives in global settings; the marker itself is intentionally dumb — it reports that its page became active.

### 4.4 `onWillAppear` also fires on startup/reconnect

`onWillAppear` fires not only on deliberate navigation but on plugin start and device (re)connect (the docs note it fires "during startup if the action is on the front page"). Without a guard this would force unwanted switches on launch — see §7.3, §8.6 ("No settle window") and `docs/SYNC_ENGINE.md`.

### 4.5 SDK / toolchain versions

- Stream Deck SDK **v2.1** (`@elgato/streamdeck`, resolved 2.1.0); Stream Deck app **v7.1+**.
- Node.js **v24** (manifest `Nodejs.Version`).
- TypeScript **5.x** with **native TC39 class decorators** — never legacy `experimentalDecorators`.
- Rollup build **must bundle the SDK's transitive CommonJS dependency `ws`** — done via `@rollup/plugin-commonjs` (§8.1, resolved).

### 4.6 No on-disk profile editing

The plugin communicates exclusively via the official WebSocket API and never writes profile files on disk (such edits are overwritten on app quit).

## 5. Target Users

| Segment | Description |
|---|---|
| **Primary** | Stream Deck power users who own two or more devices and maintain parallel page structures across them. |
| **Secondary** | Content creators and streamers who context-switch frequently (gaming → recording → communication) and want devices to follow automatically. |
| **Tertiary** | Developers and enthusiasts who want a working reference implementation of a multi-device SDK plugin. |

## 6. Architecture

### 6.1 Roles and scopes

- Each connected device is assigned a **role**: **parent** or **child** (or unassigned, in which case it does not sync).
- Devices are grouped into **scopes**. A scope has **exactly one parent** and **one or more children**.
- **Multiple scopes can coexist.** Four devices could form two independent parent→child pairs, or one parent with three children, etc. A child belongs to exactly one scope and knows its parent.
- Scopes, roles, and mappings are defined in the plugin's **global settings** UI and persisted via the global settings API.

### 6.2 Components

| Component | Responsibility |
|---|---|
| **Page Anchor action** (`src/actions/page-anchor.ts`) | The per-page marker. Fires `onWillAppear`/`onWillDisappear` so the plugin can detect navigation, and forwards `onDidReceiveSettings` (its page index or enabled flag edited in the Property Inspector) to the engine as a position update, never as navigation (`engine.onAnchorUpdated`). Stores only its **page identity** (`pageIndex`) and an `enabled` toggle — *not* sync targets. |
| **Sync engine** (`src/syncEngine.ts`, with `settings.ts`, `mapping.ts`, `profiles.ts`) | Owns the runtime logic: receives marker appear events, applies the causal send/receive rule (§6.3), resolves mappings (§6.4), enforces parent precedence, and issues `switchToProfile` calls with echo tagging. Pure TypeScript; the SDK is injected (`docs/SYNC_ENGINE.md`). |
| **Configuration UI** | Global-settings UI to assign device roles, build scopes, and set page mappings (positional default + overrides). Lives in the Page Anchor's Property Inspector, since Stream Deck has no plugin-level settings page. |
| **Property Inspector** (`ui/anchor.html`) | Shown when a Page Anchor is selected; lets the user confirm/adjust the marker's page identity and enabled state and hosts the configuration UI. Hydrates from saved settings (§8.3, resolved). |
| **Plugin entry** (`src/plugin.ts`) | Builds the engine over the SDK, registers the action, connects, forwards device and settings events, starts the engine after connect. PI messages (`getDevices`, `getGlobalSettings`, `setGlobalSettings`) are handled by `src/piBridge.ts` (`src/piProtocol.ts`). |
| **Bundled profiles** (`profiles/<device>.streamDeckProfile`) | One bundled profile per supported device type, multi-page, pre-placed with Page Anchors. Registered in manifest `Profiles`, offered on install. Authored on hardware (`docs/PROFILES.md`). |

### 6.3 Sync model — the causal send/receive rule

This is the heart of v1 behavior and **MUST** be implemented exactly:

1. **A page change is either a SEND or a RECEIVE, never both, decided by its cause.**
   - **Human-initiated navigation** (the user physically flips/turns/presses on a deck) is a **SEND**: the device broadcasts to the rest of its scope.
   - **A switch the plugin itself issued** (`switchToProfile`) produces a **RECEIVE-only** arrival on the target device. A received arrival is **terminal** — it never rebroadcasts. This is what prevents feedback loops, structurally.
2. **Echo discrimination is causal, not time-based.** The plugin tags every switch it initiates (an in-flight set keyed by device + target page — implemented as an ordered per-device queue with supersede and expiry semantics, §8.6 and `docs/SYNC_ENGINE.md`) and swallows the matching `onWillAppear` echo. Any appear event that does *not* match a pending plugin-issued switch is treated as human-initiated → a SEND. **Do not implement this as a blind debounce** that could drop a legitimate human navigation.
3. **Parent precedence.** A parent's human-initiated SEND is authoritative: it is never suppressed and overrides anything in flight. Children may also SEND (peer follow is allowed), but in any conflict the parent wins. (A child-initiated change is a convenience; a parent-initiated change is a guarantee that all children follow.)
4. **Subpages.** Detecting the user entering a subpage is supported (§4.2) and counts as a human navigation; *driving* others into a subpage is deferred pending Spike-1.

### 6.4 Page mapping

- **Positional by default:** within a scope, page index N on one device maps to page index N on the others. Zero configuration when decks are arranged in the same order.
- **Explicit overrides:** the user can pin specific pairs (e.g. parent page 2 ↔ child page 5) in the config UI for decks whose pages don't line up or have different counts.
- **Mappings are bidirectional edges.** A pinned pair holds regardless of which side initiates (consistent with §6.3 peer follow + parent precedence).

### 6.5 Data model

**Global settings (plugin-wide):**

```jsonc
{
  "version": 2,                                        // missing or {} (a fresh install) loads defaults silently; any other version is unusable: defaults at start-up, the current configuration kept afterwards, a PI save rejected (warn in those cases)
  "scopes": [
    {
      "id": "scope-1",
      "name": "Desk",
      "parentDeviceId": "<device.id>",                   // derived from the parent member when blank — when present it must name the parent member, or the whole scope is ignored
      "members": [
        { "deviceId": "<device.id>", "role": "parent", "profile": "profiles/plus", "pageCount": 5 },
        { "deviceId": "<device.id>", "role": "child",  "profile": "profiles/original" }
        // profile = manifest Profiles[].Name, defaulted by device type when blank; pageCount defaults to 5
      ],
      "mapping": {
        "mode": "positional",                            // positional default
        "overrides": [                                     // optional pins: a = a parent page, b = a child page (bidirectional)
          { "a": { "deviceId": "<parent>", "page": 2 }, "b": { "deviceId": "<child>", "page": 4 } }
        ]
      }
    }
  ]
}
```

Invalid scopes are dropped individually with a warning when the settings are loaded; the rest are kept. A save from the Property Inspector is rejected as a whole while any issue remains, so the panel can show what to fix.

**Per Page Anchor instance settings:**

| Field | Type | Description |
|---|---|---|
| `pageIndex` | `number` | 0-indexed identity of the page this marker sits on, used to resolve mappings. In bundled profiles this is pre-set; users may confirm/adjust it. |
| `enabled` | `boolean` | Lets the user disable sync from this page without deleting the marker. Default `true`. |

> Field names above are the intended contract; minor naming is at implementation discretion as long as behavior and persistence match. The sync engine derives a device's scope/role/profile from global settings, not from per-anchor settings.

### 6.6 Event flow (example)

1. User flips the **parent** (SD+) from "Bambu" (page 1) to "AI" (page 3) — a human navigation → **SEND**.
2. The "AI"-page Page Anchor fires `onWillAppear`; the engine sees no pending plugin-issued switch for that device/page → treats it as a SEND.
3. Engine looks up the parent's scope, resolves page 3 → each child's mapped page (positional or override).
4. For each child, engine calls `switchToProfile(childDeviceId, childProfile, mappedPage)` and tags the expected arrival as an echo.
5. Each child navigates; its marker fires `onWillAppear`, matches the pending echo → **RECEIVE-only**, no rebroadcast. No loop.
6. (Reverse) If the user instead flips a child to "Bambu Connect," the same flow runs child→parent, but if the parent also changes near-simultaneously, the parent's change wins.

## 7. Feature Requirements

> Each AC is tagged **[agent]** (Claude verifies headless: build, typecheck, schema validation, unit tests) or **[gate]** (John verifies on real hardware in the Stream Deck app). See §9 "Verification responsibilities."

### 7.1 Build & toolchain (foundational)

- **MUST** produce a loadable bundle via `npm run build` with zero errors, correctly bundling `ws` (§8.1). Concretely: add `@rollup/plugin-commonjs` to devDependencies and the Rollup `plugins` array (ordered after `nodeResolve`, before/with `typescript` per the `@elgato/cli` template); confirm Node built-ins resolve.
- **MUST** keep TypeScript strict and native decorators; no `experimentalDecorators`.

**AC [agent]:** `npm run build` exits 0 and emits `bin/plugin.js`; `tsc --noEmit` passes. **AC [gate]:** plugin loads in Stream Deck with no manifest/asset warnings.

### 7.2 Roles, scopes & configuration UI

- User can assign each connected device a role (parent / child / unassigned).
- User can create scopes (one parent, ≥1 child) and assign members; multiple scopes coexist.
- User can choose positional mapping (default) and add explicit override pairs.
- Each child resolves its parent and scope; a device may belong to at most one scope.
- Settings persist via the global settings API and survive app restart.

**AC [agent]:** global-settings shape validates and round-trips through (de)serialization; unit tests cover scope/role validation (rejects two parents in a scope, a device in two scopes, etc.) and mapping resolution (positional + override). **AC [gate]:** the config UI lets John build a two-device scope and see it persist across an app restart.

### 7.3 Page Anchor action & sync engine

- Marker fires on `onWillAppear`; engine applies the causal send/receive rule (§6.3) — human navigation SENDs, plugin-issued arrivals are RECEIVE-only.
- Echo discrimination is causal (in-flight tagging), not a blind debounce.
- Parent precedence enforced (§6.3.3).
- `enabled === false` on a marker suppresses SEND from that page.
- **MUST NOT** fire a sync caused solely by plugin/device startup or reconnect (§4.4) — first-appear/settle guard required.
- Mapping resolved per §6.4; fan-out to all other scope members.

**AC [agent]:** unit tests prove: (a) a plugin-issued arrival produces no outbound switch; (b) a human-tagged arrival fans out to the correct mapped pages; (c) parent change overrides an in-flight child change; (d) startup appears are suppressed; (e) disabled markers don't SEND. **AC [gate]:** on hardware, flipping the parent drives the child to the mapped page; flipping the child drives the parent; rapid back-and-forth shows no ping-pong; nothing fires on app launch.

### 7.4 Bundled starter profiles

- One bundled multi-page profile per supported device type (Original/MK.2 15-key, XL 32-key, Mini 6-key, Neo 8-key), default page count per §10 OQ-2, each page pre-placed with a Page Anchor carrying its `pageIndex`.
- Registered in manifest `Profiles`; offered to the user on install.
- Naming convention: `Deck Sync — [Device]`.
- **Authoring note:** `.sdProfile` bundles are normally exported from the Stream Deck app, not authored by hand. Producing valid bundles is expected to require John on hardware (a **[gate]** task or a documented manual procedure), not a headless agent task. Claude owns the manifest `Profiles` wiring and the marker placement contract; profile bundle creation is gated.

**AC [agent]:** manifest `Profiles` entries validate against `@elgato/schemas`; the install/registration wiring builds. **AC [gate]:** on install with two supported devices, Stream Deck prompts to add the profiles, they appear under Preferences → Profiles, and after the user only customizes button content, bidirectional sync works for the default positional topology.

### 7.5 Subpage spike (gates the subpage feature)

- Before any subpage-targeting behavior is built, run **Spike-1** (§9): on real hardware, determine whether `switchToProfile(deviceId, profile, page)` can address a folder/subpage via the flat page index, and whether subpage `onWillAppear` provides enough identity to map reliably.

**AC [gate]:** documented result (works / doesn't / partial) plus a recommendation. If it doesn't work, subpage sync stays a Non-Goal and contexts are modeled as top-level pages.

### 7.6 Logging

- Sync events at **info**: initiating device, scope, resolved target(s), page, send/receive classification, success/failure. Success is the target's RECEIVE line (the SDK only confirms that a switch request was written, which is logged at debug); failure to switch is warn.
- Recoverable errors (profile not found, device disconnected, no scope) at **warn** with actionable messages; no unhandled exceptions on bad config.

**AC [agent]:** unit/log-capture tests assert a SEND emits an info line with the classification and that bad config produces a warn, not a throw. **AC [gate]:** logs during real sync read clearly enough to debug a misconfiguration.

### 7.7 Required plugin assets

- **MUST** provide all manifest-referenced icons at Elgato's required sizes with `@2x` variants. Target sizes to confirm against current Marketplace guidance during the asset task; baseline expectations: action list icon **20×20** (`@2x` 40×40), key image **72×72** (`@2x` 144×144), category icon **28×28** (`@2x` 56×56), plugin/marketplace icon **288×288**. Placeholders unblock development; final art is a separate design task (Epic E).

**AC [agent]:** every manifest icon path resolves to a file of the expected dimensions. **AC [gate]:** icons render correctly in the actions list and category in the app.

## 8. Current Repository State & Known Gaps

_Last refreshed October 2026._ Every **[agent]** item in Epics A–C and E1–E3 has landed: placeholder icons and the official validator in CI (A2), the §6.5 settings schema with warn-not-throw validation and parent-canonical mapping (B1–B2), the Page Anchor reduced to `pageIndex` + `enabled` with PI hydration fixed (B3), a working configuration UI (B4), the causal sync engine with echo tagging, parent precedence, startup guard, fan-out and logging (C1–C5, design in `docs/SYNC_ENGINE.md`), a Jest suite covering every [agent] AC, CI, README and license. Build, `tsc --noEmit`, `streamdeck validate` and the suite are green.

An earlier revision of this section recorded B1–B2 and C1–C5 as landed; that code implemented a named-profile broadcast with a 2-second timer debounce rather than §6.3 and was replaced wholesale.

### 8.1 RESOLVED — build fails (`ws` not bundleable)

Fixed by adding `@rollup/plugin-commonjs` to the Rollup config (§7.1).

### 8.2 RESOLVED (placeholders) — icon assets

`scripts/make-placeholder-icons.mjs` generates every manifest image at the §7.7 sizes with `@2x` variants; `npm run validate` (the official `streamdeck validate`) passes and runs in CI. Final artwork remains Epic E4.

### 8.3 RESOLVED — Property Inspector hydration

`ui/anchor.html` hydrates from the `actionInfo` payload Stream Deck passes on connect and from `didReceiveSettings`. It stays hand-rolled (OQ-9's fallback); the global configuration UI lives in the same PI because Stream Deck has no plugin-level settings page.

### 8.4 RESOLVED — legacy per-anchor target fields

Removed. Anchors store `pageIndex` + `enabled`; legacy fields are ignored.

### 8.5 OPEN — bundled profiles (D1, **[gate]**)

No bundled profiles exist. The four hand-written JSON files previously in `profiles/` could never install (exported profiles are zip archives) and were removed with their manifest entries so the plugin validates and loads cleanly. Until John exports real profiles per `docs/PROFILES.md`, the app either ignores each switch request (a `SWITCH unconfirmed dev=… profile=… — no appear within 3000ms …` warning, written the next time the engine touches that device at least 3 s later) or rejects it (`SWITCH failed`) — sync cannot be exercised on hardware before D1. The engine's default profile names (`profiles/original|mini|xl|neo`) match the names that document specifies.

### 8.6 Implementation decisions to ratify at the next gate

- **Overrides pair a parent page with a child page** (§6.4's example); child↔child mapping is derived through the parent's page, and a pinned page has no positional counterpart, so mappings are one-to-one in both directions. Two independent designs chose this; it is validated in `src/settings.ts`.
- **`pageCount` per scope member** (default 5 per OQ-2) bounds positional mapping so the engine never targets a page a profile does not have.
- **No settle window.** The startup guard is a per-device armed flag: the first appear after start or (re)connect never syncs.
- **Stale-switch handling.** A switch still in flight (expected, or detached by a settings change) that lands after a device's own later human navigation (a SEND, or a navigation ignored as disabled, unscoped or by either breaker) is swallowed and that page restored. This is how "a parent's SEND overrides anything in flight" is realised (`docs/SYNC_ENGINE.md`).
- No Stream Deck + profile is in the §7.4 list although §6.6's example uses an SD+ as parent; with an SD+ in a scope its `profile` must be set explicitly until one is bundled.
- **Parent precedence is per device, not scope-wide.** A child is suppressed only while a parent-issued switch *to that child* is still expected; once it has landed the child may lead again even if a sibling's switch is still in flight. The alternative — treating the parent's send as in flight until every child acknowledges — stalls every child behind one that never acknowledges. One of the two independent designs preferred scope-wide; ratify.
- **Unconfirmed switches stay echo tags.** After 3 s an unconfirmed switch stops suppressing children, stops counting as the device's position and can no longer trigger a restore, but it remains an echo tag until 30 s after it was issued, so a late landing (app stall, sleep/wake) can never be mistaken for human navigation and rebroadcast. The bounded cost: a human navigation to exactly that page within the window is swallowed once — never reverted after the TTL (`docs/SYNC_ENGINE.md`); hardware checks C-11/C-12 in `docs/MANUAL_TESTS.md`.
- **Stale switches are undone only when nothing later is coming.** A still-expected switch that lands after the device's own later navigation is swallowed and the human's last page restored, unless a switch issued after that navigation (e.g. the parent's) is already heading for the device — then the later switch wins.
- **Conflicting-anchor breaker.** A page reporting two page indices — a second index appearing before the first has disappeared, or two indices disappearing together — is a *conflict*: the signature of a copied anchor with the wrong page index. Once a device's run of conflicts exceeds 12 its sends are ignored with a warning until it passes a page with a single anchor, however slowly the app applies switches and whichever anchor it reports first (the run is counted, not timed). Ordinary flipping never accumulates: if the app reports the new page before the old page's disappear a flip counts as one conflict for a moment, and the single-index disappear that follows resets the run. So no human navigation is rate-limited in either event order (`docs/SYNC_ENGINE.md`).
- **Driven-send breaker (children only).** Wrong page indices that keep a cycle alive without ever showing two indices on a page — one wrong anchor per child across three children, or pages cross-labelled across two — escape the conflict breaker. Every send in such a loop is *driven*: made while another deck's switch to a different page of the device (issued after its last landing) has not shown, or from a page a switch landed on. People make driven sends too, but soon make a clean one (nothing outstanding, no landing on the visit, the only index on it); a loop never does. Once a child has made 13 driven sends in a row its sends are ignored with a warning until it makes a clean flip — a landing never lifts the cut-off, because the loop's own landings would. Every cycle has a child sending in turn, so this suffices; the parent is never cut off (§6.3.3). The accepted cost: a child flipped 13 times within 30 s after a switch to it that could never show (a page without an anchor, a sibling's coalesced burst), with no clean flip between, is cut off until its next clean flip. With two decks a single wrong anchor per deck cannot cycle at all: a re-emit of a shown page is read as a duplicate, and otherwise a mislabelled landing meets the deck's own echo tag within a few hops.
- **Carrier promotion.** When a parent's flip finds a target already heading for the right page because of a switch the parent did not issue (a child's, or the device's own stale-switch restore), that switch is promoted to parent origin (and, if a settings change had detached it, expected again): the child stays suppressed until it lands, as if the parent had issued it.
- **Navigation before the settings load is replayed as if settled.** Appears that arrive between the plugin connecting and its settings loading are queued (the startup burst still arms devices). Nothing was in flight then, so they never conflicted: once `start()` has the configuration they are replayed in order through the normal rules, except that a replayed fan-out leaves alone any device whose own later flip is still to be replayed (so a child's later flip is never suppressed by a switch the replay itself created, and a parent's earlier flip still reaches everyone else even when the later flip leads nobody), and a page a device had left again before start is forgotten after its replay. The queue keeps the newest 20 flips, and a device's queued flips are discarded if it disconnects before start. Ratified with it: a parent/child cross-fire before start ends on the later flip's page, the child's included — live, the child's flip would have been suppressed while the parent's switch was expected, but the queue keeps no timing and the replay creates nothing in flight.
- **A coalesced parent burst can cost a child its flips for 3 s.** While a parent-issued switch to a child is still expected (3 s), the child's flip to any page is suppressed (§6.3.3). If the app coalesces a quick parent burst so the child never shows the intermediate page, those tags dangle for the TTL and every child flip in that window is lost (the child shows its page, nobody follows; the next flip after the 3 s TTL syncs). The engine cannot tell that case from a switch still being applied; manual check C-16 measures how often it happens and whether `pendingTtlMs` should change. The TTL and the other engine knobs are constructor options set in `src/plugin.ts` (`docs/SYNC_ENGINE.md` hardware item 2b), not user settings.
- **Editing a visible anchor updates the engine's view of its device.** A page-index or enabled change made in a Page Anchor's Property Inspector is treated as "this device is on that page" (recorded, armed, a pending switch to that index taken as landed when it is the oldest switch the engine still remembers for the device) and never as navigation; the panel saves the index once the edit is finished (Tab or a click elsewhere), so a half-typed "1" on the way to "12" never reaches the engine. Without it a corrected index would be unknown until the page's next appear.
- **Bundled profiles auto-switch on install.** When D2 registers the profiles, the `manifest.json → Profiles` entries will leave `DontAutoSwitchWhenInstalled` at its default (false), so installing the plugin switches each device to its bundled profile — the zero-config path §7.4 asks for. Set it to true if the D3 gate shows that is unwelcome.
- **Switches are never forgotten while they can still land.** One expired echo tag per page is kept per device; past 50 still-expected switches to one device the oldest become tags too; the app applies switches in order, so a landing matches the oldest switch to its page, a switch a landing passes by (issued before the one that landed and never shown — coalesced, or a repeat of the landed page with no other page between) stays a tag for one TTL, and every switch issued after the one that landed stays expected until it lands or expires (a slow backlog lands as RECEIVEs throughout, a burst 1→3→1 that has shown 1 still shows 3 and 1); a switch to a page the device left before it showed, with no RECEIVE or earlier queued switch explaining the departure, stays a tag for the grace period; a settings change detaches only a switch whose origin lost its standing (a rename or mapping change costs the parent nothing), and a detached switch is still undone if it lands after the device's own later navigation. So neither the cap, nor a coalesced burst, nor a stalled app applying its backlog late, nor a reload can turn a landing into a SEND or leave the scope split. The cost is the face-1 swallow above: a quick flip to a page the app skipped is swallowed once.

### 8.7 Not yet verified on hardware

Plugin load (A3), configuration persistence (B gate), real sync behaviour, startup guard, parent precedence, bundled profile install (D1–D3) and Spike-1 all still need a **[gate]** pass — steps in `docs/MANUAL_TESTS.md` and `docs/SPIKE1.md`.

## 9. Sequenced Build Plan (epics)

Dependency-ordered. Each epic is a candidate review gate.

**Epic A — Make it build & load.** A1 Fix Rollup `ws` bundling (§8.1). A2 Add placeholder icons at spec sizes (§7.7). A3 Confirm load in Stream Deck **[gate]**.

**Epic B — Roles, scopes & data model.** B1 Define global-settings schema (§6.5) + (de)serialization. B2 Scope/role validation + mapping resolution (positional + override) with unit tests. B3 Replace per-anchor target fields with `pageIndex`; fix PI hydration (§8.3). B4 Config UI for roles/scopes/mapping.

**Epic C — Sync engine.** C1 Causal send/receive with echo tagging (§6.3) + unit tests. C2 Parent precedence + conflict handling. C3 Startup/first-appear guard (§8.6). C4 Fan-out to scope members. C5 Logging (§7.6).

**Spike-1 — Subpage targeting [gate].** Run early-but-parallel; result decides whether §7.5 subpage sync is in or out. Does not block A–C.

**Epic D — Bundled profiles & zero-config UX.** D1 Author per-device multi-page bundled profiles with pre-placed anchors **[gate / manual procedure]** (§7.4 authoring note). D2 Manifest `Profiles` wiring + install prompt **[agent]**. D3 Validate install → customize → sync happy path **[gate]**.

**Epic E — Quality & release.** E1 Test suite + documented manual test matrix across device combos. E2 CI (typecheck + build + validate + test, Node 22/24). E3 README + open-source license. E4 Final icons/screenshots/demo per Marketplace requirements (depends on OQ-7). E5 Marketplace submission checklist + final UUID/author domain (OQ-6).

### Verification responsibilities

- **Claude [agent]:** anything provable headless — build success, `tsc --noEmit`, manifest validation against `@elgato/schemas`, unit tests for schema/validation/mapping/engine logic, asset dimension checks. Claude leaves the repo green and records what it ran.
- **John [gate]:** anything requiring the Stream Deck app or physical devices — plugin load, real sync behavior, profile install prompts, subpage spike, icon rendering. Claude prepares these with exact manual test steps; John executes at a gate.

Pure logic (mapping resolution, causal classification, parent precedence, guard timing) **MUST** be unit-tested. Hardware behavior is documented as a manual matrix (≥1 macOS, ≥1 Windows; ideally two physical devices).

## 10. Resolved Decisions

| ID | Question | Decision for v1 |
|---|---|---|
| OQ-1 | Support >2 devices? | **Yes**, via scopes: one parent + N children, multiple scopes coexisting. Chained/transitive scopes remain a Non-Goal. |
| OQ-2 | Default bundled page count? | **5 pages** per device type; cheap to change later. Revisit configurability post-v1. |
| OQ-3 | Hide the marker from the actions list? | **Keep visible** so users can place markers on custom pages. Revisit if confusing. |
| OQ-4 | Device disconnect mid-session? | Skip disconnected members gracefully + warn-log. On-button indicator deferred. |
| OQ-5 | Feedback loop? | Solved by the **causal send/receive rule** (§6.3), not a debounce. Hard v1 requirement. |
| OQ-6 | Plugin UUID / author domain? | **John decides before Marketplace submission** (Epic E). Placeholder `com.johnmschoonover.decksync` is fine for dev; don't block earlier epics. |
| OQ-7 | Marketplace timeline & required assets? | **Research in Epic E** (icon sizes, screenshots, demo, review SLA). Doesn't block A–D. |
| OQ-8 | Suppress sync on startup/reconnect? | **Yes** — first-appear/settle guard (Epic C3). |
| OQ-9 | Hand-rolled PI WebSocket vs official PI SDK? | **Decided (B3/B4, §8.3): the hand-rolled PI was fixed and kept** — it hydrates, hosts the configuration UI and is tested headless under jsdom (`src/tests/pi.test.ts`). Migrating to `sdpi-components` is a future consideration, not a blocker. |
| OQ-10 | Page mapping model? | **Positional by default, explicit overrides**; mappings are bidirectional edges (§6.4). |
| OQ-11 | Sync direction within a scope? | **Peer follow with parent precedence** (§6.3.3): any deck can lead, parent always wins. |
| OQ-12 | Subpage/folder sync? | **Gated on Spike-1** (§7.5). Detection works; driving a follower into a subpage is unverified and out of scope unless the spike proves it. |

## 11. Future Considerations

- Configurable per-device page counts and richer scope topologies (incl. chained scopes).
- "Page index" auto-inference so markers self-identify their `pageIndex` from position, reducing setup.
- Subpage/folder sync if Spike-1 is favorable.
- Stream Deck Mobile (iOS/Android) as a scope member.
- A companion tool that converts an existing custom profile into Deck Sync's bundled format.
- On-button connection/health indicator (OQ-4).

## Appendix — Technical references

| Item | Detail |
|---|---|
| GitHub | `johnmschoonover/elgato_deck_sync_plugin` (set visibility before release) |
| SDK docs | docs.elgato.com/streamdeck/sdk |
| SDK version | 2.1.0 (`@elgato/streamdeck`) |
| Node.js | v24 (manifest `Nodejs.Version`) |
| TypeScript | 5.x, native TC39 decorators (no `experimentalDecorators`) |
| Profile API | `switchToProfile(deviceId, profile?, page?)` — `page` is a flat index from 0; requires app v6.5+ per the SDK documentation (not stated in the installed types); no subpage parameter |
| Key events | `onWillAppear` / `onWillDisappear` — fire on navigating to another page/profile/folder, and on startup for front-page actions; `onDidReceiveSettings` — a Page Anchor's settings were edited in its Property Inspector (an engine position update, `onAnchorUpdated`, never a navigation) |
| Loop prevention | Causal send/receive with in-flight echo tagging (§6.3) |
| PI comms | `streamDeck.ui.sendToPropertyInspector(payload)` / `onSendToPlugin`; global settings API for scopes/roles/mapping |
| Manifest | `Profiles[]` (bundled profile registration, added at D2); `Actions[].VisibleInActionsList` left at its default per OQ-3 |
