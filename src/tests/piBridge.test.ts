/** Plugin side of the PI protocol: device list, settings load/save, pushes. */
const mockState = {
  stored: {} as unknown,
  sent: [] as unknown[],
  listeners: {} as { sendToPlugin?: (ev: unknown) => Promise<void>; connect?: () => void; disconnect?: () => void },
  devices: [
    { id: "P", name: "Deck P", type: 0, isConnected: true },
    { id: "C1", name: "Deck C1", type: 7, isConnected: false },
  ],
  getFails: false,
  setFails: false,
  piActionId: "a1",
};

jest.mock("@elgato/streamdeck", () => ({
  __esModule: true,
  default: {
    devices: Object.assign(mockState.devices, {
      onDeviceDidConnect: (l: () => void) => { mockState.listeners.connect = l; },
      onDeviceDidDisconnect: (l: () => void) => { mockState.listeners.disconnect = l; },
    }),
    settings: {
      getGlobalSettings: jest.fn(async () => { if (mockState.getFails) throw new Error("boom"); return mockState.stored; }),
      setGlobalSettings: jest.fn(async (s: unknown) => { if (mockState.setFails) throw new Error("disk full"); mockState.stored = s; }),
    },
    ui: {
      get action() { return (mockState as unknown as { piClosed?: boolean }).piClosed ? undefined : { id: mockState.piActionId }; },
      onSendToPlugin: (l: (ev: unknown) => Promise<void>) => { mockState.listeners.sendToPlugin = l; },
      sendToPropertyInspector: jest.fn(async (p: unknown) => {
        if ((mockState as unknown as { failSend?: boolean }).failSend) throw new Error("no property inspector");
        mockState.sent.push(p);
      }),
    },
  },
}));

import { createGlobalSettingsHandler, listDevices, loadGlobalSettings, registerPropertyInspectorBridge } from "../piBridge";
import { GLOBAL_SETTINGS_VERSION, createDefaultGlobalSettings } from "../settings";

const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const onSettingsSaved = jest.fn();
const message = (payload: unknown, from = "a1") => mockState.listeners.sendToPlugin!({ payload, action: { id: from } });

const validSettings = {
  version: GLOBAL_SETTINGS_VERSION,
  scopes: [{ id: "desk", name: "Desk", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }],
};

/** What the PI must receive for the mocked devices (spelled out, not computed by the code under test). */
const DEVICE_LIST = [
  { id: "P", name: "Deck P", type: 0, isConnected: true, defaultProfile: "profiles/original" },
  { id: "C1", name: "Deck C1", type: 7, isConnected: false },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockState.stored = {};
  mockState.sent.length = 0;
  mockState.getFails = false;
  mockState.setFails = false;
  registerPropertyInspectorBridge({ log, onSettingsSaved });
});

describe("listDevices", () => {
  test("summarizes devices with the default profile for known device types", () => {
    expect(listDevices()).toEqual(DEVICE_LIST);
  });
});

describe("loadGlobalSettings", () => {
  test("fresh install yields defaults without warnings", async () => {
    await expect(loadGlobalSettings(log)).resolves.toEqual({ settings: createDefaultGlobalSettings(), issues: [], fatal: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("legacy settings yield defaults and a warning, not a throw", async () => {
    mockState.stored = { version: "1.0.0", scopes: [{ id: "all", deviceIds: [] }] };
    const { settings, issues } = await loadGlobalSettings(log);
    expect(settings).toEqual(createDefaultGlobalSettings());
    expect(issues).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Unsupported global settings version"));
  });

  test("a failing read yields defaults and a warning", async () => {
    mockState.getFails = true;
    const { settings } = await loadGlobalSettings(log);
    expect(settings).toEqual(createDefaultGlobalSettings());
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not read global settings (boom)"));
  });
});

describe("createGlobalSettingsHandler", () => {
  const engine = { onSettingsChanged: jest.fn() };

  test("before start the event is ignored (the start-up load applies the settings)", () => {
    const handle = createGlobalSettingsHandler(log, engine, () => false);
    handle(validSettings);
    expect(engine.onSettingsChanged).not.toHaveBeenCalled();
  });

  test("after start valid settings reach the engine, with issues logged", () => {
    const handle = createGlobalSettingsHandler(log, engine, () => true);
    handle({ version: 2, scopes: [{ id: "bad", members: [] }, ...validSettings.scopes] });
    expect(engine.onSettingsChanged).toHaveBeenCalledWith(validSettings);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Scope 'bad' ignored"));
  });

  test("after start an unusable payload is ignored and the configuration kept", () => {
    const handle = createGlobalSettingsHandler(log, engine, () => true);
    handle({ version: 1 });
    expect(engine.onSettingsChanged).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("ignoring an unusable global-settings payload"));
  });
});

describe("Property Inspector messages", () => {
  test("getDevices replies with the device list", async () => {
    await message({ event: "getDevices" });
    expect(mockState.sent).toEqual([{ event: "devices", devices: DEVICE_LIST }]);
  });

  test("getGlobalSettings replies with validated settings and issues", async () => {
    mockState.stored = { version: 2, scopes: [{ id: "bad", members: [] }, ...validSettings.scopes] };
    await message({ event: "getGlobalSettings" });
    expect(mockState.sent).toEqual([{ event: "globalSettings", settings: validSettings, issues: [{ scopeId: "bad", message: expect.stringContaining("exactly one parent") }] }]);
  });

  test("setGlobalSettings with valid settings saves, notifies, and confirms", async () => {
    await message({ event: "setGlobalSettings", settings: { ...validSettings, junk: 1 } });
    expect(mockState.stored).toEqual(validSettings);
    expect(onSettingsSaved).toHaveBeenCalledWith(validSettings);
    expect(mockState.sent).toEqual([{ event: "globalSettings", settings: validSettings, issues: [] }]);
    expect(log.info).toHaveBeenCalledWith("Settings saved: 1 scope(s).");
  });

  test("setGlobalSettings with an invalid scope is rejected and nothing is saved", async () => {
    await message({ event: "setGlobalSettings", settings: { version: 2, scopes: [{ id: "x", members: [{ deviceId: "P", role: "parent" }] }] } });
    expect(mockState.stored).toEqual({});
    expect(onSettingsSaved).not.toHaveBeenCalled();
    expect(mockState.sent).toEqual([{ event: "globalSettingsRejected", issues: [{ scopeId: "x", message: "Scope 'x' ignored: a scope needs at least one child." }] }]);
    expect(log.warn).toHaveBeenCalled();
  });

  test("a failing write is reported to the PI, not thrown", async () => {
    mockState.setFails = true;
    await message({ event: "setGlobalSettings", settings: validSettings });
    expect(onSettingsSaved).not.toHaveBeenCalled();
    expect(mockState.sent).toEqual([{ event: "globalSettingsRejected", issues: [{ message: "Could not save settings (disk full)." }] }]);
  });

  test("unknown and malformed messages are ignored", async () => {
    await message({ event: "dance" });
    await message("nope");
    await message(null);
    await message([1]);
    expect(mockState.sent).toEqual([]);
  });

  test("device connect/disconnect pushes a fresh device list", async () => {
    mockState.listeners.connect!();
    mockState.listeners.disconnect!();
    await Promise.resolve();
    expect(mockState.sent).toEqual([{ event: "devices", devices: DEVICE_LIST }, { event: "devices", devices: DEVICE_LIST }]);
  });

  test("device pushes are skipped while no Property Inspector is open", async () => {
    (mockState as unknown as { piClosed: boolean }).piClosed = true;
    mockState.listeners.connect!();
    await Promise.resolve();
    expect(mockState.sent).toEqual([]);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("no Property Inspector open"));
    (mockState as unknown as { piClosed: boolean }).piClosed = false;
  });

  test("a reply that cannot be delivered is logged at warn, not thrown", async () => {
    (mockState as unknown as { failSend: boolean }).failSend = true;
    await expect(message({ event: "getDevices" })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not send 'devices'"));
    (mockState as unknown as { failSend: boolean }).failSend = false;
  });
});

describe("R5-F19 the PI's own settings read", () => {
  test("is quiet: the issues go to the panel and the global-settings event logs them", async () => {
    mockState.stored = { version: 2, scopes: [{ id: "bad", members: [] }] };
    await message({ event: "getGlobalSettings" });
    expect(mockState.sent).toEqual([{ event: "globalSettings", settings: createDefaultGlobalSettings(), issues: [expect.objectContaining({ scopeId: "bad" })] }]);
    expect(log.warn).not.toHaveBeenCalled();
    expect((await loadGlobalSettings(log, true)).issues).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
    await loadGlobalSettings(log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Scope 'bad' ignored"));
  });
});

describe("R8-F6 save ids", () => {
  test("a save's id is echoed in its confirmation and in its rejection; a save without one gets none", async () => {
    await message({ event: "setGlobalSettings", settings: validSettings, id: 7 });
    expect(mockState.sent[0]).toEqual({ event: "globalSettings", settings: validSettings, issues: [], id: 7 });
    await message({ event: "setGlobalSettings", settings: { version: 2, scopes: [{ id: "bad", members: [] }] }, id: 8 });
    expect(mockState.sent[1]).toMatchObject({ event: "globalSettingsRejected", id: 8 });
    mockState.setFails = true;
    await message({ event: "setGlobalSettings", settings: validSettings, id: 9 });
    expect(mockState.sent[2]).toMatchObject({ event: "globalSettingsRejected", issues: [{ message: expect.stringContaining("disk full") }], id: 9 });
    mockState.setFails = false;
    await message({ event: "setGlobalSettings", settings: validSettings });
    expect(mockState.sent[3]).toEqual({ event: "globalSettings", settings: validSettings, issues: [] });
  });
});

describe("R9-F7/R9-F8 after a save", () => {
  test("a save without usable settings is rejected and nothing is written", async () => {
    for (const settings of [undefined, null, {}, { version: 1, scopes: [] }, "x"]) {
      mockState.sent.length = 0;
      await message({ event: "setGlobalSettings", settings, id: 3 });
      expect(mockState.sent).toEqual([{ event: "globalSettingsRejected", issues: [{ message: expect.stringContaining("carried no settings") }], id: 3 }]);
    }
    expect(mockState.stored).toEqual({});
    expect(onSettingsSaved).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no usable settings"));
  });

  test("the global-settings event is ignored once the panel has saved, so a read answered late cannot revert the engine", () => {
    const engine = { onSettingsChanged: jest.fn() };
    let saved = false;
    const handle = createGlobalSettingsHandler(log, engine, () => true, () => saved);
    handle(validSettings);
    expect(engine.onSettingsChanged).toHaveBeenCalledTimes(1);
    saved = true;
    handle({ version: 2, scopes: [] });
    expect(engine.onSettingsChanged).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("already applied"));
  });
});

describe("reply routing (R11-F9)", () => {
  beforeEach(() => { mockState.sent = []; mockState.piActionId = "a1"; log.debug.mockClear(); });
  test("a request from a panel that is no longer the open one is answered to the open panel, and said so at debug", async () => {
    registerPropertyInspectorBridge({ log, onSettingsSaved });
    mockState.piActionId = "a2";
    await message({ event: "getDevices" }, "a1");
    expect(mockState.sent).toHaveLength(1);
    expect(log.debug).toHaveBeenCalledWith("PI: 'getDevices' came from action a1; the reply goes to the panel now open (action a2)");
    log.debug.mockClear();
    await message({ event: "getDevices" }, "a2");
    expect(log.debug).not.toHaveBeenCalledWith(expect.stringMatching(/^PI: 'getDevices' came from/));
  });
});
