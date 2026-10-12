import streamDeck from "@elgato/streamdeck";
import { PageAnchorAction } from "./actions/page-anchor";
import { describeError } from "./log";
import { createGlobalSettingsHandler, loadGlobalSettings, registerPropertyInspectorBridge } from "./piBridge";
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
const handleGlobalSettings = createGlobalSettingsHandler(log, engine, () => started);
streamDeck.settings.onDidReceiveGlobalSettings((ev) => handleGlobalSettings(ev.settings));
registerPropertyInspectorBridge({ log, onSettingsSaved: (settings) => engine.onSettingsChanged(settings) });

streamDeck
  .connect()
  .then(async () => {
    // Devices are known only after connecting; start never issues a switch.
    const { settings } = await loadGlobalSettings(log);
    started = true;
    await engine.start(settings);
  })
  .catch((err: unknown) => log.error(`Startup failed: ${describeError(err)}`));
