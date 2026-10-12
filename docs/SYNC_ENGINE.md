# Sync engine design (`src/syncEngine.ts`)

How the plugin implements PRD §6.3 (causal send/receive), §6.3.3 (parent precedence),
§6.4 (mapping) and §7.3 (startup guard), and what only hardware can still confirm.
The engine is pure TypeScript; the SDK is injected as `Switcher`, `Clock`, `Log` and
`DeviceDirectory`, which is why every rule below has a unit test in
`src/tests/syncEngine.test.ts`.

## State

Per device: `armed` (false until its first appear after start/connect), `disconnected`
(set by a disconnect and cleared when an appear arms the device, so that only a real
reconnect disarms it), `lastKnownPage` (null when unknown), `pending` — the switches the
engine issued to it that have not landed, in issue order, each with an `expired` flag —
`lastHumanSeq`/`lastHumanPage` (its most recent human navigation: a SEND, or a navigation
ignored as disabled or unscoped; a suppressed one is discarded), and the timestamps of its
recent SENDs for the storm breaker. A global `seq` numbers human navigations and
stale-switch restores. Nothing else; there is no scope-level "in flight" flag.

## Classifying an appear

In this order; the first rule that fires decides.

| # | Test | Result |
|---|---|---|
| 1 | anchor is inside a multi-action | IGNORED (not a page marker) |
| 2 | no valid `pageIndex` | IGNORED; warn once per anchor |
| 3 | `lastKnownPage === page` | IGNORED duplicate (second anchor on the page, editor re-emit); consumes a matching pending entry if one exists |
| 4 | earliest pending entry for this page exists | **RECEIVE** — terminal. Entries issued before it are dropped as superseded (the app showed only the last of rapid switches). If the entry is still expected (not expired), predates the device's own later human navigation, and nothing issued after that navigation is heading for the device, it is **RECEIVE_STALE**: swallowed and the human's last page restored. A late (expired) match is a plain RECEIVE: it may be the human flipping to a page the engine once sent the device to, and fighting that would be worse than one missed sync |
| 5 | device not armed | STARTUP: arm, record page, no sync (PRD §4.4) |
| 6 | device in no scope | IGNORED (recorded as the human's page); warn once per device per settings version |
| 7 | anchor disabled | IGNORED (recorded as the human's page) |
| 8 | child **and** a parent-issued entry on it is still expected (not expired) | **SUPPRESSED** (parent wins; its switch lands); the navigation is discarded, not recorded |
| 9 | more than 6 SENDs from this device within 1.5 s | IGNORED send-storm (warn): a circuit breaker for pages carrying a copied anchor with the wrong index, which would otherwise make two decks drive each other forever; not a classifier |
| 10 | otherwise | **SEND** |

Everything that is not an echo or startup is human (PRD §6.3.2). No rule consults elapsed time.

`onDisappear` only nulls `lastKnownPage` when the engine still believes the device is on
that page, so the order of appear(new)/disappear(old) does not matter; it never touches
`armed` or `pending`.

## SEND

1. `seq++`.
2. For every other member: map the page (below); skip with a log line when there is no
   counterpart, the device is disconnected (warn), it has no profile (warn), or it is
   already on that page (`already-there`: where it will be once the switches still expected
   to land have landed — the last non-expired pending page, else `lastKnownPage`).
   Otherwise push a pending entry **before** calling `switchToProfile`.
3. Record `lastSendSeq/lastSendPage` on the source once the fan-out is planned, so a failure
   inside the handler leaves no half-recorded send.
4. A rejected switch removes its entry and warns with the fix; nothing throws. The SDK
   resolves as soon as the request is written, so `SWITCH sent` (debug) is not a landing —
   the RECEIVE line is.

## Parent precedence, precisely

- *Expected* is per target device: a pending entry is expected from the moment it is pushed
  until its appear lands, a later entry on that device lands (superseding it), the switch
  is rejected, the device disconnects, settings change (it is detached), or the TTL marks
  it expired. An expired entry is still an echo tag but is no longer expected.
- *Conflict*: a human appear on a **child** that has an expected entry with origin `parent`.
  The child's navigation is suppressed — no fan-out, not recorded as a send — and the
  parent's switch lands as a normal RECEIVE. Once that switch has landed (or expired) the
  child may lead again. This is per device, not scope-wide: a child whose own switch has
  landed may lead while a sibling's is still in flight (PRD §8.6, to ratify).
- A **parent** appear is never suppressed. Should a switch issued before the parent's send
  still land on it afterwards, the RECEIVE_STALE rule swallows it and restores the parent's
  page — unless a switch issued after the parent's navigation is already heading for it,
  in which case that later switch wins and nothing is restored. Both orders of a
  parent/child cross-fire therefore end with everyone on the parent's page (tests E16,
  AC (c)); the same rule keeps peers consistent (test E15) and never lets a child's stale
  switch outrun the parent's (test R2-F4).

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
did not know it (its page was unknown after a disappear or reconnect), when the page has no
anchor, when the profile is not bundled (the app ignores the request without rejecting it),
or when the app shows only the last of several rapid switches. Mechanisms, in order of how
much they do: (1) `already-there` avoids issuing such switches when the page is known;
(2) causal cleanup — superseding, rejection, disconnect; (3) ageing, evaluated lazily when
the device is next touched: past `pendingTtlMs` (default 3 s) an entry is marked **expired**
and logged at warn (`SWITCH unconfirmed …`), past `pendingGraceMs` (default 30 s) it is
dropped, and a per-device cap (50) bounds memory regardless.

An expired entry no longer suppresses a child and no longer counts as where the device will
be, but it **remains an echo tag**: a landing that arrives later than the TTL (an app stall,
sleep/wake, a slow profile switch) is still a RECEIVE (`late=true`) and can never be
mistaken for human navigation and rebroadcast — the first review of this engine found
exactly that defect when expiry simply deleted the entry. Time therefore never changes the
classification of an appear; it only ends suppression and prediction.

The bounded cost is the inherent ambiguity of an unconsumed tag: a human navigation to
exactly the page of a dangling entry, within the grace period, is swallowed once as a
RECEIVE (the scope is then out of step until the next flip). Within the first 3 s, while
the tag is still expected, such a flip can additionally trigger a restore if it follows
another human navigation on the same device (the deck jumps back once); after the TTL a
match is only ever swallowed, never fought. With bundled profiles that anchor every page
this needs a coalesced burst or an already-aligned target with an unknown page; hardware
checks C-11/C-12 in `docs/MANUAL_TESTS.md` measure how often it happens.

## Settings changes

Validated settings (from the PI's save or the global-settings event) replace the
configuration, detach every pending entry (marked expired: their origins belonged to the
old topology, but they stay echo tags) and keep `armed`/`lastKnownPage`/last send. A reload
that changes nothing is ignored, because the global-settings event also fires for plain
reads. A switch that lands after a reload is therefore still a RECEIVE. After start, an
unusable settings payload (not an object, wrong version, or `scopes` not an array) is
ignored with a warning rather than replacing a working configuration with zero scopes
(`createGlobalSettingsHandler` in `src/piBridge.ts`); before start the event is ignored
because the start-up load applies the settings.

## Logging

Every line is `EVENT key=value …`; the code is canonical, this is the index.

| Level | Events |
|---|---|
| info | `START`, `SETTINGS applied`, `SEND` (device, role, scope, page, canonical page, seq, targets, skips), `RECEIVE` (`late=true` after the TTL), `RECEIVE_STALE`, `STARTUP`, `SUPPRESSED`, `IGNORED reason=disabled`, `SKIP reason=no-counterpart`, `DEVICE connected`, `DEVICE disconnected` |
| warn (with an actionable clause) | `IGNORED reason=no-scope` (once per device per settings version), `IGNORED reason=no-page-index` (once per anchor), `IGNORED reason=send-storm`, `SKIP reason=disconnected` / `no-profile` / `error`, `SWITCH failed`, `SWITCH unconfirmed`, `RESTORE skipped` |
| debug | `SETTINGS unchanged`, `DEVICE connected (already armed)`, `IGNORED reason=duplicate` / `multi-action` / repeated `no-scope` / repeated `no-page-index`, `SKIP reason=already-there`, `SWITCH sent`, `LEAVE`, `GC reason=superseded` / `grace-elapsed` / `cap` |
| error | `UNEXPECTED handler=onAppear …` (caught, never rethrown) |

Under the plugin's `DeckSync` scope (`src/piBridge.ts`, `src/plugin.ts`): `Settings saved:
n scope(s).` (info), `Settings: …` (warn: a rejected scope and why, an ignored unusable
payload), `PI: …` (warn when a reply could not be sent; debug when no panel is open),
`Startup failed: …` (error).

## What only hardware can confirm

1. The app applies several `switchToProfile` calls to one device in order (or shows only the last). Test: manual check C-11 (parent 0→1→2→1→0 as fast as possible; the child must end on 0, and the log records whether the intermediate pages appeared).
2. Whether a switch to the page a device is already on emits `willAppear`. Handled either way; routine `SWITCH unconfirmed` warnings in the log would mean an anchor is missing or a profile is not bundled.
2a. `isConnected` comes from `deviceDidConnect`: the SDK lists registration-time devices as not connected until that event arrives, so a flip made before a member's connect event skips it with `SKIP … reason=disconnected`. The arming logic itself does not depend on the order of connect events and appears (a connect for a device that never disconnected, or whose reconnect burst already arrived, does not disarm it).
2b. Echo latency: a landing later than 3 s is absorbed as a late RECEIVE (manual check C-12); if late echoes are routine, raise `pendingTtlMs`.
2c. Copied anchors with a wrong page index make a page report two indices; a single one silently overturns a navigation, a cycle of them trips the send-storm breaker (warn). The fix is always the anchor, not the engine.
3. `willDisappear` fires for every left page. If not, "leave to an un-anchored page and come back" is read as a duplicate once; fallback is de-duplicating on action id instead of page.
4. The launch burst is one appear per anchor on each device's *current* page. If the app also emits appears for other pages at launch, `lastKnownPage` could be wrong until the first flip.
5. Whether editing a page in the Stream Deck editor emits appears without navigating the device.
6. The page a device returns to on reconnect (the engine deliberately does not auto-correct — PRD §7.3 MUST).
7. The app's behaviour for a page index beyond the profile's page count (reject vs. clamp); `pageCount` keeps the engine from asking.
8. How often a coalesced burst leaves dangling tags (the swallowed-navigation cost above).
9. The visible flicker in a true cross-fire (parent briefly shows the child's page, then its own).
10. Folder anchors (Spike-1): until then, anchors inside folders should be disabled or left without a page index.
