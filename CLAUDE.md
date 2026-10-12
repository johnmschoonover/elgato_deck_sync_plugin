# CLAUDE.md — Deck Sync

Guidance for Claude Code (primarily cloud sessions at claude.ai/code) working in this repo. The product spec is **[PRD.md](./PRD.md)** — it is the source of truth for *requirements*; this file is the source of truth for *how to work in the repo*. Read both before starting a task.

## What this is

Deck Sync is an Elgato Stream Deck plugin that syncs page navigation across multiple Stream Deck devices. Each device gets a **role** (parent/child) and devices are grouped into **scopes** (one parent, ≥1 child; multiple scopes coexist). Changing pages on any deck in a scope drives the others to their mapped pages, with the **parent authoritative**. TypeScript + Rollup; loaded by the Stream Deck app (v7.1+, Node 24).

### The model in one screen

- **Roles & scopes** live in global settings, not on individual pages. A **Page Anchor** is just a per-page marker so the plugin can *detect* navigation (there's no global page-change event).
- **Causal send/receive rule (core invariant, PRD §6.3):** a page change is a SEND or a RECEIVE, never both. Human navigation = SEND (broadcasts to the scope). A switch the plugin itself issued = RECEIVE-only (terminal, never rebroadcasts). Echo discrimination is **causal (in-flight tagging), not a timing debounce.**
- **Parent precedence:** any deck can lead, but a parent's change always wins and is never suppressed.
- **Mapping:** positional by default (page N → page N), with explicit bidirectional override pairs. The parent's page index is the scope's canonical coordinate: overrides pair a parent page with a child page, child↔child goes through the parent, and a pinned page has no positional counterpart (PRD §8.6).
- **Subpages/folders:** detecting entry works; *driving* a follower into a subpage is unverified — gated behind Spike-1. Until then, sync is top-level pages only.

## Project layout

```
├── PRD.md                                   # product spec (normative)
├── CLAUDE.md                                # this file
├── README.md                                # user guide: install, configure, read the log, troubleshoot
├── LICENSE / .gitignore                     # MIT; bin/, logs/ and node_modules/ are ignored
├── .claude/                                 # cloud-session settings + SessionStart hook (npm ci)
├── .github/workflows/ci.yml                 # typecheck + build + validate + test
├── docs/
│   ├── SYNC_ENGINE.md                       # engine design: classification order, precedence, GC, hardware risks
│   ├── PROFILES.md                          # bundled-profile authoring contract + manual procedure (D1)
│   ├── MANUAL_TESTS.md                      # hardware gate matrix (A3, B, C-1…C-17, D3)
│   └── SPIKE1.md                            # subpage-targeting spike: procedure + result slot
├── scripts/make-placeholder-icons.mjs       # regenerates imgs/ at spec sizes (npm run icons)
├── rollup.config.mjs                        # ESM bundle + emitted bin/package.json; `--failAfterWarnings` in the build script
├── tsconfig.json / tsconfig.test.json       # strict + native decorators; the test config (bundler resolution, DOM lib) also type-checks on its own with `tsc -p tsconfig.test.json`
├── jest.config.cjs                          # ts-jest with diagnostics off (jest does NOT type-check: `npm run typecheck` does), coverage thresholds
├── src/
│   ├── plugin.ts                            # entry: builds the engine over the SDK, registers the action, starts after connect
│   ├── syncEngine.ts                        # causal send/receive engine, parent precedence, startup guard, fan-out, logging
│   ├── settings.ts                          # global settings schema (PRD §6.5) + warn-not-throw validation, anchor settings
│   ├── mapping.ts                           # parent-canonical page mapping (positional + overrides)
│   ├── profiles.ts                          # device type → bundled profile name defaults
│   ├── piBridge.ts / piProtocol.ts          # PI protocol (devices, settings load/save with validation, save ids) + the global-settings read and event handler
│   ├── log.ts                               # logger contract
│   ├── actions/page-anchor.ts               # the Page Anchor action (SDK event → engine input)
│   ├── ids.ts                               # plugin/action UUIDs, checked against the manifest by a test
│   └── tests/                               # Jest: settings, mapping, engine, plugin wiring, PI bridge, PI page (jsdom), PI protocol contract, anchor adapter, profiles, assets, log, purity
└── com.johnmschoonover.decksync.sdPlugin/   # the plugin package
    ├── manifest.json
    ├── imgs/                                # placeholder icons (final art: Epic E4)
    ├── ui/anchor.html                       # marker settings + Deck Sync setup (global config) UI
    ├── profiles/                            # NOT PRESENT YET — created when D1's exported profiles land (docs/PROFILES.md)
    ├── logs/                                # plugin log files at runtime (gitignored)
    └── bin/                                 # build output (gitignored)
```

## Build, typecheck, test

```bash
npm ci                 # done automatically by the SessionStart hook in cloud sessions
npm run typecheck      # tsc --noEmit (plugin code, Node-only) && tsc -p tsconfig.test.json (the suites, jsdom) — the only type check of src/tests, since jest runs with diagnostics off
npm run build          # rollup -c → com.johnmschoonover.decksync.sdPlugin/bin/plugin.js
npm run validate       # streamdeck validate (official manifest + asset validator)
npm test               # jest (coverage thresholds enforced)
npm run icons          # regenerate placeholder icons (scripts/make-placeholder-icons.mjs)
```

CI runs the same four commands on every push/PR to `main`. Run them all before pushing.

- **Node.js v24** is the runtime target (declared in the manifest); CI covers 22.x and 24.x.
- TypeScript 5 strict, **native TC39 decorators**. Do **not** enable `experimentalDecorators`.
- There is no headless Stream Deck runtime — behaviour on real devices is verified by John (see below). `npm run watch` only works on a machine with the Stream Deck app in developer mode (`npx streamdeck dev`, once).

## Known issues / current state (October 2026)

Build, typecheck, validate and tests are green; every [agent] item in Epics A–C and E1–E3 is implemented (details in PRD §8). D2 (manifest `Profiles` wiring) waits on D1's exported files. Open items:

1. **No bundled profiles (D1, [gate]).** There is no `profiles/` directory; sync cannot be exercised on hardware until John exports real profiles per `docs/PROFILES.md`. The engine's default profile names match that document.
2. **Hardware verification pending** for plugin load, configuration persistence, real sync, startup guard, parent precedence, profile install and Spike-1 — `docs/MANUAL_TESTS.md`, `docs/SPIKE1.md`.
3. **Decisions to ratify**: every bullet in PRD §8.6 — overrides, `pageCount`, no settle window, stale-switch handling, no SD+ profile, per-device precedence, echo-tag expiry, later-switch-wins, the conflicting-anchor and overturned-switch breakers, carrier promotion, pre-start replay, the coalesced-burst cost (manual check C-16), switches kept as tags (cap, superseded, detached, left-page — PRD §8.6 "never forgotten"), anchor edits counting as position (not navigation), and profiles auto-switching on install (`DontAutoSwitchWhenInstalled` left false).
4. **Icons are placeholders** (`npm run icons` regenerates them); final art is Epic E4. Final UUID/author domain is OQ-6. The manifest has `Nodejs.Debug` enabled for development (raises log verbosity); remove it for release (E5).

## Conventions

- **Settings shape:** sync config (scopes, roles, mappings) lives in **global settings** (PRD §6.5). Per-anchor settings are just `pageIndex` + `enabled`. Keep types `JsonObject`-compatible as the SDK requires.
- **SDK API for sync:** `streamDeck.profiles.switchToProfile(deviceId, profile?, page?)`. `page` is a **flat 0-based index** — no subpage/folder addressing (PRD §4.2).
- **Profiles** must be bundled with the plugin and registered in `manifest.json` → `Profiles`; the SDK cannot switch to user-created profiles. Creating valid `.streamDeckProfile` bundles is a hardware task.
- **No on-disk profile editing.** Communicate only via the official WebSocket API.
- **Logging:** one `EVENT key=value …` line per event (formats in `docs/SYNC_ENGINE.md`): info for SEND/RECEIVE/STARTUP/SUPPRESSED, warn with an actionable clause for recoverable errors (profile not found, device offline, no page index). No unhandled exceptions on bad config — `validateGlobalSettings` returns issues, it never throws.
- **Engine purity:** `src/syncEngine.ts`, `settings.ts`, `mapping.ts`, `profiles.ts`, `log.ts`, `ids.ts` and `piProtocol.ts` import nothing from `@elgato/*` at runtime — `src/tests/purity.test.ts` enforces it (a type-only import such as `JsonObject` in `settings.ts`, from `@elgato/utils`, pinned as a devDependency, is erased); the SDK is touched only in `plugin.ts`, `piBridge.ts` and `actions/page-anchor.ts`. Keep it that way so every rule stays unit-testable. Time may only be used to age pending switches (expire/grace) — never to classify an appear or to trip the conflicting-anchor breaker (its run is counted structurally).
- **The Property Inspector** (`ui/anchor.html`) is plain inline JS with no build step; it is tested in `src/tests/pi.test.ts` under jsdom with a fake Stream Deck socket (the coverage figure jest reports covers `src/` only, not this script). Add a case there for every behaviour change. Saves carry an `id` the plugin echoes, so the panel never takes a stale or load reply for a confirmation. A renamed protocol event or field touches `piProtocol.ts`, `anchor.html` and `piBridge.ts` together — `src/tests/piContract.test.ts` pins the three to each other.
- **Logs** land in the `logs/` folder inside the installed `.sdPlugin` folder — the repo's `com.johnmschoonover.decksync.sdPlugin/logs/` (gitignored) when linked; line formats are listed in the README.
- Keep changes scoped to the task; don't refactor unrelated areas or bump dependency majors unless that is the task.

## Workflow

- One task per branch/PR, in the dependency order of PRD §9 (Epics A→E). Don't pull from a later epic while an earlier blocker is open.
- Leave the repo green: never push with a failing typecheck, build or test.
- If requirements are ambiguous or conflict with the code, stop and ask rather than guessing. Surface pending decisions (e.g. final plugin UUID, PRD §10 OQ-6) for John.
- In the PR description, record exactly what you ran and, for anything hardware-dependent, the manual test steps and device combo John should use.

## Verification boundary

PRD acceptance criteria are tagged **[agent]** (Claude proves headless) or **[gate]** (John verifies on real hardware). Never mark a [gate] AC done headless.

- **[agent]:** build exits 0 with no warnings; `tsc --noEmit` passes; manifest validates against `@elgato/schemas`; referenced icons resolve at the right dimensions; unit tests cover scope/role validation, mapping resolution, causal classification, parent precedence and the startup guard.
- **[gate]:** plugin loads in the Stream Deck app; real sync across a two-device scope with no ping-pong; nothing fires on launch; profile install prompts; icon rendering; Spike-1.
