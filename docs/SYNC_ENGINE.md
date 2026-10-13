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
order, each with an `expired` mark (`false`, `"ttl"`, `"detached"`, `"cap"`,
`"superseded"` or `"left"` — those two restart the entry's clock, so the tag lives the grace
period from the landing that superseded it or from the disappear; `ttl` and `cap` tags are
counted from the issue) — `lastReceivePage` (the page the last RECEIVE put the device on,
cleared by any appear classified past rule 3 that is not a RECEIVE — a duplicate or a return
keeps it: the visit is still the one the switch landed on —, when that page disappears, by an
anchor edit and by a disconnect) — `disabledOnly` (the page was recorded by a disabled anchor only, so an
enabled anchor on it may still send once) — `lastHumanSeq`/`lastHumanPage` (its most recent
human navigation: a SEND, or a navigation ignored as disabled, unscoped or by either breaker;
a suppressed one is discarded) — `leftPage` (the page a disappear just took the device off; an
appear for it with nothing between is a re-emit, not a landing) — and for the conflicting-anchor breaker `visit` (the page
indices reported by appears and not left since), `leaving` (the indices that disappeared
since the last real page change: the open disappear group), `closed` (what was left of that
group when one of its pages came back — a re-emit, a folder closing — held until a real page
change reads it, unless the rest comes back too), `back` (the pages of the group that came
back) and `drivenRun` (conflicts in a row), and for the driven-send breaker `overturnRun`
(driven sends in a row: made while another deck's switch to a different page of this device,
issued after its last landing (`lastReceiveSeq`), had not shown — or from a visit a switch
landed on), with `cleanPending`/`drivenPending` — and `drivenPage`, the landed page the
deferred send was made from — for a send that the disappear group of its own visit settles.
A disconnect clears `armed`, `lastKnownPage`, `pending`, `visit`, the three group sets, both
breaker runs, both pending-send flags with `drivenPage`, `lastReceivePage` and `leftPage`, and
keeps `disabledOnly`, `lastReceiveSeq` and the last human navigation; an anchor edit clears
the overturn run (the conflict run is kept), both pending-send flags with `drivenPage`,
`visit`, the three group sets, `lastReceivePage`, `disabledOnly` and `leftPage`, and keeps
`lastReceiveSeq` too; `start()` clears `leftPage` and the group sets (the pre-start history
was replayed as navigation). Globally: `seq`, which numbers
human navigations and stale-switch restores, `started`, the pre-start `queued` navigations
(newest 20), and three once-only sets — anchors already warned about for a missing page
index (re-armed for an anchor when its settings are edited), devices already warned about as unscoped and device/page pairs
already warned about as beyond the page count (both cleared whenever settings are applied).
There is no scope-level "in flight" flag.

## Classifying an appear

In this order; the first rule that fires decides.

| # | Test | Result |
|---|---|---|
| 1 | anchor is inside a multi-action | IGNORED (not a page marker) |
| 2 | no valid `pageIndex` | IGNORED; warn once per anchor |
| 3 | `lastKnownPage === page`, or — after start only — a *return*: the page a disappear just took the device off (`leftPage`), or any page of the open disappear group, reported again while everything still up came back from that group | IGNORED duplicate (a second anchor on the page, an editor re-emit, or the app re-emitting a shown page's anchors on a switch to it — hardware item 2 — the page's own anchor and a copied one on it alike, whichever reports first — or a return from a page without an anchor, item 3: the device never changed page); consumes a pending entry for the page only when it is the oldest the engine still remembers for the device — a re-emit never stands for a switch queued behind another, since the app would show the older one first and bring the device back (`… waits behind an older one; kept`). A page recorded by a *disabled* anchor only is not a duplicate for an enabled one: that anchor still sends (once). Never applied to a navigation `start()` replays: it was de-duplicated when queued, and the page may have become known since (an anchor edit) while the navigation is still owed its fan-out |
| 4 | a pending entry for this page exists. The app applies switches **in order**, so the match is the **earliest** entry for the page, whatever its state (a tag for the page always precedes a later switch to it), together with the switches to the same page issued right after it with no other page between (they can never produce another appear). From an entry still in flight the newest of that run is the match, so a later switch wins in the stale rule below; a *tag* is the match itself — whether the appear is its own late landing or the run's cannot be told (what stood between them was a person's flip that swallowed a switch, or was dropped), so the run is written off with it rather than left expected on a page the device may already have been switched to | **RECEIVE** — terminal. Everything still in flight that was issued *before* the match was processed without an appear (the device was already there, the page has no anchor, or the app coalesced it) and, like the rest of the run, becomes a superseded tag: an echo tag for the grace period from this landing, never rebroadcast if the app applies it after all, never able to fight, and able to swallow the person's own return once at most. Everything issued *after* the match stays in flight — the app may still have it queued (a burst 1→3→1 that has shown 1 will still show 3 and 1; a reissue of a page whose old tag is still kept may still show) — so it keeps suppressing a child and predicting where the device will be until it lands, expires, or the device leaves its page. If the entry is still in flight (expected, or detached by a settings change — not `ttl`, `cap`, `superseded` or `left`), predates the device's own later human navigation, and nothing issued after that navigation is heading for the device, it is **RECEIVE_STALE**: swallowed and the human's last page restored. A late (expired) match is a plain RECEIVE: it may be the human flipping to a page the engine once sent the device to, and fighting that would be worse than one missed sync. A *superseded* tag that shows after all proves the superseding landing was the person's own flip and the app still holds its queue: the other switches superseded with it get a fresh grace period and the switch that superseded them — consumed by that flip — is revived as a tag in its place (`GC … reason=revived`), so its landing is an echo too |
| 5 | device not armed | STARTUP: arm, record page, no sync (PRD §4.4). Only an appear arms: a device that shows no anchor when the plugin starts (another profile, a page without one) is armed by its first anchored page, so that first flip syncs nobody and it leads from its second change |
| 6 | engine not started (settings not loaded yet) | IGNORED not-started; the appear is queued for `start()`. A second anchor on the page the device's own latest queued navigation reached takes no slot, whatever other devices queued in between — except that an enabled anchor reported after a disabled one on that page replaces it (`QUEUED … (replaces the disabled anchor's appear …)`, debug), so the navigation is replayed as a send, as rule 3 would let it after start. The queue keeps the newest 20 (the oldest is dropped with a warning), and a device's queued navigation is discarded when it disconnects. Nothing was in flight before start, so queued navigations never conflicted: `start()` replays them in order through these same rules, but a replayed fan-out leaves alone any device whose own later queued navigation is still to come (`SKIP … reason=queued-later`, debug — it is where its own flip left it, and it is never suppressed by a switch the replay itself created), and a page the device had left again before start (`LEAVE … (left before the settings loaded)`, debug) is forgotten after its replay so the next appear there is not read as a duplicate |
| 7 | device in no scope | IGNORED, recorded as the human's page (so a switch detached by the settings change that unscoped it is stale if it lands later); warn once per device per settings version |
| 8 | child **and** a parent-issued entry on it is still expected (not expired) | **SUPPRESSED** (parent wins; its switch lands), whatever page the child flipped to — a disabled page included; the navigation is discarded, not recorded |
| 9 | anchor disabled | IGNORED (recorded as the human's page) |
| 10 | the device's run of *conflicts* exceeds 12 | IGNORED conflicting-anchors (warn). A conflict is a page reporting two indices: a second index appearing before the first has disappeared, or two indices disappearing together. A page carrying a copied anchor with the wrong index does both; two such pages on two devices drive each other forever, and the breaker stops that however slowly the app applies switches and whichever anchor the app reports first, because the run is counted structurally, not within a time window. A run ends with a real page change — a disappear group with a single index. The group is read at the next real page change, once the page the device went to is known; a page of it reported again before that (a return, rule 3: the app re-emitting a shown page, a folder or a page without an anchor opened and closed on it) is taken out, and the rest is held back (`closed`) until a real change comes — or comes back too, in which case there was nothing to read. It never fires on ordinary flipping, however fast, in either appear/disappear order (below), nor on folders or re-emits. **10b, the driven-send breaker (children only):** a send is *driven* when it follows from a switch rather than from a person — made while a switch from another deck to a *different* page of this device, issued after the device's last landing, has not shown (in flight, or expired without an appear: the switch that moved the deck here, reported under a wrong index), or made from a visit a switch landed on (a second anchor on that page). A run of driven sends with no clean send between (`OVERTURN … n/12`, debug) is cut off the same way (`IGNORED reason=overturned-switches`, warn), and a landing never lifts the cut-off: the loop's own landings would. People make driven sends — a flip while a slow switch is landing — but soon make a *clean* one: nothing outstanding, no landing on the visit, the only index on it; with appears reported first the old page is still on the visit, so such a send is settled by the disappear group of the visit it was made from (`OVERTURN? …`, debug) — the group holding the landed page (`drivenPage`), which with appears first is *not* the next group read (that is the previous page's trailing disappear, which says nothing about this visit): one index left alone confirms a flip, two left together a second anchor on a page a switch landed on. A send that only looked driven because the old page was still on the visit (`cleanPending`) is clean once nothing but the page it went to remains on the visit when a single-index group is read. What never makes a clean send is a loop: one wrong anchor per child across three children (each child alternates a real landing with a mislabelled one, which used to reset the run), or pages cross-labelled across two children — all single-index pages, out of the conflict breaker's sight. Every such cycle has a child sending in turn, so cutting that child off breaks it; the parent is never cut off (PRD §6.3.3) — not even after a child's coalesced burst left tags on it that no landing will clear. Either ignored navigation is still recorded as the person's page (like a disabled or unscoped one), so a stale switch landing afterwards restores it |
| 11 | otherwise | **SEND** |

The breaker's bookkeeping: `visit` holds the indices reported by appears and not yet left;
`leaving` the indices that disappeared since the last real page change (the open group). A human
appear whose index differs from one already in `visit` is a conflict (`CONFLICT … also=[…]`,
debug); a disappear group that still holds two or more indices when a real page change reads it,
after the pages that came back meanwhile (a re-emit, a folder closing — returns, rule 3) are taken
out, is one too (`CONFLICT … pages=[…]`). Every human send checks the run, so a device caught in a
cycle stops sending once the run exceeds 12 (its 13th conflicting send is ignored; 12 go through)
and resumes after it passes a page with a single anchor (the next real page change after a
one-index disappear group resets the run). If the app emits a page's appear before the previous
page's disappear, an ordinary flip counts as one conflict for a moment, and the single-index
disappear that follows resets it at the next flip, so nothing accumulates; a folder opened and
closed on the new page adds that page to the group, and its return takes it out again (what
remains waits for the next real change). Hardware check C-11 records which order the app uses.

Everything that is not an echo or startup is human (PRD §6.3.2). No rule consults elapsed time
to tell a RECEIVE from a SEND, and none to trip the breaker; expiry only ends suppression and
prediction.

### Anchor edits

Editing a visible Page Anchor's settings in its Property Inspector (page index or enabled)
reaches the engine as `onAnchorUpdated` (guarded like the appear handlers: `UNEXPECTED
handler=onAnchorUpdated`): the device is showing that page, so its page is recorded as the new
index (or forgotten when the index is cleared), the device is armed when an index is set
(clearing it only forgets the page), the once-only missing-index warning for that anchor is re-armed, and a switch to that index still awaiting
a landing counts as landed — but only when it is the oldest switch the engine still remembers
for the device: an older switch to another page would show first and bring the device back
here later, with an appear that must still find its entry, so it stays expected. Nothing is sent — editing
is not navigation. The log line is `ANCHOR updated` (info). Without this a corrected or newly
typed index would be unknown to the engine until the page's next appear, so fan-outs to that
device could be skipped as already-there or dangle.

`onDisappear` nulls `lastKnownPage` only when the engine still believes the device is on
that page, so the order of appear(new)/disappear(old) does not matter. It ages the device's
entries (ageing is lazy). A switch to the page being left that is still in flight has been
overtaken — the device was on the page without the switch ever showing — **unless the engine
can explain the departure**: a RECEIVE just moved the device to another page (the app reports
the new page's appear before the old page's disappear), or a switch to another page is queued
ahead of it (the app is working through a backlog, and this one is next). An overtaken switch
becomes a tag for the grace period (`GC … reason=left-page`, debug; `left=true` on the
RECEIVE that consumes it): it no longer suppresses or predicts, and the person's return to
that page is swallowed once at most, never read as a stale landing and fought. An explained
one stays expected. `onDisappear` never touches `armed`.

## SEND

1. `seq++`.
2. For every other member: map the page (below); skip with a log line when there is no
   counterpart, the device is disconnected (warn), it has no profile (warn), or it is
   already on that page (`already-there`). "Where it will be" is the tail of its switches still
   in flight (expected, or detached by a settings change) — but only if the stale rule will honour them, i.e. at least one was issued after
   the device's own last navigation; entries that all predate it would be undone when they
   land and predict nothing, so `lastKnownPage` is used instead. When a parent is skipped
   because a switch not issued by the parent (a child's, or the device's own stale-switch
   restore) already carries the target there, that entry is promoted to parent origin — and, if
   a settings change had detached it, expected again — so the child stays suppressed until it
   lands (PRD §8.6). Otherwise push a pending entry
   **before** calling `switchToProfile`. A target that throws (e.g. the device directory) is
   skipped with `reason=error`; the others proceed.
3. Record `lastHumanSeq/lastHumanPage` on the source once the fan-out is planned, so a failure
   inside the handler leaves no half-recorded navigation.
4. A rejected switch removes its entry and warns with the fix; nothing throws. The SDK
   resolves as soon as the request is written, so `SWITCH sent` (debug) is not a landing —
   the RECEIVE line is.

## Parent precedence, precisely

- *Expected* is per target device: a pending entry is expected from the moment it is pushed
  until its appear lands, a landing on that device passes it by (superseding it: it was
  issued before the switch that landed, or repeats that page with no other page between),
  the device leaves that page without a RECEIVE or an earlier queued switch explaining the
  departure (`GC … reason=left-page`), the switch is rejected, the device disconnects, a
  settings change takes its origin's standing away (it is detached), the cap turns it into a
  tag, or the TTL marks it expired. An expired entry is still an echo tag but is no longer
  expected. A *detached* entry is still in flight (and so never deduplicated as a tag; it keeps
  its place in the order): its origin no longer stands in the same
  relation to the device (the device left every scope, the origin left its scope, or a
  parent-issued switch's origin is no longer the parent), so it no longer suppresses a child,
  but it still predicts where its device will be and, if it lands after the device's own
  later navigation, it is undone like any other, until the TTL ages it.
- *Conflict*: a human appear on a **child** that has an expected entry with origin `parent`.
  The child's navigation is suppressed — no fan-out, not recorded as a send — and the
  parent's switch lands as a normal RECEIVE. Once that switch has landed (or expired, or the
  child left its page unexplained) the child may lead again. This is per device, not scope-wide: a child whose own switch has
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
(`SWITCH unconfirmed …`), past `pendingGraceMs` (default 30 s) it is dropped — a
superseded or left-page tag the grace period after the landing or the disappear that wrote
it off. One tag per *run* of switches to a page is kept: of two tags for the same page with
nothing between them the newer suffices, but a tag with another page's entry between it and
the next tag for its page stays, because an app working through a backlog shows the page
again after that other page and that landing must find a tag too (`GC … reason=duplicate-tag`
for the one dropped). Tags are bounded at the cap's worth for every TTL of the grace period
(500 by default; `GC … reason=tag-cap` drops the oldest), and past `maxPendingPerDevice` (50)
still-expected entries the oldest become tags too (warn), so memory is bounded without ever
forgetting that a switch was issued — neither the cap nor a coalesced burst nor a stalled app
applying its backlog late can turn a landing into a SEND.

An expired entry no longer suppresses a child and no longer counts as where the device will
be, but it **remains an echo tag**: a landing that arrives later than the TTL (an app stall,
sleep/wake, a slow profile switch) is still a RECEIVE (`late=true`) and can never be
mistaken for human navigation and rebroadcast — the first review of this engine found
exactly that defect when expiry simply deleted the entry. Time therefore never decides
whether an appear is an echo; it only ends suppression and prediction. When the same page
is switched to again while an older tag for it is still kept, the landing matches the tag —
the oldest switch to the page, which an app working through its backlog applies first (rule
4) — and the fresh reissue stays expected until it shows in its turn, or times out. A tag never
fights: it is not in flight, so it cannot restore against the person's own return to its
page. Switches issued after the matched one are never superseded by that landing — only by a
later landing passing them by, by expiring, or by the device leaving their page unexplained —
so a parent's burst keeps its precedence until every page of it has shown or timed out, and a
backlog the app drains slowly lands as RECEIVEs throughout (`late=true` past the TTL).

The bounded cost is the inherent ambiguity of an unconsumed tag, and it has two faces:

1. A human navigation to exactly the page of a dangling entry, within the grace period, is
   swallowed once as a RECEIVE (the scope is then out of step until the next flip). Within
   the first 3 s, while the tag is still expected, such a flip can additionally trigger a
   restore if it follows another human navigation on the same device (the deck jumps back
   once); after the TTL a match is only ever swallowed, never fought. Superseded entries are
   tags too (for the grace period after the landing that superseded them, like every other
   tag — a shorter life would let a backlog slower than the TTL rebroadcast the switch it
   wrote off), so a flip within 30 s to a page the app skipped in a coalesced burst is
   swallowed as well; a page the device left before the switch to it showed keeps its tag
   for the grace period, so a return to it within 30 s is swallowed once. When a tag and a
   later switch to its page sit next to each other (a person's flip swallowed what stood
   between), the appear matches the tag and the switch is written off with it: if the
   appear was the switch's own landing, a flip to that page within 30 s is swallowed once
   more, and nothing stays expected on it. The converse ambiguity is not
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
configuration and keep `armed`/`lastKnownPage`/last send. A still-expected pending entry
whose origin keeps its standing under the new settings — the origin and the target are
still in one scope and a parent-issued switch's origin is still that scope's parent — stays
expected: a rename, another scope, a profile or page-count change or a mapping change never
costs the parent its precedence over a switch that is landing. An entry whose origin lost
its standing is detached (marked `detached`, counted as `detachedPending=n`): it no longer
suppresses a child, but it stays an echo tag and, being still in flight, still predicts
where its device will be and is undone by the stale rule if it lands after the device's own
later navigation, until the TTL ages it; already-expired tags keep their mark, and a
restore the engine issued for the device itself (origin `self`) is never detached. A reload
that changes nothing is ignored, because the global-settings event also fires for plain
reads. A switch that lands after a reload is therefore still a RECEIVE. After start, an
unusable settings payload (not an object, wrong version, or `scopes` not an array) is
ignored with a warning rather than replacing a working configuration with zero scopes
(`createGlobalSettingsHandler` in `src/piBridge.ts`); before start the event is ignored
because the start-up load applies the settings. A save from the PI that arrives before
`start()` has begun is held and becomes the start configuration (`SETTINGS applied
(start)`), then re-applied afterwards as a no-op (`SETTINGS unchanged (update)`, debug); a
save that lands while `start()` is still replaying is applied right after it as a real
`SETTINGS applied (update)` (its `detachedPending` counts only replay switches whose origin
lost its standing under the saved configuration — 0 when the save keeps the scope — and only
those land as `RECEIVE … detached=true`) (`src/plugin.ts`). If Stream Deck never
answers the start-up read, the plugin starts with defaults after 15 s (warn) and applies
the settings when the reply finally comes — through the event, or, if the reply lands while
`start()` is still replaying, through the read itself once start has finished — unless the
panel has saved meanwhile: a save is newer than anything the read can answer, so the late
reply is then dropped (`Settings: the late reply is ignored …` / `global-settings event
ignored …`, debug). The engine
counts as started only once the replay has drained: a navigation that arrives while the
replay awaits the app's acknowledgements joins the queue and is replayed next, under the
normal rules (so it can be suppressed by a switch the replay genuinely issued before it).

## Logging

Every line is `EVENT key=value …`; the code is canonical, this is the index.

| Level | Events |
|---|---|
| info | `START` (with `queued=n`), `SETTINGS applied`, `SEND` (device, role, scope, page, canonical page, seq, targets, skips), `RECEIVE` / `RECEIVE_STALE` (device, page, seq, origin, scope; at most one flag: `late=true` after the TTL, `detached=true` after a settings change that took its origin's standing away — it becomes `late=true` once the TTL has passed —, `capped=true` for an entry the cap turned into a tag, `superseded=true` for an earlier switch to the same page overtaken by a later landing on it, `left=true` for one whose page the device had left before it showed), `STARTUP`, `SUPPRESSED`, `ANCHOR updated … page=<before>→<after> enabled=… (no sync)` — with `(consumed seq=n)` when a switch to that index was pending, or `page=…→none (page index cleared; …)` when the index was blanked —, `IGNORED reason=disabled`, `SKIP reason=no-counterpart`, `DEVICE connected` (for a device not yet armed: new, or after a disconnect), `DEVICE disconnected` (`droppedPending=n`, plus `droppedQueued=n` when pre-start navigation was discarded) |
| warn (with an actionable clause) | `IGNORED reason=no-scope` (once per device per settings version), `IGNORED reason=no-page-index` (once per anchor), `IGNORED reason=conflicting-anchors` / `overturned-switches`, `SEND … reason=beyond-page-count` (once per device and page: the flipped-to page is beyond the device's configured page count, so nobody can follow), `QUEUE full` (the oldest pre-start navigation dropped), `SKIP reason=disconnected` / `no-profile` / `error`, `SWITCH failed`, `SWITCH unconfirmed` (logged lazily, the next time the engine touches that device at least 3 s after the switch), `GC reason=cap` (more than 50 still-expected switches to one device; the oldest become tags only) |
| debug | `SETTINGS unchanged (update)`, `QUEUED … reason=not-started`, `CONFLICT` (`… also=[…]`: a second index on one page visit; `… pages=[…]`: two indices that left one page together, read at the next appear), `OVERTURN` (`… outstanding=[…]`: a send while another deck's switch to this device has not shown; `… pages=[…]`: a second index on a page a switch landed on, read at the next appear), `DEVICE connected (already armed)`, `OVERTURN?` (a send the next disappear group settles), `GC reason=revived` (a superseded switch showed after all), `IGNORED reason=duplicate` (also `(already queued)` before start) / `multi-action` / repeated `no-scope` / repeated `no-page-index`, `QUEUED … (replaces the disabled anchor's appear queued for this page)`, `SKIP reason=already-there` / `queued-later`, `SWITCH sent`, `LEAVE` (plain, or `(left before the settings loaded)` after a replay), `GC reason=superseded` (kept as a tag) / `left-page` / `grace-elapsed` / `duplicate-tag` (a newer tag for the page follows with nothing between) / `tag-cap` (more than 500 tags on one device; the oldest dropped) |
| error | `UNEXPECTED handler=onAppear …` / `onDisappear …` / `onAnchorUpdated …` (caught, never rethrown: the appear is dropped — reported to its caller as IGNORED reason=error, with no further log line — and a disappear or anchor edit changes nothing) |

Under the plugin's `DeckSync` scope (`src/piBridge.ts`, `src/plugin.ts`): `Settings saved:
n scope(s).` (info); `Settings: …` at warn for a rejected scope and why, a save from the
panel rejected with n problem(s) or because it carried no usable settings, a save that could
not be written (`Could not save settings (…)`), a start-up read that failed (`could not read
global settings (…); using defaults`), an unusable global-settings payload ignored after
start, no reply to the start-up read within 15 s, and no reply within 15 s to a panel's read (not answered; the panel retries); at debug for a global-settings event
before start, and for a global-settings event or the late start-up reply ignored because the
configuration saved from the panel is already applied; `PI: …`
(warn when a reply could not be sent; debug when no panel is open or a message is
unknown, or a request came from a panel that is no longer the open one — the reply goes to
the open panel, so the panel that asked reports no reply); `Devices: connect event for a
device the SDK does not know; ignored` / `… disconnect event …` (debug: a device event
without a device object, which the SDK can emit); `Startup failed: …` (error).

## What only hardware can confirm

1. The app applies several `switchToProfile` calls to one device in order (or shows only the last). Test: manual check C-11 (parent 0→1→2→1→0 as fast as possible; the child must end on 0, and the log records whether the intermediate pages appeared).
2. Whether a switch to the page a device is already on emits `willDisappear`/`willAppear` again (a re-emit). Either way works: no appear leaves the switch to expire into a tag (routine `SWITCH unconfirmed` warnings would instead mean an anchor is missing or a profile is not bundled); a re-emit — a page of the open disappear group reported again while nothing new has appeared since (the page's own anchor and any copied one on it, whichever reports first) — is a duplicate (rule 3), which stands for the no-op switch when that is the oldest outstanding and otherwise leaves the backlog untouched, so a backlog behind it still lands as echoes. A re-emit after a copied anchor's send used to be read as a clean flip that reset the driven-send breaker, which let copied anchors on three decks cycle for ever with a slow, re-emitting app (R15); the return rule closes that, and a fuzz of random copied-anchor layouts (three decks, 50 ms–7 s per switch, re-emits on and off, either event order) finds no cycle the breakers do not cut. The cost is that leaving to a page without an anchor and coming straight back is read as a duplicate once (item 3) — after start only: before start every navigation is queued, so a flip back to the page a trailing disappear just reported (appears first) is replayed too. Manual check C-11 records it (a `LEAVE dev=C page=N` debug line followed by `IGNORED dev=C page=N … reason=duplicate`).
2a. `isConnected` comes from `deviceDidConnect`: the SDK lists registration-time devices as not connected until that event arrives, so a flip made before a member's connect event skips it with `SKIP … reason=disconnected`. The arming logic itself does not depend on the order of connect events and appears (a connect for a device that never disconnected, or whose reconnect burst already arrived, does not disarm it).
2b. Echo latency: a landing later than 3 s is absorbed as a late RECEIVE (manual check C-12); if late echoes are routine, raise `pendingTtlMs`. The engine's knobs are constructor options passed to `new SyncEngine(...)` in `src/plugin.ts`, not user settings — defaults: `pendingTtlMs` 3000, `pendingGraceMs` 30000 (never shorter than the TTL: a smaller value is clamped up to it), `maxPendingPerDevice` 50 (still-expected switches; echo tags are bounded at that many per TTL of the grace period, 500), `drivenSendMax` 12 (bounds both breakers), `maxQueuedBeforeStart` 20.
2c. Wrong page indices come in two shapes, and each has its breaker. Copied anchors make a page report two indices: a single one silently overturns a navigation (manual check C-15), a cycle of them trips the conflicting-anchor breaker (warn) once a device's run of conflicts exceeds twelve (its 13th conflicting send is ignored; 12 go through), however slowly the app applies switches and whichever anchor it reports first. A page whose *only* anchor reports the wrong index shows a single index, so the conflict breaker never sees it. With two decks one such page per deck cannot cycle: a re-emit of the shown page is a duplicate (item 2), and without re-emits a mislabelled landing meets one of the deck's own unconsumed echo tags within a few hops. Across three children one wrong anchor per child does cycle (each child alternates a real landing with a mislabelled one), as do pages cross-labelled across two children; both are runs of *driven* sends (rule 10b) and trip the driven-send breaker at a child's thirteenth driven send with no clean flip between (12 go through) — a landing never lifts the cut-off, since the loop's own landings would. A backlog so deep that switches land later than the grace period (30 s) is beyond both breakers by design; a child cut off resumes after a flip made with nothing outstanding from a page it was not switched to (every unshown switch issued before its last landing is passed by, not counted). The fix is always the anchor, not the engine.
2d. Whether the app emits a new page's appear before or after the old page's disappear. Both orders are handled: for the breakers an appear-first flip counts as one conflict until the single-index disappear that follows, after which the next real page change resets the run, a folder or a page without an anchor opened and closed on the new page leaves a two-index group (old page, new page) that the new page's return takes itself out of — in disappear-first order the same folder leaves a one-index group — so neither order ever accumulates, and a send deferred by rule 10b waits for the group of its own visit, so the trailing disappear read at the next landing never settles it (R15-F1: without that, one copied anchor per child across three children cycled for ever with appears first); for the left-page rule a disappear that follows a RECEIVE is explained by it. Manual check C-11 records the order the app uses (a `LEAVE` debug line between P's `SEND` lines means disappear first; none means appear first).
2e. Settings saved while a switch is in flight (manual check C-13: a rename keeps the switch expected — `detachedPending=0`, a plain `RECEIVE`; swapping the parent detaches it — `RECEIVE … detached=true`; never a send) and navigation before the settings have loaded (C-14: `QUEUED`, then replayed by `START`).
3. `willDisappear` fires for every left page. A return from a page without an anchor is read as a duplicate once either way (the re-emit rule, item 2); if disappears were missing, `lastKnownPage` would also go stale until the next flip and no disappear group would ever close; the fallback is de-duplicating on action id instead of page.
4. The launch burst is one appear per anchor on each device's *current* page. If the app also emits appears for other pages at launch, `lastKnownPage` could be wrong until the first flip.
5. Whether editing a page in the Stream Deck editor emits appears without navigating the device.
6. The page a device returns to on reconnect (the engine deliberately does not auto-correct — PRD §7.3 MUST).
7. The app's behaviour for a page index beyond the profile's page count (reject vs. clamp); `pageCount` keeps the engine from asking.
8. How often a coalesced burst leaves dangling tags (the swallowed-navigation cost above).
9. The visible flicker in a true cross-fire (parent briefly shows the child's page, then its own).
10. Folder anchors (Spike-1): until then, anchors inside folders should be disabled or left without a page index.
11. Whether the app still applies a `switchToProfile` issued just before a device disconnected once it reconnects (manual check C-7 flips P while C is unplugged). The engine forgets a disconnected device's switches (`DEVICE disconnected … droppedPending=n`), so such a late landing would be a SEND — harmless while the rest of the scope is already there, and worth keeping as tags if the app does replay them.
12. Whether merely opening a Page Anchor's Property Inspector reaches the plugin as `didReceiveSettings` (the panel asks for its settings on open; the SDK forwards every such event to `onAnchorUpdated`). If it does, every PI open logs `ANCHOR updated … page=N→N (no sync)` and counts as an anchor edit (arming the device, resetting its overturn run and its visit record — the conflict run is kept); manual check Gate B records it, and "edited" becomes "opened or edited" in the README and PRD.
