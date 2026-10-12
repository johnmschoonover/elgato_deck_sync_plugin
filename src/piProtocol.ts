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

/** Sent by the PI via `sendToPlugin`. `settings` is unvalidated JSON. */
export type PiToPlugin =
  | { event: "getDevices" }
  | { event: "getGlobalSettings" }
  | { event: "setGlobalSettings"; settings: unknown };

/** Sent by the plugin via `sendToPropertyInspector`. */
export type PluginToPi =
  | { event: "devices"; devices: DeviceSummary[] }
  | { event: "globalSettings"; settings: GlobalSettings; issues: SettingsIssue[] }
  | { event: "globalSettingsRejected"; issues: SettingsIssue[] };
