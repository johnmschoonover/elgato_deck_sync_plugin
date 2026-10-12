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
import { validateGlobalSettings, type GlobalSettings, type SettingsIssue, type ValidatedSettings } from "./settings";

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

/** Reads and validates global settings. Problems are logged at warn, never thrown. */
export async function loadGlobalSettings(log: Log): Promise<ValidatedSettings> {
  let raw: unknown;
  try {
    raw = await streamDeck.settings.getGlobalSettings();
  } catch (err) {
    log.warn(`Settings: could not read global settings (${describeError(err)}); using defaults.`);
  }
  const result = validateGlobalSettings(raw);
  logIssues(log, result.issues);
  return result;
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
  const pushDevices = () => void send({ event: "devices", devices: listDevices() });
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
        const { settings, issues } = await loadGlobalSettings(log);
        await send({ event: "globalSettings", settings, issues });
        break;
      }
      case "setGlobalSettings": {
        const { settings, issues } = validateGlobalSettings(p.settings);
        if (issues.length) {
          log.warn(`Settings: rejected a save from the Property Inspector with ${issues.length} problem(s).`);
          logIssues(log, issues);
          await send({ event: "globalSettingsRejected", issues });
          return;
        }
        try {
          await streamDeck.settings.setGlobalSettings(settings);
        } catch (err) {
          const message = `Could not save settings (${describeError(err)}).`;
          log.warn(`Settings: ${message}`);
          await send({ event: "globalSettingsRejected", issues: [{ message }] });
          return;
        }
        log.info(`Settings saved: ${settings.scopes.length} scope(s).`);
        onSettingsSaved(settings);
        await send({ event: "globalSettings", settings, issues: [] });
        break;
      }
      default:
        log.debug(`PI: ignoring unknown message '${p.event}'.`);
    }
  });
}
