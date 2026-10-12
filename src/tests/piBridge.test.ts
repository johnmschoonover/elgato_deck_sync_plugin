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
      onSendToPlugin: (l: (ev: unknown) => Promise<void>) => { mockState.listeners.sendToPlugin = l; },
      sendToPropertyInspector: jest.fn(async (p: unknown) => {
        if ((mockState as unknown as { failSend?: boolean }).failSend) throw new Error("no property inspector");
        mockState.sent.push(p);
      }),
    },
  },
}));

import { listDevices, loadGlobalSettings, registerPropertyInspectorBridge } from "../piBridge";
import { GLOBAL_SETTINGS_VERSION, createDefaultGlobalSettings } from "../settings";

const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const onSettingsSaved = jest.fn();
const message = (payload: unknown) => mockState.listeners.sendToPlugin!({ payload });

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

  test("a reply that cannot be delivered is logged at warn, not thrown", async () => {
    (mockState as unknown as { failSend: boolean }).failSend = true;
    await expect(message({ event: "getDevices" })).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not send 'devices'"));
    (mockState as unknown as { failSend: boolean }).failSend = false;
  });
});
