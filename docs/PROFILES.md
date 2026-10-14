# Bundled profiles — authoring procedure (Epic D1, **[gate]**)

Deck Sync can only drive a device into a profile that ships **inside the plugin** and is
listed in `manifest.json → Profiles` (PRD §4.1). Users build their layouts inside these
bundled profiles. This page is the contract for authoring them and the manual procedure
for exporting them from the Stream Deck app; it cannot be done headless.

## The contract

| Item | Rule |
|---|---|
| One profile per device type | Original/MK.2, XL, Mini, Neo and + (PRD §7.4). **Exported so far (2026-10-14, on John's hardware): `profiles/original` and `profiles/plus`.** Mini, XL and Neo keep their default names in `src/profiles.ts` but are not registered in the manifest until a device of that type is available to export from (the registration test allows exactly that). Any other device type (Studio, Plus XL, …) has no default: set its *Profile* in the configuration UI. |
| Page count | **5** top-level pages (PRD §10 OQ-2). |
| Marker placement | **Exactly one Page Anchor per page**, on the top-left key (column 0, row 0). Several anchors with the *same* page index on one page count as one navigation and merely waste keys; anchors with *different* indices on one page each send (manual check C-15) and, copied onto two decks, can trip the conflicting-anchor breaker. |
| Anchor settings | `{ "pageIndex": N, "enabled": true }` where `N` is the **0-based** index of the page the anchor sits on. The Property Inspector sets these. |
| Display name | `Deck Sync — <Device>` (PRD §7.4), e.g. `Deck Sync — Original`. |
| File name | `profiles/<device>.streamDeckProfile` inside the `.sdPlugin` folder. |
| Manifest `Name` | `profiles/<device>` — the file path **without** extension. This exact string is what the engine passes to `switchToProfile`. |

| Device | `DeviceType` | File | Manifest `Name` |
|---|---|---|---|
| Stream Deck (Original / MK.2, 15 keys) | 0 | `profiles/original.streamDeckProfile` | `profiles/original` |
| Stream Deck Mini (6 keys) | 1 | `profiles/mini.streamDeckProfile` | `profiles/mini` |
| Stream Deck XL (32 keys) | 2 | `profiles/xl.streamDeckProfile` | `profiles/xl` |
| Stream Deck Neo (8 keys) | 9 | `profiles/neo.streamDeckProfile` | `profiles/neo` |
| Stream Deck + | 7 | `profiles/plus.streamDeckProfile` | `profiles/plus` |
| Stream Deck Studio (no default) | 10 | — | set *Profile* by hand, or add a row to `DEFAULT_PROFILE_BY_DEVICE_TYPE` in `src/profiles.ts` and pin it in `src/tests/profiles.test.ts` |
| Stream Deck + XL (no default) | 13 | — | as above |

(`@elgato/schemas` also numbers the Virtual Stream Deck 11 and the Galleon 100 SD 12; neither
has pages to sync.) The engine resolves a scope member's profile from its `profile` setting,
or, when that is blank, from the device type using the `Name`s above (see `src/profiles.ts`).
Any other device type must have `profile` set explicitly in the configuration UI. **Every profile
registered in `manifest.json → Profiles` must appear in `DEFAULT_PROFILE_BY_DEVICE_TYPE`, and a
default is registered exactly when its `.streamDeckProfile` exists on disk**
(`src/tests/profiles.test.ts` enforces both). Landing a new export is therefore a two-place
change: copy the file into `profiles/` and add its manifest entry. A new device *type* also
needs a row in the table and the key pin in the test. "Set its *Profile* manually" is only for
a profile that is *not* bundled under its device type's default name.

## Procedure (Stream Deck app, plugin installed and loading — after gate A3)

1. **Create the profile.** Preferences → Profiles → **+** → name it `Deck Sync — <Device>`,
   assign it to the matching device.
2. **Add the five pages.** With the profile selected, use the page controls at the bottom of
   the canvas to add pages until there are 5.
3. **Place the anchors.** On each page, drag **Deck Sync → Page Anchor** onto the top-left
   key. In its Property Inspector set *Page index* to `0, 1, 2, 3, 4` respectively and leave
   *Enabled* on. Optionally title the key (`Page 1` …) — users can retitle later.
4. **Export.** Preferences → Profiles → select the profile → **⋯ → Export…** → save as
   `<device>.streamDeckProfile`.
5. **Bundle.** Copy the file to `com.johnmschoonover.decksync.sdPlugin/profiles/`.
6. **Register.** Add an entry to `manifest.json → Profiles` (create the array if absent):

   ```json
   "Profiles": [
     { "DeviceType": 0, "Name": "profiles/original" },
     { "DeviceType": 7, "Name": "profiles/plus" }
   ]
   ```

   (Mini `1`, XL `2` and Neo `9` join the list when their exports exist.)

   `AutoInstall` defaults to `true` (offered on install, PRD §7.4; the schema says the field
   needs app 6.6+, below our 7.1 floor); leave `Readonly` unset so
   users can customise button content. `DontAutoSwitchWhenInstalled` defaults to `false`, so
   the app switches each device to the bundled profile right after installing it — the
   intended zero-config path (PRD §8.6); set it to `true` only if gate D3 shows that is
   unwelcome.
7. **Verify headless.** `npm run validate` must pass (manifest + referenced files).
8. **Verify on hardware (D3).** Reinstall the plugin: Stream Deck should prompt to add the
   profiles; they appear under Preferences → Profiles; with two devices in one scope,
   flipping pages on either drives the other (see `docs/MANUAL_TESTS.md`).

## History

The repository previously held four hand-written JSON files named `*.streamDeckProfile`.
Exported profiles are zip archives containing an `.sdProfile` directory tree, so those
files could never install; they also carried the superseded per-anchor settings. They were
removed, together with their manifest entries, so the plugin validates and loads cleanly
until real exports exist.
