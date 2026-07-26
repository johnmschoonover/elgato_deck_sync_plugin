import streamDeck, {
  action,
  SingletonAction,
  WillAppearEvent,
  SendToPluginEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";

/**
 * Settings stored per Page Anchor action instance.
 *
 * targetDeviceId  - The Stream Deck device ID to navigate when this page appears.
 *                   Leave blank to sync ALL other connected devices.
 * targetProfile   - Name of the plugin-bundled profile to switch to on the target device.
 *                   Must match the "Name" field in the manifest's Profiles array exactly.
 * enabled         - Quick on/off toggle.
 */
interface AnchorSettings extends JsonObject {
  [key: string]: JsonValue;
  targetDeviceId: string;
  targetProfile: string;
  enabled: boolean;
}

interface PIMessage extends JsonObject {
  [key: string]: JsonValue;
  event: string;
}

@action({ UUID: "com.johnmschoonover.decksync.anchor" })
export class PageAnchorAction extends SingletonAction<AnchorSettings> {
  private inFlightSwitches = new Set<string>();

  /**
   * Fires when the page containing this anchor becomes the active page.
   * Uses that signal to switch the paired device to the configured profile.
   */
  override async onWillAppear(
    ev: WillAppearEvent<AnchorSettings>
  ): Promise<void> {
    const { targetDeviceId, targetProfile, enabled } = ev.payload.settings;
    const sourceDeviceId = ev.action.device.id;

    if (!enabled || !targetProfile) return;

    // Check if we have an in-flight switch for the appearing device and the targetProfile.
    // If so, treat this as a plugin-initiated appear (RECEIVE) and do nothing.
    const appearKey = `${sourceDeviceId}:${targetProfile}`;
    if (this.inFlightSwitches.has(appearKey)) {
      this.inFlightSwitches.delete(appearKey);
      return;
    }

    if (targetDeviceId) {
      // Sync a specific device.
      await streamDeck.profiles.switchToProfile(targetDeviceId, targetProfile);
      this.inFlightSwitches.add(`${targetDeviceId}:${targetProfile}`);
    } else {
      // Sync every connected device that is NOT the one this anchor lives on.
      for (const device of streamDeck.devices) {
        if (device.id !== sourceDeviceId && device.isConnected) {
          await streamDeck.profiles.switchToProfile(device.id, targetProfile);
          this.inFlightSwitches.add(`${device.id}:${targetProfile}`);
        }
      }
    }
  }

  /**
   * Handles messages from the Property Inspector.
   * "getDevices" → returns connected device list so the PI can populate its dropdown.
   */
  override async onSendToPlugin(
    ev: SendToPluginEvent<PIMessage, AnchorSettings>
  ): Promise<void> {
    if (ev.payload.event === "getDevices") {
      const devices = [...streamDeck.devices].map((d) => ({
        id: d.id,
        name: d.name,
        isConnected: d.isConnected,
      }));

      // streamDeck.ui.sendToPropertyInspector sends to whichever PI is currently open.
      await streamDeck.ui.sendToPropertyInspector({ event: "devicesUpdate", devices });
    }
  }
}
