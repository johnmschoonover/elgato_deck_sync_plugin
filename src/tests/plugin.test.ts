/**
 * The plugin entry (src/plugin.ts): the engine is built over the SDK, the action is
 * registered before connecting, start() runs after connect and never issues a switch,
 * and settings that arrive around start-up are routed so nothing is lost or applied early.
 */
type Listener = (ev: never) => unknown;
const mock = {
  logs: [] as Array<{ scope: string; level: string; msg: string }>,
  // Like the SDK, a device is listed as not connected until its deviceDidConnect event.
  devices: [
    { id: "P", name: "Deck P", type: 0, isConnected: false },
    { id: "C1", name: "Deck C1", type: 1, isConnected: false },
  ],
  listeners: {} as Record<string, Listener[]>,
  registered: [] as unknown[],
  stored: {} as unknown,
  switchCalls: [] as unknown[][],
  connect: null as null | (() => Promise<void>),
  load: null as null | (() => Promise<unknown>),
};

jest.mock("@elgato/streamdeck", () => {
  const scopeLog = (scope: string) =>
    Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (msg: string) => mock.logs.push({ scope, level, msg })]));
  return {
    __esModule: true,
    action: () => (target: unknown) => target,
    SingletonAction: class {},
    default: {
      logger: { createScope: scopeLog },
      profiles: { switchToProfile: async (...args: unknown[]) => { mock.switchCalls.push(args); } },
      devices: Object.assign(mock.devices, {
        getDeviceById: (id: string) => mock.devices.find((d) => d.id === id),
        onDeviceDidConnect: (l: Listener) => { (mock.listeners.connect ??= []).push(l); },
        onDeviceDidDisconnect: (l: Listener) => { (mock.listeners.disconnect ??= []).push(l); },
      }),
      actions: { registerAction: (a: unknown) => { mock.registered.push(a); } },
      settings: {
        onDidReceiveGlobalSettings: (l: Listener) => { (mock.listeners.globalSettings ??= []).push(l); },
        getGlobalSettings: () => (mock.load ? mock.load() : Promise.resolve(mock.stored)),
        setGlobalSettings: async (s: unknown) => { mock.stored = s; },
      },
      ui: {
        action: {},
        onSendToPlugin: (l: Listener) => { (mock.listeners.sendToPlugin ??= []).push(l); },
        sendToPropertyInspector: async () => {},
      },
      connect: () => mock.connect!(),
    },
  };
});

import { PageAnchorAction } from "../actions/page-anchor";
import { GLOBAL_SETTINGS_VERSION } from "../settings";

const scopeSettings = (name: string) => ({
  version: GLOBAL_SETTINGS_VERSION,
  scopes: [{ id: "desk", name, parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }],
});
const lines = (scope: string, re: RegExp) => mock.logs.filter((l) => l.scope === scope && re.test(l.msg)).map((l) => l.msg);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Fires every listener registered for the event (the engine's and the PI bridge's both listen to device events). */
const fire = (name: string, ev: unknown) => Promise.all((mock.listeners[name] ?? []).map((l) => (l as (ev: unknown) => unknown)(ev)));
/** The app announces a device: the SDK flips isConnected before the listeners run. */
const connectDevice = (id: string) => {
  mock.devices.find((d) => d.id === id)!.isConnected = true;
  return fire("connect", { device: { id } });
};
const appear = (deviceId: string, pageIndex: number) =>
  (mock.registered[0] as PageAnchorAction).onWillAppear({ action: { id: `${deviceId}-p${pageIndex}`, device: { id: deviceId } }, payload: { settings: { pageIndex }, isInMultiAction: false } } as never);

beforeEach(() => {
  mock.logs.length = 0;
  mock.registered.length = 0;
  mock.switchCalls.length = 0;
  mock.stored = {};
  mock.listeners = {};
  mock.load = null;
  for (const d of mock.devices) d.isConnected = false;
});
afterEach(() => jest.useRealTimers());

test("registers the action before connecting, starts after connect, and drives the SDK through the adapters", async () => {
  let resolveConnect = () => {};
  mock.connect = () => new Promise<void>((resolve) => { resolveConnect = resolve; });
  mock.stored = scopeSettings("Desk");
  jest.isolateModules(() => { require("../plugin"); });
  expect(mock.registered).toHaveLength(1);
  expect((mock.registered[0] as object).constructor.name).toBe(PageAnchorAction.name); // isolateModules gives the class a fresh identity
  expect(lines("sync", /^START/)).toHaveLength(0);

  resolveConnect();
  await settle();
  expect(lines("sync", /^START devices=\[P,C1\] scopes=1 /)).toHaveLength(1);
  expect(lines("sync", /^SETTINGS applied \(start\) scopes=\[desk\{parent=P,children=1,overrides=0\}\]/)).toHaveLength(1);
  expect(mock.switchCalls).toEqual([]);

  // Until the app announces a device it counts as disconnected (R7-F9): a flip skips it with a warning.
  await appear("P", 0);
  await appear("C1", 0);
  (mock.registered[0] as PageAnchorAction).onWillDisappear({ action: { id: "P-p0", device: { id: "P" } }, payload: { settings: { pageIndex: 0 }, isInMultiAction: false } } as never);
  await appear("P", 1);
  expect(mock.switchCalls).toEqual([]);
  expect(lines("sync", /^SKIP target=C1 seq=1 reason=disconnected/)).toHaveLength(1);
  // Device events and page events reach the engine; once announced, a human flip reaches the SDK's switchToProfile.
  await connectDevice("C1");
  expect(mock.logs.filter((l) => l.scope === "sync" && l.level === "debug" && /^DEVICE connected dev=C1 \(already armed; no change\)/.test(l.msg))).toHaveLength(1); // armed by its appear already
  await fire("disconnect", { device: { id: "C1" } });
  mock.devices[1].isConnected = false;
  expect(lines("sync", /^DEVICE disconnected dev=C1/)).toHaveLength(1);
  await connectDevice("C1");
  expect(lines("sync", /^DEVICE connected dev=C1 \(disarmed until its first appear\)/)).toHaveLength(1);
  await appear("C1", 0); // the reconnect burst
  (mock.registered[0] as PageAnchorAction).onWillDisappear({ action: { id: "P-p1", device: { id: "P" } }, payload: { settings: { pageIndex: 1 }, isInMultiAction: false } } as never);
  await appear("P", 2);
  expect(mock.switchCalls).toEqual([["C1", "profiles/mini", 2]]);
  expect(lines("sync", /^SEND dev=P role=parent scope=desk page=2/)).toHaveLength(1);
  // An edit of a visible anchor reaches the engine too (R7-F4).
  await (mock.registered[0] as PageAnchorAction).onDidReceiveSettings({ action: { id: "P-p2", device: { id: "P" } }, payload: { settings: { pageIndex: 3 }, isInMultiAction: false } } as never);
  expect(lines("sync", /^ANCHOR updated dev=P action=P-p2 page=2→3/)).toHaveLength(1);

  // After start the global-settings event is applied (a plain re-read changes nothing).
  fire("globalSettings", { settings: scopeSettings("Desk") });
  expect(lines("sync", /^SETTINGS unchanged \(update\)/)).toHaveLength(1);
  fire("globalSettings", { settings: { version: GLOBAL_SETTINGS_VERSION, scopes: [] } });
  expect(lines("sync", /^SETTINGS applied \(update\) scopes=\[\]/)).toHaveLength(1);
});

test("settings arriving before start() has finished are not applied early: the event is ignored and a PI save is held for start", async () => {
  let resolveConnect = () => {};
  mock.connect = () => new Promise<void>((resolve) => { resolveConnect = resolve; });
  mock.stored = {}; // fresh install: the loaded configuration has no scopes
  jest.isolateModules(() => { require("../plugin"); });

  fire("globalSettings", { settings: scopeSettings("From event") });
  expect(lines("DeckSync", /global-settings event before start/)).toHaveLength(1);
  await fire("sendToPlugin", { payload: { event: "setGlobalSettings", settings: scopeSettings("Saved early") } });
  expect(lines("DeckSync", /^Settings saved: 1 scope\(s\)\./)).toHaveLength(1);
  expect(lines("sync", /^SETTINGS applied/)).toHaveLength(0);

  resolveConnect();
  await settle();
  // The save made during start-up is what start() applied (the loaded settings had no scopes).
  expect(lines("sync", /^START devices=\[P,C1\] scopes=1 /)).toHaveLength(1);
  expect(lines("sync", /^SETTINGS applied \(start\) scopes=\[desk/)).toHaveLength(1);
  expect(lines("sync", /^SETTINGS unchanged \(update\)/)).toHaveLength(1); // re-applying it after start is a no-op
  // From now on saves and events are applied directly.
  await fire("sendToPlugin", { payload: { event: "setGlobalSettings", settings: { version: GLOBAL_SETTINGS_VERSION, scopes: [] } } });
  expect(lines("sync", /^SETTINGS applied \(update\) scopes=\[\]/)).toHaveLength(1);
});

test("a PI save that arrives while the start-up load is pending becomes the start configuration (R5-F16)", async () => {
  let release: (s: unknown) => void = () => {};
  mock.load = () => new Promise((resolve) => { release = resolve; });
  mock.connect = () => Promise.resolve();
  jest.isolateModules(() => { require("../plugin"); });
  await settle(); // connected; the settings read is pending
  await fire("sendToPlugin", { payload: { event: "setGlobalSettings", settings: scopeSettings("Saved during load") } });
  expect(lines("sync", /^SETTINGS applied/)).toHaveLength(0);
  release({});
  await settle();
  expect(lines("sync", /^SETTINGS applied \(start\) scopes=\[desk/)).toHaveLength(1);
  expect(lines("sync", /^START devices=\[P,C1\] scopes=1 /)).toHaveLength(1);
  expect(lines("sync", /^SETTINGS applied \(update\)/)).toHaveLength(0);
});

test("a lost global-settings reply does not stall start-up: after 15 s the engine starts with defaults and the late reply is applied (R5-F11)", async () => {
  jest.useFakeTimers();
  mock.load = () => new Promise(() => {}); // never answered
  mock.connect = () => Promise.resolve();
  jest.isolateModules(() => { require("../plugin"); });
  await jest.advanceTimersByTimeAsync(14_999);
  expect(lines("sync", /^START/)).toHaveLength(0);
  await jest.advanceTimersByTimeAsync(1);
  expect(lines("DeckSync", /^Settings: no reply from Stream Deck within 15000ms; starting with defaults/)).toHaveLength(1);
  expect(lines("sync", /^START devices=\[P,C1\] scopes=0 /)).toHaveLength(1);
  await fire("globalSettings", { settings: scopeSettings("Late") }); // the SDK raises the event when the reply finally comes
  expect(lines("sync", /^SETTINGS applied \(update\) scopes=\[desk/)).toHaveLength(1);
});

test("a reply that lands while start() is still replaying is applied once start has finished (R7-F7)", async () => {
  jest.useFakeTimers();
  let release: (s: unknown) => void = () => {};
  mock.load = () => new Promise((resolve) => { release = resolve; });
  mock.connect = () => Promise.resolve();
  jest.isolateModules(() => { require("../plugin"); });
  await jest.advanceTimersByTimeAsync(15_000);
  expect(lines("sync", /^START .*scopes=0 /)).toHaveLength(1);
  release(scopeSettings("Late")); // the read resolves after all (its event, had it come during start(), was ignored)
  await jest.advanceTimersByTimeAsync(0);
  expect(lines("sync", /^SETTINGS applied \(update\) scopes=\[desk/)).toHaveLength(1);
});

test("a failed connect is logged as a start-up failure, never thrown", async () => {
  mock.connect = () => Promise.reject(new Error("no app"));
  jest.isolateModules(() => { require("../plugin"); });
  await settle();
  expect(lines("DeckSync", /^Startup failed: no app$/)).toHaveLength(1);
  expect(lines("sync", /^START/)).toHaveLength(0);
});
