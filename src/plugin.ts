import streamDeck from "@elgato/streamdeck";
import { PageAnchorAction } from "./actions/page-anchor";
import { describeError } from "./log";
import { loadGlobalSettings, logIssues, registerPropertyInspectorBridge } from "./piBridge";
import { validateGlobalSettings } from "./settings";
import { SyncEngine, type DeviceInfo } from "./syncEngine";

const log = streamDeck.logger.createScope("DeckSync");

const toInfo = (d: { id: string; name: string; type: number; isConnected: boolean }): DeviceInfo => ({
  id: d.id,
  name: d.name,
  type: d.type,
  isConnected: d.isConnected,
});

// The engine sees the SDK only through these adapters (src/syncEngine.ts).
const engine = new SyncEngine({
  switcher: { switchToProfile: (deviceId, profile, page) => streamDeck.profiles.switchToProfile(deviceId, profile, page) },
  clock: { now: () => Date.now() },
  log: streamDeck.logger.createScope("sync"),
  devices: {
    list: () => [...streamDeck.devices].map(toInfo),
    get: (id) => {
      const d = streamDeck.devices.getDeviceById(id);
      return d && toInfo(d);
    },
  },
});

// Register all actions before connecting.
streamDeck.actions.registerAction(new PageAnchorAction(engine));

streamDeck.devices.onDeviceDidConnect((ev) => engine.onDeviceConnected(ev.device.id));
streamDeck.devices.onDeviceDidDisconnect((ev) => engine.onDeviceDisconnected(ev.device.id));

// Settings reach the engine validated: from the PI's save, or from the global-settings event.
let started = false;
streamDeck.settings.onDidReceiveGlobalSettings((ev) => {
  const { settings, issues, fatal } = validateGlobalSettings(ev.settings);
  logIssues(log, issues);
  if (fatal && started) {
    log.warn("Settings: ignoring an unusable global-settings payload; keeping the current configuration.");
    return;
  }
  engine.onSettingsChanged(settings);
});
registerPropertyInspectorBridge({ log, onSettingsSaved: (settings) => engine.onSettingsChanged(settings) });

streamDeck
  .connect()
  .then(async () => {
    // Devices are known only after connecting; start never issues a switch.
    const { settings } = await loadGlobalSettings(log);
    engine.start(settings);
    started = true;
  })
  .catch((err: unknown) => log.error(`Startup failed: ${describeError(err)}`));
