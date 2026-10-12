# Deck Sync — Product Requirements Document

**Cross-Device Page Synchronization Plugin for Elgato Stream Deck**

| | |
|---|---|
| **Status** | Ready for execution (v2.0 — parent/child scope model) |
| **Author** | John Schoonover |
| **Editors** | Drafted by Summit (v0.1); hardened (v1.0); re-architected to the parent/child/scope model (v2.0) |
| **Last updated** | June 2026 |
| **Repo** | `deck_sync_plugin` |
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

`switchToProfile`'s `page` argument is a **flat page index from 0** (and requires Stream Deck app v6.5+, satisfied by our v7.1 floor). There is **no parameter to address a folder/subpage**. Consequences, confirmed against the SDK:

- **Detection of subpage navigation works.** `onWillAppear`/`onWillDisappear` fire when the user navigates to "another page, profile, **folder**, etc.", so a marker on a subpage lets the plugin know the user descended into it.
- **Driving a follower into a subpage is not supported by the public API.** The plugin can push a device to a profile + top-level page index, but cannot command it into a folder/subpage.
- **Open spike (§9 Spike-1):** whether the flat page index can reach folder pages at all is undocumented and must be confirmed on real hardware before any subpage-targeting behavior is committed. Until then, sync operates at **top-level page** granularity.

### 4.3 No global "page changed" event

The SDK has no event for "the active page changed." The plugin can only learn a device's current page from an action instance that fires `onWillAppear` when that page becomes active. **Therefore every syncable page needs a marker action on it** (the Page Anchor) for the plugin to detect navigation. Configuration (roles, scopes, mapping) lives in global settings; the marker itself is intentionally dumb — it reports that its page became active.

### 4.4 `onWillAppear` also fires on startup/reconnect

`onWillAppear` fires not only on deliberate navigation but on plugin start and device (re)connect (the docs note it fires "during startup if the action is on the front page"). Without a guard this would force unwanted switches on launch — see §7.3 and §8.4.

### 4.5 SDK / toolchain versions

- Stream Deck SDK **v2.1** (`@elgato/streamdeck`, resolved 2.1.0); Stream Deck app **v7.1+**.
- Node.js **v24** (manifest `Nodejs.Version`).
- TypeScript **5.x** with **native TC39 class decorators** — never legacy `experimentalDecorators`.
- Rollup build **must bundle the SDK's transitive CommonJS dependency `ws`** — currently broken (§8.1).

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
| **Page Anchor action** (`src/actions/page-anchor.ts`) | The per-page marker. Fires `onWillAppear`/`onWillDisappear` so the plugin can detect navigation. Stores only its **page identity** (e.g. page index/label) and an `enabled` toggle — *not* sync targets. |
| **Sync engine** (in the plugin) | Owns the runtime logic: receives marker appear events, applies the causal send/receive rule (§6.3), resolves mappings (§6.4), enforces parent precedence, and issues `switchToProfile` calls with echo tagging. |
| **Configuration UI** | Global-settings UI to assign device roles, build scopes, and set page mappings (positional default + overrides). May be a Property Inspector and/or a global settings page. |
| **Property Inspector** (`ui/anchor.html`) | Shown when a Page Anchor is selected; lets the user confirm/adjust the marker's page identity and enabled state. Must hydrate from saved settings (§8.3). |
| **Plugin entry** (`src/plugin.ts`) | Registers the action, connects to the Stream Deck WebSocket, wires the sync engine, and handles `onSendToPlugin` (e.g. `getDevices`). |
| **Bundled profiles** (`*.sdProfile`) | One bundled profile per supported device type, multi-page, pre-placed with Page Anchors. Registered in manifest `Profiles`, offered on install. |

### 6.3 Sync model — the causal send/receive rule

This is the heart of v1 behavior and **MUST** be implemented exactly:

1. **A page change is either a SEND or a RECEIVE, never both, decided by its cause.**
   - **Human-initiated navigation** (the user physically flips/turns/presses on a deck) is a **SEND**: the device broadcasts to the rest of its scope.
   - **A switch the plugin itself issued** (`switchToProfile`) produces a **RECEIVE-only** arrival on the target device. A received arrival is **terminal** — it never rebroadcasts. This is what prevents feedback loops, structurally.
2. **Echo discrimination is causal, not time-based.** The plugin tags every switch it initiates (an in-flight set keyed by device + target page) and swallows the matching `onWillAppear` echo. Any appear event that does *not* match a pending plugin-issued switch is treated as human-initiated → a SEND. **Do not implement this as a blind debounce** that could drop a legitimate human navigation.
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
  "scopes": [
    {
      "id": "scope-1",
      "name": "Desk",
      "parentDeviceId": "<device.id>",
      "members": [
        { "deviceId": "<device.id>", "role": "parent", "profile": "Deck Sync — SD+" },
        { "deviceId": "<device.id>", "role": "child",  "profile": "Deck Sync — Original" }
      ],
      "mapping": {
        "mode": "positional",                 // positional default
        "overrides": [                          // optional explicit pairs (bidirectional)
          { "a": { "deviceId": "...", "page": 2 }, "b": { "deviceId": "...", "page": 5 } }
        ]
      }
    }
  ]
}
```

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

- Sync events at **info**: initiating device, scope, resolved target(s), page, send/receive classification, success/failure.
- Recoverable errors (profile not found, device disconnected, no scope) at **warn** with actionable messages; no unhandled exceptions on bad config.

**AC [agent]:** unit/log-capture tests assert a SEND emits an info line with the classification and that bad config produces a warn, not a throw. **AC [gate]:** logs during real sync read clearly enough to debug a misconfiguration.

### 7.7 Required plugin assets

- **MUST** provide all manifest-referenced icons at Elgato's required sizes with `@2x` variants. Target sizes to confirm against current Marketplace guidance during the asset task; baseline expectations: action list icon **20×20** (`@2x` 40×40), key image **72×72** (`@2x` 144×144), category icon **28×28** (`@2x` 56×56), plugin/marketplace icon **288×288**. Placeholders unblock development; final art is a separate design task (Epic E).

**AC [agent]:** every manifest icon path resolves to a file of the expected dimensions. **AC [gate]:** icons render correctly in the actions list and category in the app.

## 8. Current Repository State & Known Gaps

_Last refreshed October 2026._ Epic A1, B1–B2 and C1–C5 have landed on `main`; the build, `tsc --noEmit` and the Jest suite are green. Spike-1 test scaffolding exists (`src/SPIKE1_FINDINGS.ts`) but its hardware result is still pending. Remaining gaps:

### 8.1 RESOLVED — build fails (`ws` not bundleable)

Fixed by adding `@rollup/plugin-commonjs` to the Rollup config (§7.1).

### 8.2 BLOCKER — missing icon assets

`manifest.json` references `imgs/plugin/category-icon`, `imgs/plugin/marketplace`, `imgs/actions/anchor/icon`, `imgs/actions/anchor/key`; no `imgs/` directory exists. Plugin won't validate/load until placeholders (correct sizes + `@2x`) are added (§7.7).

### 8.3 BUG — Property Inspector does not load saved settings

`ui/anchor.html` handles `didReceiveSettings` but never requests settings on connect nor reads the `inActionInfo` payload Stream Deck passes on load, so a configured marker can open blank. Fix to hydrate from `actionInfo.payload.settings` (and/or request settings on connect). Consider migrating to the official PI SDK / `sdpi-components` (§10 OQ-9).

### 8.4 Legacy per-anchor target fields

`page-anchor.ts` still honours the old `targetDeviceId`/`targetProfile` fields as a fallback path. They are to be replaced by `pageIndex` + global-settings-driven resolution (§6.5, task B3); don't extend them.

### 8.5 Not yet verified on hardware

Plugin load (A3), real sync behaviour, startup guard, bundled profile install (D1–D3) and Spike-1 all still need a **[gate]** pass.

## 9. Sequenced Build Plan (epics)

Dependency-ordered. Each epic is a candidate review gate.

**Epic A — Make it build & load.** A1 Fix Rollup `ws` bundling (§8.1). A2 Add placeholder icons at spec sizes (§7.7). A3 Confirm load in Stream Deck **[gate]**.

**Epic B — Roles, scopes & data model.** B1 Define global-settings schema (§6.5) + (de)serialization. B2 Scope/role validation + mapping resolution (positional + override) with unit tests. B3 Replace per-anchor target fields with `pageIndex`; fix PI hydration (§8.3). B4 Config UI for roles/scopes/mapping.

**Epic C — Sync engine.** C1 Causal send/receive with echo tagging (§6.3) + unit tests. C2 Parent precedence + conflict handling. C3 Startup/first-appear guard (§8.4). C4 Fan-out to scope members. C5 Logging (§7.6).

**Spike-1 — Subpage targeting [gate].** Run early-but-parallel; result decides whether §7.5 subpage sync is in or out. Does not block A–C.

**Epic D — Bundled profiles & zero-config UX.** D1 Author per-device multi-page bundled profiles with pre-placed anchors **[gate / manual procedure]** (§7.4 authoring note). D2 Manifest `Profiles` wiring + install prompt **[agent]**. D3 Validate install → customize → sync happy path **[gate]**.

**Epic E — Quality & release.** E1 Test suite + documented manual test matrix across device combos. E2 CI (build + typecheck). E3 README + open-source license. E4 Final icons/screenshots/demo per Marketplace requirements (depends on OQ-7). E5 Marketplace submission checklist + final UUID/author domain (OQ-6).

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
| OQ-9 | Hand-rolled PI WebSocket vs official PI SDK? | **Recommend the official PI SDK / `sdpi-components`**; acceptable to fix the raw implementation in B3 if migration is too costly. Decide at the Epic B gate. |
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
| GitHub | `deck_sync_plugin` (set org/visibility before release) |
| SDK docs | docs.elgato.com/streamdeck/sdk |
| SDK version | 2.1.0 (`@elgato/streamdeck`) |
| Node.js | v24 (manifest `Nodejs.Version`) |
| TypeScript | 5.x, native TC39 decorators (no `experimentalDecorators`) |
| Profile API | `switchToProfile(deviceId, profile?, page?)` — `page` is a flat index from 0; requires app v6.5+; no subpage parameter |
| Key events | `onWillAppear` / `onWillDisappear` — fire on navigating to another page/profile/folder, and on startup for front-page actions |
| Loop prevention | Causal send/receive with in-flight echo tagging (§6.3) |
| PI comms | `streamDeck.ui.sendToPropertyInspector(payload)` / `onSendToPlugin`; global settings API for scopes/roles/mapping |
| Manifest | `Actions[].VisibleInActionsList`, `Profiles[]` (bundled profile registration) |
