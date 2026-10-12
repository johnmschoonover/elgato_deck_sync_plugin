# Sync engine design (`src/syncEngine.ts`)

How the plugin implements PRD §6.3 (causal send/receive), §6.3.3 (parent precedence),
§6.4 (mapping) and §7.3 (startup guard), and what only hardware can still confirm.
The engine is pure TypeScript; the SDK is injected as `Switcher`, `Clock`, `Log` and
`DeviceDirectory`, which is why every rule below has a unit test in
`src/tests/syncEngine.test.ts`.

## State

Per device: `armed` (false until its first appear after start or connect; a disconnect
clears it, a connect event for an armed device changes nothing), `lastKnownPage` (null when
unknown), `pending` — the switches the engine issued to it that have not landed, in issue
order, each with an `expired` mark (`false`, `"ttl"`, `"detached"`, `"cap"` or
`"superseded"`, the last of which also restarts the entry's clock so it lives one TTL from
the landing that superseded it) — `lastHumanSeq`/`lastHumanPage` (its most recent human
navigation: a SEND, or a navigation ignored as disabled or unscoped; a suppressed one is
discarded), and for the conflicting-anchor breaker `visit` (the page indices reported by
appears and not left since), `leaving` (the indices that disappeared since the last appear)
and `drivenRun` (conflicts in a row). Globally: `seq`, which numbers
human navigations and stale-switch restores, `started`, the pre-start `queued` navigations
(newest 20), and three once-only sets — anchors already warned about for a missing page
index (never cleared), devices already warned about as unscoped and device/page pairs
already warned about as beyond the page count (both cleared whenever settings are applied).
Nothing else; there is no scope-level "in flight" flag.

## Classifying an appear

In this order; the first rule that fires decides.

| # | Test | Result |
|---|---|---|
| 1 | anchor is inside a multi-action | IGNORED (not a page marker) |
| 2 | no valid `pageIndex` | IGNORED; warn once per anchor |
| 3 | `lastKnownPage === page` | IGNORED duplicate (second anchor on the page, editor re-emit); consumes a matching pending entry if one exists |
| 4 | a pending entry for this page exists — the latest one still in flight, else the latest tag (a landing satisfies every switch to that page issued so far, since a switch to the page the device already shows never produces another appear; and an old tag for the page must not be matched while a fresh switch to it is still expected) | **RECEIVE** — terminal. Everything issued before the match is superseded: the app showed only the last of rapid switches, or still has them queued, so they stay echo tags for one TTL from this landing, whatever their state before, and can never be rebroadcast if the app applies them after all — nor fight or swallow the person's own return to that page beyond that TTL. If the entry is still in flight (expected, or detached by a settings change — not `ttl`, `cap` or `superseded`), predates the device's own later human navigation, and nothing issued after that navigation is heading for the device, it is **RECEIVE_STALE**: swallowed and the human's last page restored. A late (expired) match is a plain RECEIVE: it may be the human flipping to a page the engine once sent the device to, and fighting that would be worse than one missed sync |
| 5 | device not armed | STARTUP: arm, record page, no sync (PRD §4.4) |
| 6 | engine not started (settings not loaded yet) | IGNORED not-started; the appear is queued for `start()` (a second anchor on the same page is a duplicate and takes no slot). The queue keeps the newest 20 (the oldest is dropped with a warning), and a device's queued navigation is discarded when it disconnects. Nothing was in flight before start, so queued navigations never conflicted: `start()` replays them in order through these same rules, but a replayed fan-out leaves alone any device whose own later queued navigation is still to come (`SKIP … reason=queued-later`, debug — it is where its own flip left it, and it is never suppressed by a switch the replay itself created), and a page the device had left again before start (`LEAVE … (left before the settings loaded)`, debug) is forgotten after its replay so the next appear there is not read as a duplicate |
| 7 | device in no scope | IGNORED, recorded as the human's page (so a switch detached by the settings change that unscoped it is stale if it lands later); warn once per device per settings version |
| 8 | child **and** a parent-issued entry on it is still expected (not expired) | **SUPPRESSED** (parent wins; its switch lands), whatever page the child flipped to — a disabled page included; the navigation is discarded, not recorded |
| 9 | anchor disabled | IGNORED (recorded as the human's page) |
| 10 | the device's run of *conflicts* exceeds 12 | IGNORED conflicting-anchors (warn). A conflict is a page reporting two indices: a second index appearing before the first has disappeared, or two indices disappearing together. A page carrying a copied anchor with the wrong index does both; two such pages on two devices drive each other forever, and the breaker stops that however slowly the app applies switches and whichever anchor the app reports first, because the run is counted structurally, not within a time window. A run ends with a real page change — a disappear group with a single index. It never fires on ordinary flipping, however fast, in either appear/disappear order (below) |
| 11 | otherwise | **SEND** |

The breaker's bookkeeping: `visit` holds the indices reported by appears and not yet left;
`leaving` the indices that disappeared since the last appear. A human appear whose index differs
from one already in `visit` is a conflict (`CONFLICT … also=[…]`, debug); a disappear that makes
`leaving` hold two indices is one too (`CONFLICT … pages=[…]`). Every human send checks the run,
so a device caught in a cycle stops sending once the run exceeds 12 and resumes after it passes
a page with a single anchor (the next appear after a one-index disappear group resets the run).
If the app emits a page's appear before the previous page's disappear, an ordinary flip counts
as one conflict for a moment, and the single-index disappear that follows resets it before the
next flip, so nothing accumulates; hardware check C-11 records which order the app uses.

Everything that is not an echo or startup is human (PRD §6.3.2). No rule consults elapsed time
to tell a RECEIVE from a SEND, and none to trip the breaker; expiry only ends suppression and
prediction.

### Anchor edits

Editing a visible Page Anchor's settings in its Property Inspector (page index or enabled)
reaches the engine as `onAnchorUpdated`: the device is showing that page, so its page is
recorded as the new index (or forgotten when the index is cleared), the device is armed, and
a switch to that index still awaiting a landing counts as landed. Nothing is sent — editing
is not navigation. The log line is `ANCHOR updated` (info). Without this a corrected or newly
typed index would be unknown to the engine until the page's next appear, so fan-outs to that
device could be skipped as already-there or dangle.

`onDisappear` nulls `lastKnownPage` only when the engine still believes the device is on
that page, so the order of appear(new)/disappear(old) does not matter. It ages the device's
entries (ageing is lazy), and a switch to the page being left that is still in flight has been
overtaken — the device was on the page without the switch ever showing — so it becomes a tag
for one TTL (`GC … reason=left-page`, debug): the person's return to that page is then
swallowed once at most, never read as a stale landing and fought. It never touches `armed`.

## SEND

1. `seq++`.
2. For every other member: map the page (below); skip with a log line when there is no
   counterpart, the device is disconnected (warn), it has no profile (warn), or it is
   already on that page (`already-there`). "Where it will be" is the tail of its switches still
   in flight (expected, or detached by a settings change) — but only if the stale rule will honour them, i.e. at least one was issued after
   the device's own last navigation; entries that all predate it would be undone when they
   land and predict nothing, so `lastKnownPage` is used instead. When a parent is skipped
   because a child-issued switch already carries the target there, that entry is promoted to
   parent origin so the child stays suppressed until it lands. Otherwise push a pending entry
   **before** calling `switchToProfile`. A target that throws (e.g. the device directory) is
   skipped with `reason=error`; the others proceed.
3. Record `lastHumanSeq/lastHumanPage` on the source once the fan-out is planned, so a failure
   inside the handler leaves no half-recorded navigation.
4. A rejected switch removes its entry and warns with the fix; nothing throws. The SDK
   resolves as soon as the request is written, so `SWITCH sent` (debug) is not a landing —
   the RECEIVE line is.

## Parent precedence, precisely

- *Expected* is per target device: a pending entry is expected from the moment it is pushed
  until its appear lands, a later entry on that device lands (superseding it), the switch
  is rejected, the device disconnects, settings change (it is detached), the cap turns it
  into a tag, or the TTL marks it expired. An expired entry is still an echo tag but is no
  longer expected. A *detached* entry is still in flight: issued under the old topology, it
  no longer suppresses a child, but it still predicts where its device will be and, if it
  lands after the device's own later navigation, it is undone like any other, until the TTL
  ages it.
- *Conflict*: a human appear on a **child** that has an expected entry with origin `parent`.
  The child's navigation is suppressed — no fan-out, not recorded as a send — and the
  parent's switch lands as a normal RECEIVE. Once that switch has landed (or expired) the
  child may lead again. This is per device, not scope-wide: a child whose own switch has
  landed may lead while a sibling's is still in flight (PRD §8.6, to ratify).
- A **parent** appear is never suppressed. Should a switch issued before the parent's send
  still land on it afterwards, the RECEIVE_STALE rule swallows it and restores the parent's
  page (in the profile the stale switch put the device in) — unless a switch issued after the parent's navigation is already heading for it,
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
(2) causal cleanup — rejection, disconnect, and superseding, which turns an entry into a tag
rather than deleting it; (3) ageing, evaluated lazily when the device is next touched: past
`pendingTtlMs` (default 3 s) an entry in flight is marked **expired** and logged at warn
(`SWITCH unconfirmed …`), past `pendingGraceMs` (default 30 s) it is dropped, and a
superseded tag is dropped one TTL after the landing that superseded it. One expired tag per
page is kept (a newer one replaces an older one for the same page), and past
`maxPendingPerDevice` (50) still-expected entries the oldest become tags too (warn), so
memory is bounded by the page count plus the cap without ever forgetting that a switch was
issued — neither the cap nor a coalesced burst nor a stalled app applying its backlog late
can turn a landing into a SEND.

An expired entry no longer suppresses a child and no longer counts as where the device will
be, but it **remains an echo tag**: a landing that arrives later than the TTL (an app stall,
sleep/wake, a slow profile switch) is still a RECEIVE (`late=true`) and can never be
mistaken for human navigation and rebroadcast — the first review of this engine found
exactly that defect when expiry simply deleted the entry. Time therefore never decides
whether an appear is an echo; it only ends suppression and prediction. When the same page
is switched to again while an older tag for it is still kept, the landing matches the fresh
entry (rule 4) and the older tag is superseded like everything issued before the match: a
tag for one more TTL, never in flight, so it can neither fight nor outlive the landing that
replaced it (a detached one would otherwise restore against the person's own return to that
page).

The bounded cost is the inherent ambiguity of an unconsumed tag, and it has two faces:

1. A human navigation to exactly the page of a dangling entry, within the grace period, is
   swallowed once as a RECEIVE (the scope is then out of step until the next flip). Within
   the first 3 s, while the tag is still expected, such a flip can additionally trigger a
   restore if it follows another human navigation on the same device (the deck jumps back
   once); after the TTL a match is only ever swallowed, never fought. Superseded entries are
   tags too (one TTL after the landing that superseded them), so a quick flip to a page the
   app skipped in a coalesced burst is swallowed as well. The converse ambiguity is not
   covered: if a human flip was swallowed by a tag and the app then applies that very switch
   after the human has already left the page again, the landing has no tag and is a SEND
   (the scope follows the stalled switch); no causal rule can tell it from navigation.
2. While a **parent-origin** entry on a child is still expected, rule 8 suppresses that
   child's flip to *any* page. If the app coalesces a parent burst (parent 1 → 0 quickly;
   the child, already on 0, shows nothing), the child's tags for 1 and 0 dangle, and a flip
   on that child within the TTL (3 s) is suppressed and lost — the child shows its new page,
   nobody follows, and the next flip after the TTL syncs normally. The engine cannot tell a
   coalesced burst from one the app has not applied yet (in both the device sits on the
   final page with the same tags), and letting the flip through would let a truly in-flight
   parent switch be undone, so precedence wins. The window is `pendingTtlMs`.

With bundled profiles that anchor every page both need a coalesced burst or an
already-aligned target with an unknown page; hardware checks C-11, C-12 and C-16 in
`docs/MANUAL_TESTS.md` measure how often that happens and whether 3 s is the right TTL
(PRD §8.6).

## Settings changes

Validated settings (from the PI's save or the global-settings event) replace the
configuration, detach every still-expected pending entry (marked `detached`: their origins
belonged to the old topology, so they no longer suppress a child, but they stay echo tags
and, being still in flight, still predict where their device will be and are undone by the
stale rule if they land after the device's own later navigation, until the TTL ages them;
already-expired tags keep their mark) and keep `armed`/`lastKnownPage`/last send. A reload
that changes nothing is ignored, because the global-settings event also fires for plain
reads. A switch that lands after a reload is therefore still a RECEIVE. After start, an
unusable settings payload (not an object, wrong version, or `scopes` not an array) is
ignored with a warning rather than replacing a working configuration with zero scopes
(`createGlobalSettingsHandler` in `src/piBridge.ts`); before start the event is ignored
because the start-up load applies the settings. A save from the PI that arrives before
`start()` has finished is held and becomes the start configuration (`SETTINGS applied
(start)`), then re-applied afterwards as a no-op (`src/plugin.ts`). If Stream Deck never
answers the start-up read, the plugin starts with defaults after 15 s (warn) and applies
the settings when the reply finally comes — through the event, or, if the reply lands while
`start()` is still replaying, through the read itself once start has finished. The engine
counts as started only once the replay has drained: a navigation that arrives while the
replay awaits the app's acknowledgements joins the queue and is replayed next, under the
normal rules (so it can be suppressed by a switch the replay genuinely issued before it).

## Logging

Every line is `EVENT key=value …`; the code is canonical, this is the index.

| Level | Events |
|---|---|
| info | `START` (with `queued=n`), `SETTINGS applied`, `SEND` (device, role, scope, page, canonical page, seq, targets, skips), `RECEIVE` / `RECEIVE_STALE` (device, page, seq, origin, scope; at most one flag: `late=true` after the TTL, `detached=true` after a settings change — it becomes `late=true` once the TTL has passed —, `capped=true` for an entry the cap turned into a tag, `superseded=true` for one overtaken by a later landing or by the device leaving its page), `STARTUP`, `SUPPRESSED`, `ANCHOR updated … page=<before>→<after> enabled=… (no sync)` — with `(consumed seq=n)` when a switch to that index was pending, or `page=…→none (page index cleared; …)` when the index was blanked —, `IGNORED reason=disabled`, `SKIP reason=no-counterpart`, `DEVICE connected` (for a device not yet armed: new, or after a disconnect), `DEVICE disconnected` (`droppedPending=n`, plus `droppedQueued=n` when pre-start navigation was discarded) |
| warn (with an actionable clause) | `IGNORED reason=no-scope` (once per device per settings version), `IGNORED reason=no-page-index` (once per anchor), `IGNORED reason=conflicting-anchors`, `SEND … reason=beyond-page-count` (once per device and page: the flipped-to page is beyond the device's configured page count, so nobody can follow), `QUEUE full` (the oldest pre-start navigation dropped), `SKIP reason=disconnected` / `no-profile` / `error`, `SWITCH failed`, `SWITCH unconfirmed` (logged lazily, the next time the engine touches that device at least 3 s after the switch), `GC reason=cap` (more than 50 still-expected switches to one device; the oldest become tags only) |
| debug | `SETTINGS unchanged (update)`, `QUEUED … reason=not-started`, `CONFLICT` (a second index on one page visit, or two indices leaving together), `DEVICE connected (already armed)`, `IGNORED reason=duplicate` (also `(already queued)` before start) / `multi-action` / repeated `no-scope` / repeated `no-page-index`, `SKIP reason=already-there` / `queued-later`, `SWITCH sent`, `LEAVE` (plain, or `(left before the settings loaded)` after a replay), `GC reason=superseded` (kept as a tag) / `left-page` / `grace-elapsed` / `duplicate-tag` |
| error | `UNEXPECTED handler=onAppear …` / `onDisappear …` (caught, never rethrown; the appear is IGNORED with reason=error) |

Under the plugin's `DeckSync` scope (`src/piBridge.ts`, `src/plugin.ts`): `Settings saved:
n scope(s).` (info); `Settings: …` at warn for a rejected scope and why, a save from the
panel rejected with n problem(s), a save that could not be written (`Could not save
settings (…)`), a start-up read that failed (`could not read global settings (…); using
defaults`), an unusable global-settings payload ignored after start, and no reply to the
start-up read within 15 s; at debug for a global-settings event before start; `PI: …`
(warn when a reply could not be sent; debug when no panel is open or a message is
unknown); `Startup failed: …` (error).

## What only hardware can confirm

1. The app applies several `switchToProfile` calls to one device in order (or shows only the last). Test: manual check C-11 (parent 0→1→2→1→0 as fast as possible; the child must end on 0, and the log records whether the intermediate pages appeared).
2. Whether a switch to the page a device is already on emits `willAppear`. Handled either way; routine `SWITCH unconfirmed` warnings in the log would mean an anchor is missing or a profile is not bundled.
2a. `isConnected` comes from `deviceDidConnect`: the SDK lists registration-time devices as not connected until that event arrives, so a flip made before a member's connect event skips it with `SKIP … reason=disconnected`. The arming logic itself does not depend on the order of connect events and appears (a connect for a device that never disconnected, or whose reconnect burst already arrived, does not disarm it).
2b. Echo latency: a landing later than 3 s is absorbed as a late RECEIVE (manual check C-12); if late echoes are routine, raise `pendingTtlMs`.
2c. Copied anchors with a wrong page index make a page report two indices; a single one silently overturns a navigation (manual check C-15), a cycle of them trips the conflicting-anchor breaker (warn) once a device's run of conflicts exceeds twelve, however slowly the app applies switches and whichever anchor it reports first. A backlog so deep that switches land later than the grace period (30 s) is beyond the breaker's reach by design. The fix is always the anchor, not the engine.
2d. Whether the app emits a new page's appear before or after the old page's disappear. Either order works for sync and for the breaker (a late disappear uncounts the flip it followed); manual check C-11 records the order the app uses.
2e. Settings saved while a switch is in flight (manual check C-13: the landing is a `RECEIVE … detached=true`, never a send) and navigation before the settings have loaded (C-14: `QUEUED`, then replayed by `START`).
3. `willDisappear` fires for every left page. If not, "leave to an un-anchored page and come back" is read as a duplicate once; fallback is de-duplicating on action id instead of page.
4. The launch burst is one appear per anchor on each device's *current* page. If the app also emits appears for other pages at launch, `lastKnownPage` could be wrong until the first flip.
5. Whether editing a page in the Stream Deck editor emits appears without navigating the device.
6. The page a device returns to on reconnect (the engine deliberately does not auto-correct — PRD §7.3 MUST).
7. The app's behaviour for a page index beyond the profile's page count (reject vs. clamp); `pageCount` keeps the engine from asking.
8. How often a coalesced burst leaves dangling tags (the swallowed-navigation cost above).
9. The visible flicker in a true cross-fire (parent briefly shows the child's page, then its own).
10. Folder anchors (Spike-1): until then, anchors inside folders should be disabled or left without a page index.
