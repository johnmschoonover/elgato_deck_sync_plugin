import streamDeck, {
  action,
  SingletonAction,
  WillAppearEvent,
  SendToPluginEvent,
} from "@elgato/streamdeck";
import type { JsonObject, JsonValue } from "@elgato/utils";
import { createScopeManager, ScopeManager, ScopeMember } from "../scopeManager";
import { createDefaultGlobalSettings } from "../globalSettings";

/**
 * Settings stored per Page Anchor action instance.
 *
 * targetDeviceId  - Legacy: a specific device to sync.
 *                   Deprecated in C-Series — use scopes instead.
 * targetProfile   - Name of the plugin-bundled profile to switch to.
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
  readonly scopeManager: ScopeManager;

  constructor() {
    super();
    // Build a minimal scope manager now; it will be updated when global
    // settings arrive via the plugin's global-settings handler.
    const defaults = createDefaultGlobalSettings();
    this.scopeManager = createScopeManager(defaults, 2000);
  }

  /**
   * Fires when the page containing this anchor becomes the active page.
   *
   * C-Series scope-based flow:
   *   1. If a legacy targetDeviceId is set, fall back to the old single-device
   *      behavior (backwards-compatible).
   *   2. Otherwise use scope-based fan-out:
   *      - Resolve which scope(s) contain the source device.
   *      - Switch the configured profile on all scope members.
   *   3. Track in-flight switches to prevent loops.
   *   4. Suppress events during the settle period.
   */
  override async onWillAppear(
    ev: WillAppearEvent<AnchorSettings>
  ): Promise<void> {
    const { targetDeviceId, targetProfile, enabled } = ev.payload.settings;
    const sourceDeviceId = ev.action.device.id;

    if (!enabled || !targetProfile) return;

    // --- Legacy single-device path (backwards-compat) ---
    if (targetDeviceId) {
      await this.legacySwitch(sourceDeviceId, targetDeviceId, targetProfile);
      return;
    }

    // --- C-Series scope-based fan-out ---
    await this.scopeBasedFanOut(sourceDeviceId, targetProfile);
  }

  /* ---- helpers ---- */

  /**
   * Legacy: switch a single target device (pre-C-Series).
   */
  private async legacySwitch(
    sourceDeviceId: string,
    targetDeviceId: string,
    targetProfile: string
  ): Promise<void> {
    const tracker = this.scopeManager.getTracker();

    // In-flight check
    if (tracker.has(targetDeviceId, targetProfile)) {
      tracker.remove(targetDeviceId, targetProfile);
      return;
    }

    await streamDeck.profiles.switchToProfile(targetDeviceId, targetProfile);
    tracker.add(targetDeviceId, targetProfile);
    this.scopeManager.startSettle(targetDeviceId, targetProfile);
  }

  /**
   * C-Series: scope-based fan-out to all devices in the source's scope.
   */
  private async scopeBasedFanOut(
    sourceDeviceId: string,
    targetProfile: string
  ): Promise<void> {
    const tracker = this.scopeManager.getTracker();
    const logger = this.scopeManager.getLogger();

    const connectedDevices = [...streamDeck.devices].map((d) => ({
      id: d.id,
      name: d.name,
      isConnected: d.isConnected,
    }));

    // 1. Check settling first — don't fan-out if source is still settling
    if (this.scopeManager.isSettling(sourceDeviceId, targetProfile)) {
      logger.debug(
        `Source ${sourceDeviceId} still settling for ${targetProfile}, skipping fan-out`
      );
      return;
    }

    // 2. Check if device has any scope at all
    if (!this.scopeManager.hasScope(sourceDeviceId)) {
      logger.debug(
        `No scope found for ${sourceDeviceId}, skipping fan-out`
      );
      return;
    }

    // 3. Get scope device IDs
    const scopeDeviceIds = this.scopeManager.getScopeDeviceIds(sourceDeviceId);

    // 4. If no explicit scope (empty array), use all connected devices
    let targetIds: string[];
    if (scopeDeviceIds.length === 0) {
      // "All devices" scope — use all connected devices except source
      targetIds = connectedDevices
        .filter((d) => d.id !== sourceDeviceId)
        .map((d) => d.id);
      logger.info(
        `Fan-out: ${sourceDeviceId} in all-devices scope, ${targetIds.length} targets`
      );
    } else {
      // Resolve members with live connectivity
      const members = this.scopeManager.resolveMembers(
        scopeDeviceIds,
        connectedDevices
      );
      // Filter out disconnected devices and self
      const activeMembers = members.filter(
        (m: ScopeMember) => m.connected && m.deviceId !== sourceDeviceId
      );
      targetIds = activeMembers.map((m: ScopeMember) => m.deviceId);
      logger.info(
        `Fan-out: ${sourceDeviceId} in explicit scope, ${targetIds.length} targets`
      );
    }

    if (targetIds.length === 0) {
      return;
    }

    // 5. Mark source as settling
    this.scopeManager.startSettle(sourceDeviceId, targetProfile);

    // 6. Fan-out to all targets
    for (const deviceId of targetIds) {
      // In-flight check
      if (tracker.has(deviceId, targetProfile)) {
        logger.debug(`Device ${deviceId} already in-flight, skipping`);
        continue;
      }

      // Settling check
      if (this.scopeManager.isSettling(deviceId, targetProfile)) {
        logger.debug(`Device ${deviceId} still settling, skipping`);
        continue;
      }

      try {
        await streamDeck.profiles.switchToProfile(deviceId, targetProfile);
        tracker.add(deviceId, targetProfile);
        this.scopeManager.startSettle(deviceId, targetProfile);
        logger.info(
          `Fan-out: ${sourceDeviceId} → ${deviceId} → ${targetProfile}`
        );
      } catch (err) {
        logger.error(
          `Fan-out failed for ${deviceId}: ${String((err as Error).message || err)}`
        );
      }
    }
  }

  /**
   * Handles messages from the Property Inspector.
   * "getDevices" → returns connected device list.
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

      await streamDeck.ui.sendToPropertyInspector({
        event: "devicesUpdate",
        devices,
      });
    }
  }
}

// ---- global handler for settings updates ----

streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  // Forward global settings to the PI
  streamDeck.ui.sendToPropertyInspector({
    event: "globalSettingsUpdate",
    settings: JSON.parse(JSON.stringify(ev.settings)),
  } as any);
});