# Sync engine design (`src/syncEngine.ts`)

How the plugin implements PRD §6.3 (causal send/receive), §6.3.3 (parent precedence),
§6.4 (mapping) and §7.3 (startup guard), and what only hardware can still confirm.
The engine is pure TypeScript; the SDK is injected as `Switcher`, `Clock`, `Log` and
`DeviceDirectory`, which is why every rule below has a unit test in
`src/tests/syncEngine.test.ts`.

## State

Per device: `armed` (false until its first appear after start/connect), `lastKnownPage`
(null when unknown), `pending` — the switches the engine issued to it that have not landed,
in issue order — and `lastSendSeq`/`lastSendPage` (its most recent human send). A global
`seq` numbers sends. Nothing else; there is no scope-level "in flight" flag.

## Classifying an appear

In this order; the first rule that fires decides.

| # | Test | Result |
|---|---|---|
| 1 | anchor is inside a multi-action | IGNORED (not a page marker) |
| 2 | no valid `pageIndex` | IGNORED; warn once per anchor |
| 3 | `lastKnownPage === page` | IGNORED duplicate (second anchor on the page, editor re-emit); consumes a matching pending entry if one exists |
| 4 | earliest pending entry for this page exists | **RECEIVE** — terminal. Entries issued before it are dropped as superseded (the app showed only the last of rapid switches). If the entry predates the device's own later send and that page is not pending, it is **RECEIVE_STALE**: swallowed and the human's page restored |
| 5 | device not armed | STARTUP: arm, record page, no sync (PRD §4.4) |
| 6 | device in no scope | IGNORED; log once per device per settings version |
| 7 | anchor disabled | IGNORED |
| 8 | child **and** a parent-issued entry is pending on it | **SUPPRESSED** (parent wins; its switch lands) |
| 9 | otherwise | **SEND** |

Everything that is not an echo or startup is human (PRD §6.3.2). No rule consults elapsed time.

`onDisappear` only nulls `lastKnownPage` when the engine still believes the device is on
that page, so the order of appear(new)/disappear(old) does not matter; it never touches
`armed` or `pending`.

## SEND

1. `seq++`; record `lastSendSeq/lastSendPage` on the source.
2. If switches are still heading for the source (its `pending` is non-empty), re-issue its
   own page behind them (origin `self`) so the human's choice lands last.
3. For every other member: map the page (below); skip with a log line when there is no
   counterpart, the device is disconnected (warn), it has no profile (warn), or it is
   already on that page (`already-there`: no pending → `lastKnownPage`; pending → the last
   pending page). Otherwise push a pending entry **before** calling `switchToProfile`.
4. A rejected switch removes its entry and warns with the fix; nothing throws.

## Parent precedence, precisely

- *In flight* is per target device: a pending entry exists until its appear lands, a later
  entry on that device lands (superseding it), the switch is rejected, the device
  disconnects, settings change, or the TTL reclaims it.
- *Conflict*: a human appear on a **child** that has a pending entry with origin `parent`.
  The child's navigation is suppressed — no fan-out, not recorded as a send — and the
  parent's switch lands as a normal RECEIVE. Once that switch has landed the child may lead
  again (peer follow); "the parent moved recently" would be a timing rule and is not used.
- A **parent** appear is never suppressed. Its send re-asserts the parent's own page behind
  any in-flight switch (step 2) and, should such a switch still land afterwards, the
  RECEIVE_STALE rule restores the page. Both orders of a parent/child cross-fire therefore
  end with everyone on the parent's page (tests E16).

## Mapping

The parent's page index is the scope's canonical coordinate: a page on any member is first
expressed as a parent page, then each other member's page is derived from it, so
child↔child goes through the parent and "everyone on the parent's page" is the invariant.
Positional by default, bounded by the member's `pageCount` (default 5). An override pins a
parent page to a child page in both directions; a pinned page has no positional counterpart
on the other side, so every pair of devices maps one-to-one (`src/mapping.ts`, tested as a
symmetry property).

## Garbage collection and why it is not a debounce

A pending entry can fail to echo when the target was already on that page and the engine
did not know it (its page was unknown after a disappear or reconnect) or the page has no
anchor. Three mechanisms, in order of how much they do: (1) `already-there` avoids issuing
such switches when the page is known; (2) causal cleanup — superseding, rejection,
disconnect, settings change; (3) a TTL (`pendingTtlMs`, default 3000) evaluated lazily when
the device is next touched. The TTL only ever *removes* entries, turning a would-be RECEIVE
into a SEND; a SEND from a late echo fans out to members already on the mapped page and
issues nothing. The only way a human navigation is swallowed is a still-pending entry for
the exact page the user navigates to, within the TTL, on a page whose anchor never fired —
bounded, rare, and never a loop.

## Settings changes

Validated settings (from the PI's save or the global-settings event) replace the
configuration, clear every pending entry (their origins belonged to the old topology) and
keep `armed`/`lastKnownPage`/last send. A reload that changes nothing is ignored, because
the global-settings event also fires for plain reads. A switch that lands after a reload is
classified human and re-syncs the scope once; its targets are tracked, so it cannot loop.

## Logging

`info`: SEND (device, role, scope, page, canonical page, seq, targets, skips), RECEIVE,
RECEIVE_STALE, STARTUP, SUPPRESSED, IGNORED (disabled, no-scope once), SETTINGS, DEVICE,
SKIP no-counterpart. `warn` with an actionable clause: SKIP disconnected / no-profile,
SWITCH failed, no-page-index (once per anchor). `debug`: duplicates, multi-action, LEAVE,
GC, SWITCH ok. `error`: a handler exception (caught, never rethrown).

## What only hardware can confirm

1. The app applies several `switchToProfile` calls to one device in order (or shows only the last). Test: flip the parent 1→3→1 quickly; children must end on 1.
2. Whether a switch to the page a device is already on emits `willAppear`. Handled either way; routine `GC … expired` lines in the log would mean an anchor is missing.
3. `willDisappear` fires for every left page. If not, "leave to an un-anchored page and come back" is read as a duplicate once; fallback is de-duplicating on action id instead of page.
4. The launch burst is one appear per anchor on each device's *current* page. If the app also emits appears for other pages at launch, `lastKnownPage` could be wrong until the first flip.
5. Whether editing a page in the Stream Deck editor emits appears without navigating the device.
6. The page a device returns to on reconnect (the engine deliberately does not auto-correct — PRD §7.3 MUST).
7. The app's behaviour for a page index beyond the profile's page count (reject vs. clamp); `pageCount` keeps the engine from asking.
8. Echo latency under load relative to the 3 s TTL.
9. The visible flicker in a true cross-fire (parent briefly shows the child's page, then its own).
10. Folder anchors (Spike-1): until then, anchors inside folders should be disabled or left without a page index.
