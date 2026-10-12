import streamDeck from "@elgato/streamdeck";
import { PageAnchorAction } from "./actions/page-anchor";
import { describeError } from "./log";
import { createGlobalSettingsHandler, loadGlobalSettings, registerPropertyInspectorBridge } from "./piBridge";
import { createDefaultGlobalSettings, type GlobalSettings } from "./settings";
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
// Until start() has finished (settings applied, pre-start navigation replayed) the event is
// ignored and a save from the PI is held, so neither can interleave with the start-up load.
let started = false;
let savedBeforeStart: GlobalSettings | undefined;
const handleGlobalSettings = createGlobalSettingsHandler(log, engine, () => started);
streamDeck.settings.onDidReceiveGlobalSettings((ev) => handleGlobalSettings(ev.settings));
registerPropertyInspectorBridge({
  log,
  onSettingsSaved: (settings) => {
    if (started) engine.onSettingsChanged(settings);
    else savedBeforeStart = settings;
  },
});

/** The SDK's global-settings read has no timeout of its own; never let a lost reply keep the engine from starting. */
const SETTINGS_LOAD_TIMEOUT_MS = 15_000;

streamDeck
  .connect()
  .then(async () => {
    // Devices are known only after connecting; start never issues a switch.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), SETTINGS_LOAD_TIMEOUT_MS); });
    const loaded = await Promise.race([loadGlobalSettings(log).then((r) => r.settings), timeout]);
    clearTimeout(timer);
    if (!loaded) log.warn(`Settings: no reply from Stream Deck within ${SETTINGS_LOAD_TIMEOUT_MS}ms; starting with defaults — they are applied when the reply arrives, or reopen a Page Anchor's Property Inspector to reload them.`);
    await engine.start(savedBeforeStart ?? loaded ?? createDefaultGlobalSettings());
    started = true;
    if (savedBeforeStart) engine.onSettingsChanged(savedBeforeStart); // a no-op unless it arrived during start()
  })
  .catch((err: unknown) => log.error(`Startup failed: ${describeError(err)}`));
