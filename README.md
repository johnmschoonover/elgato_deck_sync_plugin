# Deck Sync

Automatically synchronize pages across multiple connected Stream Deck devices. Place a Page Anchor on any page of your primary device, and when that page becomes active, your secondary device(s) will automatically navigate to the matching profile.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Setup](#setup)
  - [Step 1: Configure the Plugin](#step-1-configure-the-plugin)
  - [Step 2: Place Page Anchors](#step-2-place-page-anchors)
  - [Step 3: Configure Scopes (Optional)](#step-3-configure-scopes-optional)
- [How It Works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)

## Features

- **One-touch synchronization**: Place a Page Anchor on any page and secondary devices follow automatically.
- **Device-specific targeting**: Choose to sync all connected devices or target a specific device.
- **Scope-based sync**: Define device groups (scopes) and create profile mappings to control which profiles sync together.
- **Loop prevention**: Intelligent send/receive classification prevents sync loops during startup and plugin-initiated navigation.
- **Parent precedence**: When a parent device initiates a sync, it overrides any in-flight changes on child devices.

## Installation

### Prerequisites

- **Stream Deck software** version 7.1 or later
- **macOS 13.0+** or **Windows 10+**
- **Node.js 24** (bundled with the plugin — no separate installation required)

### Step-by-Step

1. **Build the plugin** (if you haven't already):
   ```bash
   cd /path/to/elgato_deck_sync_plugin
   npm install
   npm run build
   ```

   This compiles the TypeScript source into `com.johnmschoonover.decksync.sdPlugin/bin/plugin.js`.

2. **Install the plugin**:
   - Open Stream Deck
   - Go to **Stream Deck → Preferences → Plugins**
   - Click the **"+"** button at the bottom (or "Open Folder")
   - A file browser will open to your Stream Deck plugins folder
   - Copy the entire `com.johnmschoonover.decksync.sdPlugin/` folder into this plugins directory

3. **Restart Stream Deck** to load the plugin.

4. **Verify installation**:
   - The "Deck Sync" category should appear in the plugin category list on the left sidebar
   - Click it to see the "Page Anchor" action

## Setup

This guide assumes you have **two Stream Deck devices**: a primary (main) device and one secondary device.

### Step 1: Configure the Plugin

1. **Open the plugin settings**:
   - In the left sidebar, click **"Deck Sync"** (the plugin category)
   - Click **"Settings"** at the bottom of the sidebar

2. **Configure the global settings**:
   - The Property Inspector panel on the right will open the global settings page
   - You'll see sections for **Scopes**, **Roles**, and **Mappings**

3. **Create a scope** (recommended):
   - A scope groups devices that should sync together
   - Click **"Add Scope"**
   - Give it a name (e.g., "My Setup")
   - Select your two Stream Deck devices from the device list
   - Click **"Save"**

4. **Create a profile mapping** (required for sync to work):
   - Click **"Add Mapping"**
   - **Source Profile**: Enter the exact name of a profile on your primary device (case-sensitive)
   - **Target Profile**: Enter the matching profile name on your secondary device
   - **Enabled**: Check the box to activate this mapping
   - Click **"Save"**

   > **Example**: If your primary device has a profile named "Work" and your secondary device has a profile also named "Work", enter "Work" in both fields.

### Step 2: Place Page Anchors

1. **Select a page on your primary device**:
   - Navigate to any page on your primary Stream Deck

2. **Add the Page Anchor action**:
   - In the left sidebar, click **"Deck Sync"**
   - Click the **"Page Anchor"** action to place it on the page

3. **Configure the Page Anchor**:
   - The Property Inspector panel will open with the Page Anchor settings
   - **Enabled**: Check to activate this anchor
   - **Sync device**: 
     - Select **specific device** from the dropdown if you want to target one device
     - Leave as **"All other devices"** to sync all connected devices except this one
   - **Profile name**: Enter the exact name of the profile to sync to (must match a configured mapping)

4. **Repeat for each page**:
   - Place a Page Anchor on every page where you want secondary devices to follow
   - Make sure each anchor's "Profile name" matches a profile on your secondary device

### Step 3: Configure Scopes (Optional)

If you have more than two devices or want more granular control:

1. **Define multiple scopes** in the global settings:
   - Group devices by function (e.g., "Video Editing", "Streaming")
   - Each scope contains a set of device IDs

2. **Create role-based mappings**:
   - Define what each device's role is (primary, secondary, monitor)
   - Create mappings that map source profiles to target profiles within a scope

3. **Enable/disable mappings**:
   - Toggle individual mappings on/off without deleting them
   - Useful for temporary configurations

## How It Works

The plugin uses a **page anchor** concept:

1. **Primary device navigates** to a new page
2. The Page Anchor action's `onWillAppear` handler fires
3. The plugin checks if there's an in-flight switch (loop prevention)
4. If no loop detected, it resolves the profile mapping
5. It calls `switchToProfile()` on the target device(s)
6. The target device(s) navigate to the matching profile
7. A `SendToPlugin` event prevents the secondary device's anchors from triggering a feedback loop

### Scope-Based Sync

When scopes are configured, the sync engine:

1. Resolves the source profile to a scope
2. Finds all child devices in that scope
3. Looks up the target profile for each child
4. Fires `switchToProfile()` calls in parallel to all children

## Troubleshooting

### Plugin doesn't appear in Stream Deck

- **Verify the plugin folder is in the correct location**: `~/Library/Stream Deck/com.johnmschoonover.decksync.sdPlugin/` (macOS) or `Documents/Stream Deck/plugins/com.johnmschoonover.decksync.sdPlugin/` (Windows)
- **Check for errors**: Open Console.app (macOS) or Event Viewer (Windows) and look for Stream Deck plugin errors
- **Reinstall**: Remove the plugin folder, restart Stream Deck, and reinstall

### Secondary device doesn't sync

1. **Check the profile names match exactly** (case-sensitive)
2. **Verify the mapping is enabled** in the global settings
3. **Ensure the Page Anchor is enabled** on the primary device
4. **Check device connectivity**: Both devices must be connected simultaneously

### Sync loop or rapid navigation

The plugin includes loop prevention, but if you still see issues:

- **Clear in-flight switches**: Restart the plugin by removing and reinstalling
- **Check for circular mappings**: Make sure you don't have overlapping scopes that create cycles
- **Verify parent precedence**: If a primary device is triggering syncs, it should override child changes

### Property Inspector doesn't load

- **Reload the Property Inspector**: Click on the action again
- **Check browser-based rendering**: The Property Inspector uses Stream Deck's embedded browser
- **Verify file paths**: Ensure `ui/anchor.html` and `ui/propertyInspector.html` exist in the plugin folder

## Known Limitations

- **One action type**: Currently only the "Page Anchor" action is implemented. Future versions may add more action types.
- **Manual configuration**: Device IDs and profile names must be configured manually. There's no automatic device discovery yet.
- **No cloud sync**: Settings are local to the plugin's data directory. Moving to a new computer requires reconfiguration.
- **Profile names must match exactly**: The plugin does fuzzy matching—names must be identical across devices (case-sensitive).

## Development

### Building

```bash
npm run build      # Compile to production
npm run watch      # Watch mode with automatic restart
```

### Testing

```bash
npm test           # Run Jest tests
```

### Contributing

This is a personal plugin. If you have suggestions or bug reports, feel free to reach out.

## License

[Add your license here — e.g., MIT](LICENSE)