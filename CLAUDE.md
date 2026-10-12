# CLAUDE.md — Deck Sync

Guidance for Claude Code (primarily cloud sessions at claude.ai/code) working in this repo. The product spec is **[PRD.md](./PRD.md)** — it is the source of truth for *requirements*; this file is the source of truth for *how to work in the repo*. Read both before starting a task.

## What this is

Deck Sync is an Elgato Stream Deck plugin that syncs page navigation across multiple Stream Deck devices. Each device gets a **role** (parent/child) and devices are grouped into **scopes** (one parent, ≥1 child; multiple scopes coexist). Changing pages on any deck in a scope drives the others to their mapped pages, with the **parent authoritative**. TypeScript + Rollup; loaded by the Stream Deck app (v7.1+, Node 24).

### The model in one screen

- **Roles & scopes** live in global settings, not on individual pages. A **Page Anchor** is just a per-page marker so the plugin can *detect* navigation (there's no global page-change event).
- **Causal send/receive rule (core invariant, PRD §6.3):** a page change is a SEND or a RECEIVE, never both. Human navigation = SEND (broadcasts to the scope). A switch the plugin itself issued = RECEIVE-only (terminal, never rebroadcasts). Echo discrimination is **causal (in-flight tagging), not a timing debounce.**
- **Parent precedence:** any deck can lead, but a parent's change always wins and is never suppressed.
- **Mapping:** positional by default (page N → page N), with explicit bidirectional override pairs.
- **Subpages/folders:** detecting entry works; *driving* a follower into a subpage is unverified — gated behind Spike-1. Until then, sync is top-level pages only.

## Project layout

```
├── PRD.md                                   # product spec (normative)
├── CLAUDE.md                                # this file
├── .claude/                                 # cloud-session settings + SessionStart hook (npm ci)
├── .github/workflows/ci.yml                 # typecheck + build + test
├── src/
│   ├── plugin.ts                            # entry: registers action, connects
│   ├── globalSettings.ts                    # scopes/roles/mapping schema + (de)serialization
│   ├── scopeManager.ts                      # causal send/receive engine, parent precedence, fan-out
│   ├── actions/page-anchor.ts               # the Page Anchor action
│   ├── SPIKE1_FINDINGS.ts                   # subpage-targeting spike notes
│   └── tests/                               # Jest tests + SDK mocks
└── com.johnmschoonover.decksync.sdPlugin/   # the plugin package
    ├── manifest.json
    ├── ui/                                  # Property Inspector UIs
    ├── profiles/                            # bundled per-device profiles
    └── bin/                                 # build output (gitignored)
```

## Build, typecheck, test

```bash
npm ci                 # done automatically by the SessionStart hook in cloud sessions
npm run typecheck      # tsc --noEmit (strict)
npm run build          # rollup -c → com.johnmschoonover.decksync.sdPlugin/bin/plugin.js
npm test               # jest
```

CI runs the same three commands on every push/PR to `main`. Run them all before pushing.

- **Node.js v24** is the runtime target (declared in the manifest); CI covers 22.x and 24.x.
- TypeScript 5 strict, **native TC39 decorators**. Do **not** enable `experimentalDecorators`.
- There is no headless Stream Deck runtime — behaviour on real devices is verified by John (see below). `npm run watch` only works on a machine with the Stream Deck app.

## Known issues / current state (October 2026)

Build, typecheck and tests are green. Open items (details in PRD §8):

1. **Icon assets missing.** The manifest references `imgs/...` that don't exist; the plugin won't validate/load until placeholders (correct sizes + `@2x`) are added.
2. **PI doesn't hydrate saved settings** on open (`ui/anchor.html`).
3. **Legacy per-anchor fields.** `targetDeviceId`/`targetProfile` are still honoured as a fallback in `page-anchor.ts`; they are being replaced by the global-settings scope model. Don't extend them.
4. **Hardware verification pending** for plugin load, real sync, startup guard, bundled profiles and Spike-1.

## Conventions

- **Settings shape:** sync config (scopes, roles, mappings) lives in **global settings** (PRD §6.5). Per-anchor settings are just `pageIndex` + `enabled`. Keep types `JsonObject`-compatible as the SDK requires.
- **SDK API for sync:** `streamDeck.profiles.switchToProfile(deviceId, profile?, page?)`. `page` is a **flat 0-based index** — no subpage/folder addressing (PRD §4.2).
- **Profiles** must be bundled with the plugin and registered in `manifest.json` → `Profiles`; the SDK cannot switch to user-created profiles. Creating valid `.streamDeckProfile` bundles is a hardware task.
- **No on-disk profile editing.** Communicate only via the official WebSocket API.
- **Logging:** info for SENDs (device, scope, target, page, send/receive class), warn for recoverable errors (profile not found, device offline, no scope). No unhandled exceptions on bad config.
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
