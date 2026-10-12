/**
 * Plugin side of the Property Inspector protocol (src/piProtocol.ts):
 * the device list, global settings load/save with validation, and pushes
 * to an open PI when devices connect or disconnect.
 */
import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { describeError, type Log } from "./log";
import type { DeviceSummary, PluginToPi } from "./piProtocol";
import { resolveProfile } from "./profiles";
import { GLOBAL_SETTINGS_VERSION, validateGlobalSettings, type GlobalSettings, type SettingsIssue, type ValidatedSettings } from "./settings";

export function listDevices(): DeviceSummary[] {
  return [...streamDeck.devices].map((d) => {
    const summary: DeviceSummary = { id: d.id, name: d.name, type: d.type, isConnected: d.isConnected };
    const profile = resolveProfile(undefined, d.type);
    if (profile) summary.defaultProfile = profile;
    return summary;
  });
}

export function logIssues(log: Log, issues: SettingsIssue[]): void {
  for (const issue of issues) log.warn(`Settings: ${issue.message}`);
}

/**
 * Reads and validates global settings. Problems are logged at warn, never thrown — unless
 * `quiet`: the SDK answers every read with a global-settings event as well, so a read made
 * on the PI's behalf leaves the logging to that event's handler.
 */
export async function loadGlobalSettings(log: Log, quiet = false): Promise<ValidatedSettings> {
  let raw: unknown;
  try {
    raw = await streamDeck.settings.getGlobalSettings();
  } catch (err) {
    log.warn(`Settings: could not read global settings (${describeError(err)}); using defaults.`);
  }
  const result = validateGlobalSettings(raw);
  if (!quiet) logIssues(log, result.issues);
  return result;
}

export type SettingsConsumer = { onSettingsChanged(settings: GlobalSettings): void };

/**
 * Handles the SDK's global-settings event. Before the engine has started, the start-up
 * load applies the settings (the event also fires for the plugin's own read); afterwards
 * an unusable payload is ignored rather than replacing a working configuration, and once
 * the panel has saved anything the event is ignored altogether: the plugin is the only
 * writer, every save is applied directly, and a read answered late would revert it.
 */
export function createGlobalSettingsHandler(log: Log, engine: SettingsConsumer, isStarted: () => boolean, hasSaved: () => boolean = () => false): (raw: unknown) => void {
  return (raw) => {
    if (!isStarted()) {
      log.debug("Settings: global-settings event before start; the start-up load applies them");
      return;
    }
    if (hasSaved()) {
      log.debug("Settings: global-settings event ignored; the configuration saved from the panel is already applied");
      return;
    }
    const { settings, issues, fatal } = validateGlobalSettings(raw);
    logIssues(log, issues);
    if (fatal) {
      log.warn("Settings: ignoring an unusable global-settings payload; keeping the current configuration.");
      return;
    }
    engine.onSettingsChanged(settings);
  };
}

export type PiBridgeOptions = {
  log: Log;
  /** Called with validated settings after a successful save from the PI. */
  onSettingsSaved: (settings: GlobalSettings) => void;
};

export function registerPropertyInspectorBridge({ log, onSettingsSaved }: PiBridgeOptions): void {
  const send = async (msg: PluginToPi): Promise<void> => {
    try {
      await streamDeck.ui.sendToPropertyInspector(msg as JsonValue);
    } catch (err) {
      log.warn(`PI: could not send '${msg.event}' (${describeError(err)}) — reopen the Page Anchor's Property Inspector`);
    }
  };
  const pushDevices = () => {
    // The SDK drops the message silently when no Property Inspector is open.
    if (!streamDeck.ui.action) {
      log.debug("PI: no Property Inspector open; device list not pushed");
      return;
    }
    void send({ event: "devices", devices: listDevices() });
  };
  streamDeck.devices.onDeviceDidConnect(pushDevices);
  streamDeck.devices.onDeviceDidDisconnect(pushDevices);

  streamDeck.ui.onSendToPlugin(async (ev) => {
    const p = ev.payload;
    if (typeof p !== "object" || p === null || Array.isArray(p) || typeof p.event !== "string") return;
    switch (p.event) {
      case "getDevices":
        await send({ event: "devices", devices: listDevices() });
        break;
      case "getGlobalSettings": {
        const { settings, issues } = await loadGlobalSettings(log, true); // the PI shows the issues; the event handler logs them
        await send({ event: "globalSettings", settings, issues });
        break;
      }
      case "setGlobalSettings": {
        const tag = typeof p.id === "number" ? { id: p.id } : {}; // echoed so the PI matches the reply to its save
        const body = p.settings as { version?: unknown } | null | undefined;
        if (typeof body !== "object" || body === null || body.version !== GLOBAL_SETTINGS_VERSION) {
          // A fresh-install payload is fine to load, but a save without settings would wipe every scope.
          log.warn("Settings: rejected a save from the Property Inspector that carried no usable settings.");
          await send({ event: "globalSettingsRejected", issues: [{ message: `The save carried no settings (expected an object with version ${GLOBAL_SETTINGS_VERSION}); nothing was changed.` }], ...tag });
          return;
        }
        const { settings, issues } = validateGlobalSettings(p.settings);
        if (issues.length) {
          log.warn(`Settings: rejected a save from the Property Inspector with ${issues.length} problem(s).`);
          logIssues(log, issues);
          await send({ event: "globalSettingsRejected", issues, ...tag });
          return;
        }
        try {
          await streamDeck.settings.setGlobalSettings(settings);
        } catch (err) {
          const message = `Could not save settings (${describeError(err)}).`;
          log.warn(`Settings: ${message}`);
          await send({ event: "globalSettingsRejected", issues: [{ message }], ...tag });
          return;
        }
        log.info(`Settings saved: ${settings.scopes.length} scope(s).`);
        onSettingsSaved(settings);
        await send({ event: "globalSettings", settings, issues: [], ...tag });
        break;
      }
      default:
        log.debug(`PI: ignoring unknown message '${p.event}'.`);
    }
  });
}
