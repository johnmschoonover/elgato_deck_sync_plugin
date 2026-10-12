/**
 * Messages exchanged between the Page Anchor Property Inspector
 * (`ui/anchor.html`, plain JS) and the plugin. Keep both sides in step.
 */
import type { GlobalSettings, SettingsIssue } from "./settings";

export type DeviceSummary = {
  id: string;
  name: string;
  /** `DeviceType` value. */
  type: number;
  isConnected: boolean;
  /** Bundled profile used when a member has no explicit profile (src/profiles.ts). */
  defaultProfile?: string;
};

/** Sent by the PI via `sendToPlugin`. `settings` is unvalidated JSON; `id` is echoed in the reply so the PI can tell saves apart. */
export type PiToPlugin =
  | { event: "getDevices" }
  | { event: "getGlobalSettings" }
  | { event: "setGlobalSettings"; settings: unknown; id?: number };

/** Sent by the plugin via `sendToPropertyInspector`. A `globalSettings` reply carries `id` only when it answers a save. */
export type PluginToPi =
  | { event: "devices"; devices: DeviceSummary[] }
  | { event: "globalSettings"; settings: GlobalSettings; issues: SettingsIssue[]; id?: number }
  | { event: "globalSettingsRejected"; issues: SettingsIssue[]; id?: number };
