# Spike-1 — subpage (folder) targeting **[gate]**

**Status: pending hardware.** Nothing provable headless answers this question.

## Question (PRD §4.2, §7.5)

1. Can `streamDeck.profiles.switchToProfile(deviceId, profile, page)` land a device **inside
   a folder** via the flat `page` index, or does the index only address top-level pages?
2. When a user enters a folder by hand, does the folder's Page Anchor `onWillAppear` carry
   enough identity (its `pageIndex` setting) to map reliably?

## What the SDK types say (and don't)

`switchToProfile(deviceId: string, profile?: string, page?: number)` — `page` is documented
as a flat 0-based page index, app ≥ 6.5. Neither the SDK types nor `@elgato/schemas` mention
folders or subpages anywhere. A previous note in this repo (`src/SPIKE1_FINDINGS.ts`, now
removed) concluded "switchToProfile supports subpages" from the mere presence of the `page`
parameter; the parameter's existence says nothing about folders, so that conclusion was
withdrawn. Until the spike runs, sync operates at **top-level page** granularity only
(PRD §4.2, OQ-12).

## Procedure

Prerequisites: plugin loads (gate A3); one bundled profile with 5 pages exists (D1); the
device under test is a **child** in a scope whose parent is another device; plugin log
visible (`com.johnmschoonover.decksync.sdPlugin/logs/`).

**Part A — detection.**
1. On the child's bundled profile, page 0, create a folder and inside it place a Page
   Anchor with *Page index* `9` and *Enabled* **off** (so it never SENDs).
2. Enter the folder by pressing its key. Expect `IGNORED dev=<child> page=9 scope=… reason=disabled`
   (info) — the appear fired and was classified. Record whether it appeared at all.
3. Leave the folder. Record whether the page-0 anchor's appear fires again: expect
   `SEND dev=<child> … page=0 …` (the child led back to page 0; the parent is skipped as
   `already-there` if it is still on 0, otherwise switched). That SEND is correct, not a bug.

**Part B — driving.**
0. In the configuration UI set the child's *Pages* to `10` and Save (overrides beyond a
   device's page count are rejected).
1. Add an override pairing parent page `1` ↔ child page `9` and Save.
2. Flip the parent to page 1 by hand. Watch the child and the log:
   - lands inside the folder → **works**: `RECEIVE dev=<child> page=9 …` (the flat index
     reaches folder pages; note which index did it: 5? 9? another?);
   - stays put / switch rejected (`SWITCH failed` or `SWITCH unconfirmed … page=9`) → **doesn't**;
   - lands on an unexpected top-level page → **partial** (record the mapping observed; the
     landing shows as a `SEND` from the child for that page).
3. Repeat with override `1 ↔ 5` and `1 ↔ 6` to probe whether folder pages are numbered after
   the top-level pages.

## Result

_To be filled in by John after the run:_

- Part A detection: works / doesn't — notes:
- Part B driving: works / doesn't / partial — indices tried and where the device landed:
- Recommendation: keep subpage sync a Non-Goal (model contexts as top-level pages) / add
  folder targeting (specify how a folder page is addressed):
