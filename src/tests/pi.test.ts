/**
 * @jest-environment jsdom
 *
 * The Property Inspector (ui/anchor.html) against a fake Stream Deck socket: marker
 * hydration and saving, the initial-load handshake with retries, the setup table,
 * Save/Discard, and the review findings on its state handling (R4-F8, F10–F15).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Msg = Record<string, unknown>;

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Msg[] = [];
  private listeners = new Map<string, Array<(ev: unknown) => void>>();
  constructor(public url: string) { FakeSocket.instances.push(this); }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  private emit(type: string, ev: unknown) { for (const fn of this.listeners.get(type) ?? []) fn(ev); }
  open() { this.readyState = 1; this.emit("open", {}); }
  close() { this.readyState = 3; this.emit("close", {}); }
  receive(msg: Msg) { this.emit("message", { data: JSON.stringify(msg) }); }
  fromPlugin(payload: Msg) { this.receive({ event: "sendToPropertyInspector", payload }); }
  /** Messages sent to the plugin (sendToPlugin payloads), by event name. */
  toPlugin(event?: string) {
    return this.sent.filter((m) => m.event === "sendToPlugin").map((m) => m.payload as Msg).filter((p) => !event || p.event === event);
  }
  events(event: string) { return this.sent.filter((m) => m.event === event); }
}

const html = readFileSync(join(__dirname, "../../com.johnmschoonover.decksync.sdPlugin/ui/anchor.html"), "utf8");
const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
const body = /<body[^>]*>([\s\S]*?)<script>/.exec(html)![1];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = () => $("status").textContent;
const setInput = (el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new Event("input")); };
const select = (el: HTMLSelectElement, value: string) => { el.value = value; el.dispatchEvent(new Event("change")); };
const byLabel = <T extends HTMLElement>(label: string) => document.querySelector(`[aria-label="${label}"]`) as T;
const byFocus = <T extends HTMLElement>(key: string) => document.querySelector(`[data-focus="${key}"]`) as T;
/** The id the panel attached to its most recent Save (the plugin echoes it in the reply). */
const lastSaveId = (ws: FakeSocket) => ws.toPlugin("setGlobalSettings").at(-1)!.id as number;

const DEVICES = [
  { id: "P", name: "Deck P", type: 0, isConnected: true, defaultProfile: "profiles/original" },
  { id: "C1", name: "Deck C1", type: 7, isConnected: false },
];
const SAVED = { version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }] };

/** Loads the page and connects it, as Stream Deck would, with the given saved marker settings. */
function openPanel(markerSettings: Msg = {}, device = "P") {
  document.body.innerHTML = body;
  (globalThis as unknown as { CSS: unknown }).CSS = { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) };
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  new Function(script)();
  const connect = (window as unknown as { connectElgatoStreamDeckSocket: (...a: unknown[]) => void }).connectElgatoStreamDeckSocket;
  connect(28196, "pi-uuid", "registerPropertyInspector", "{}", JSON.stringify({ device, action: "com.test.anchor", payload: { settings: markerSettings } }));
  const ws = FakeSocket.instances[FakeSocket.instances.length - 1];
  ws.open();
  return ws;
}
/** The usual happy handshake: devices and settings arrive. */
function loadedPanel(saved: Msg = SAVED, markerSettings: Msg = {}) {
  const ws = openPanel(markerSettings);
  ws.fromPlugin({ event: "devices", devices: DEVICES });
  ws.fromPlugin({ event: "globalSettings", settings: saved, issues: [] });
  return ws;
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.instances.length = 0;
});
afterEach(() => jest.useRealTimers());

describe("connect and load", () => {
  test("registers, asks for the marker settings, the device list and the global settings; the setup stays disabled until settings arrive", () => {
    const ws = openPanel({ pageIndex: 2, enabled: false });
    expect(ws.sent[0]).toEqual({ event: "registerPropertyInspector", uuid: "pi-uuid" });
    expect(ws.events("getSettings")).toHaveLength(1);
    expect(ws.toPlugin().map((p) => p.event)).toEqual(["getDevices", "getGlobalSettings"]);
    expect(ws.toPlugin()[0]).toMatchObject({ event: "getDevices" });
    expect(ws.sent.find((m) => m.event === "sendToPlugin")).toMatchObject({ context: "pi-uuid", action: "com.test.anchor" });
    expect($<HTMLInputElement>("pageIndex").value).toBe("2");
    expect($<HTMLInputElement>("enabled").checked).toBe(false);
    expect($<HTMLButtonElement>("save").disabled).toBe(true);
    expect($("setup").textContent).toContain("Loading the saved configuration");
    expect($("thisDevice").textContent).toBe("unknown device P");

    ws.fromPlugin({ event: "devices", devices: DEVICES });
    expect($("thisDevice").textContent).toBe("Deck P");
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [] });
    expect($<HTMLButtonElement>("save").disabled).toBe(false);
    expect(byLabel<HTMLSelectElement>("Scope for Deck P").value).toBe("scope-1");
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("parent");
    expect(byLabel<HTMLSelectElement>("Role of Deck C1 (disconnected)").value).toBe("child");
    expect(document.querySelector(".ds-scope summary")!.textContent).toBe("Scope 1: parent Deck P, 1 child");
    expect(status()).toBe("");
  });

  test("retries the handshake twice, then reports that the plugin did not answer", () => {
    const ws = openPanel();
    jest.advanceTimersByTime(3000);
    expect(status()).toBe("Waiting for the plugin…");
    jest.advanceTimersByTime(3000);
    expect(ws.toPlugin("getGlobalSettings")).toHaveLength(3);
    jest.advanceTimersByTime(3000);
    expect(status()).toBe("No reply from the plugin — is it running? Close and reopen this panel.");
    expect(ws.toPlugin("getGlobalSettings")).toHaveLength(3);
  });

  test("R4-F10 a dropped device-list reply is asked for again on its own, and reported if it never comes", () => {
    const ws = openPanel();
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [] });
    jest.advanceTimersByTime(3000);
    expect(ws.toPlugin("getDevices")).toHaveLength(2);
    expect(ws.toPlugin("getGlobalSettings")).toHaveLength(1);
    expect(status()).toBe(""); // the configuration is loaded; no misleading "waiting"
    jest.advanceTimersByTime(6000);
    expect(status()).toBe("The plugin did not send its device list — close and reopen this panel to see every device.");
    // Members from the saved configuration are still listed, so the scope can be edited.
    expect(byLabel<HTMLSelectElement>("Scope for unknown device P").value).toBe("scope-1");
  });

  test("nothing can be edited before the first load: the setup controls are disabled, then enabled by the reply", () => {
    const ws = openPanel();
    ws.fromPlugin({ event: "devices", devices: DEVICES });
    expect($("setup").textContent).toContain("Loading the saved configuration");
    expect($("setup").querySelectorAll("input, select, button")).toHaveLength(0);
    expect($<HTMLButtonElement>("addScope").disabled).toBe(true);
    expect($<HTMLButtonElement>("save").disabled).toBe(true);
    $("addScope").click(); // disabled: nothing happens
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [] });
    expect($<HTMLButtonElement>("addScope").disabled).toBe(false);
    expect($<HTMLButtonElement>("save").disabled).toBe(false);
    expect(status()).toBe("");
    expect(document.querySelectorAll(".ds-scope")).toHaveLength(1);
  });

  test("R4-F15 a socket that closes while loading stops the watchdog and says so", () => {
    const ws = openPanel();
    ws.close();
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    jest.advanceTimersByTime(10000);
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    expect($<HTMLButtonElement>("save").disabled).toBe(true);
  });

  test("saved settings with problems are shown once loaded", () => {
    const ws = openPanel();
    ws.fromPlugin({ event: "devices", devices: DEVICES });
    ws.fromPlugin({ event: "globalSettings", settings: { version: 2, scopes: [] }, issues: [{ scopeId: "bad", message: "Scope 'bad' ignored: a scope needs exactly one parent; found 0." }] });
    expect(status()).toBe("Saved settings had problems; invalid scopes were ignored:\n• Scope 'bad' ignored: a scope needs exactly one parent; found 0.");
  });
});

describe("this marker", () => {
  test("typing a page index saves it; blank clears it; the enabled box is saved too", () => {
    const ws = loadedPanel();
    setInput($("pageIndex"), "3");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: true, pageIndex: 3 } });
    setInput($("pageIndex"), "");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: true } });
    $<HTMLInputElement>("enabled").checked = false;
    $("enabled").dispatchEvent(new Event("change"));
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: false } });
  });

  test("an invalid page index is flagged and not saved, while Enabled still is (R5-F13)", () => {
    const ws = loadedPanel(SAVED, { pageIndex: 2, enabled: true });
    setInput($("pageIndex"), "-1");
    expect($("pageIndex").getAttribute("aria-invalid")).toBe("true");
    expect(status()).toBe("Page index must be a whole number, 0 or more. The page index was not saved; Enabled was.");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: true, pageIndex: 2 } }); // the last valid index
    $<HTMLInputElement>("enabled").checked = false;
    $("enabled").dispatchEvent(new Event("change"));
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: false, pageIndex: 2 } });
    setInput($("pageIndex"), "4");
    expect($("pageIndex").getAttribute("aria-invalid")).toBe("false");
    expect(status()).toBe("");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: false, pageIndex: 4 } });
  });

  test("R4-F11 a late didReceiveSettings reply does not overwrite a page index the user already typed", () => {
    const ws = openPanel({ pageIndex: 1 });
    setInput($("pageIndex"), "4");
    ws.receive({ event: "didReceiveSettings", payload: { settings: { pageIndex: 1, enabled: true } } });
    expect($<HTMLInputElement>("pageIndex").value).toBe("4");
    const ws2 = openPanel({});
    ws2.receive({ event: "didReceiveSettings", payload: { settings: { pageIndex: 1, enabled: true } } });
    expect($<HTMLInputElement>("pageIndex").value).toBe("1"); // untouched fields do hydrate
  });
});

describe("setup: scopes, roles, overrides", () => {
  test("building a scope from scratch: first device becomes the parent, the next a child; Save sends it and the reply confirms", () => {
    const ws = loadedPanel({ version: 2, scopes: [] });
    select(byLabel("Scope for Deck P"), "__new");
    expect(status()).toBe("Unsaved changes.");
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("parent");
    select(byLabel("Scope for Deck C1 (disconnected)"), "scope-1");
    expect(byLabel<HTMLSelectElement>("Role of Deck C1 (disconnected)").value).toBe("child");
    setInput(byLabel("Profile for Deck C1 (disconnected)"), "profiles/plus");
    setInput(byLabel("Page count of Deck C1 (disconnected)"), "8");
    $("save").click();
    expect(status()).toBe("Saving…");
    const sent = ws.toPlugin("setGlobalSettings");
    expect(sent).toHaveLength(1);
    expect(sent[0].settings).toEqual({ version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child", profile: "profiles/plus", pageCount: 8 }], mapping: { mode: "positional", overrides: [] } }] });
    ws.fromPlugin({ event: "globalSettings", settings: sent[0].settings as Msg, issues: [], id: lastSaveId(ws) });
    expect(status()).toBe("Saved.");
    expect($("status").className).toContain("ok");
  });

  test("changing a role demotes the previous parent; Discard returns to the saved configuration", () => {
    loadedPanel();
    select(byLabel("Role of Deck C1 (disconnected)"), "parent");
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("child");
    expect(document.querySelector(".ds-scope summary")!.textContent).toBe("Scope 1: parent Deck C1 (disconnected), 1 child");
    $("discard").click();
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("parent");
    expect(status()).toBe("");
  });

  test("a rejected save keeps the draft dirty and shows the reasons", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "Scope 'scope-1' ignored: a scope needs exactly one parent; found 0." }], id: lastSaveId(ws) });
    expect(status()).toBe("Not saved — fix these and try again:\n• Scope 'scope-1' ignored: a scope needs exactly one parent; found 0.");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Desk");
  });

  test("no reply to a save is reported after 5 s", () => {
    loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    jest.advanceTimersByTime(5000);
    expect(status()).toBe("No reply from the plugin — is it running? Try Save again.");
  });

  test("R4-F8 edits made while a save is in flight are kept, and the reply says so", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as Msg;
    setInput(byLabel("Name of scope-1"), "Desk 2"); // typed while the plugin was saving
    ws.fromPlugin({ event: "globalSettings", settings: sent, issues: [], id: lastSaveId(ws) });
    expect(status()).toBe("Saved; you have further unsaved changes.");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Desk 2");
    $("save").click();
    expect((ws.toPlugin("setGlobalSettings")[1].settings as { scopes: Array<{ name: string }> }).scopes[0].name).toBe("Desk 2");
  });

  test("R5-F10 Discard while a save is in flight cannot take the save back: the confirmed configuration is adopted", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as Msg;
    $("discard").click();
    expect(status()).toBe("Saving… (the save already sent cannot be discarded)");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Scope 1"); // until the plugin answers
    ws.fromPlugin({ event: "globalSettings", settings: sent, issues: [], id: lastSaveId(ws) });
    expect(status()).toBe("Saved.");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Desk"); // what the plugin holds
    $("save").click();
    expect((ws.toPlugin("setGlobalSettings")[1].settings as { scopes: Array<{ name: string }> }).scopes[0].name).toBe("Desk"); // a re-save changes nothing
  });

  test("R5-F15 devices with the same name are told apart by their id; override rows carry their number", () => {
    const twins = [{ id: "A", name: "Stream Deck", type: 0, isConnected: true }, { id: "B", name: "Stream Deck", type: 0, isConnected: true }];
    const ws = openPanel({}, "A");
    ws.fromPlugin({ event: "devices", devices: twins });
    ws.fromPlugin({ event: "globalSettings", settings: { version: 2, scopes: [{ id: "scope-1", name: "Twins", parentDeviceId: "A", members: [{ deviceId: "A", role: "parent" }, { deviceId: "B", role: "child" }], mapping: { mode: "positional", overrides: [{ a: { deviceId: "A", page: 1 }, b: { deviceId: "B", page: 2 } }, { a: { deviceId: "A", page: 3 }, b: { deviceId: "B", page: 4 } }] } }] }, issues: [] });
    expect($("thisDevice").textContent).toBe("Stream Deck (A)");
    expect(byLabel<HTMLSelectElement>("Role of Stream Deck (B)").value).toBe("child");
    expect(byLabel<HTMLInputElement>("Child page (override 2 of scope-1)").value).toBe("4");
    expect(byLabel("Remove override 2 of scope-1")).not.toBeNull();
    expect(byLabel<HTMLSelectElement>("Child device (override 1 of scope-1)").value).toBe("B");
  });

  test("overrides: added with the parent/child pre-filled, edited, and validated on Save (R4-F12 a blank page box blocks Save)", () => {
    const ws = loadedPanel();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    expect(document.querySelector(".ds-scope summary")!.textContent).toContain("1 override(s)");
    setInput(byLabel("Parent page (override 1 of scope-1)"), "2");
    setInput(byLabel("Child page (override 1 of scope-1)"), "4");
    setInput(byLabel("Child page (override 1 of scope-1)"), ""); // mid-edit blank keeps the draft's 4 but must not be saved as such
    $("save").click();
    expect(status()).toBe("Fix the highlighted fields first.");
    expect(byLabel("Child page (override 1 of scope-1)").getAttribute("aria-invalid")).toBe("true");
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
    setInput(byLabel("Child page (override 1 of scope-1)"), "3");
    $("save").click();
    expect((ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ mapping: { overrides: unknown[] } }> }).scopes[0].mapping.overrides)
      .toEqual([{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 3 } }]);
  });

  test("R7-F6 two saves in flight: only the reply to the last one confirms the draft", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "First");
    $("save").click();
    setInput(byLabel("Name of scope-1"), "Second");
    $("save").click();
    const [p1, p2] = ws.toPlugin("setGlobalSettings");
    ws.fromPlugin({ event: "globalSettings", settings: p1.settings as Msg, issues: [], id: p1.id as number });
    expect(status()).toBe("Saving…"); // reply #1 is not the confirmation
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Second");
    ws.fromPlugin({ event: "globalSettings", settings: p2.settings as Msg, issues: [], id: p2.id as number });
    expect(status()).toBe("Saved.");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Second");
    setInput(byLabel("Profile for Deck P"), "profiles/x");
    $("save").click();
    expect((ws.toPlugin("setGlobalSettings")[2].settings as { scopes: Array<{ name: string }> }).scopes[0].name).toBe("Second"); // nothing reverted to First
  });

  test("R8-F6 a lost reply does not poison later saves, and a late load reply is never taken for a confirmation", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Lost");
    $("save").click(); // its reply never comes
    jest.advanceTimersByTime(5000);
    expect(status()).toBe("No reply from the plugin — is it running? Try Save again.");
    setInput(byLabel("Name of scope-1"), "Second");
    $("save").click();
    const [lost, second] = ws.toPlugin("setGlobalSettings");
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [] }); // a slow reply to the initial load (no id)
    expect(status()).toBe("Saving…"); // not mistaken for the confirmation; the draft is kept
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Second");
    ws.fromPlugin({ event: "globalSettings", settings: lost.settings as Msg, issues: [], id: lost.id as number }); // the lost reply turns up after all
    expect(status()).toBe("Saving…");
    ws.fromPlugin({ event: "globalSettings", settings: second.settings as Msg, issues: [], id: second.id as number });
    expect(status()).toBe("Saved.");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Second");
    setInput(byLabel("Name of scope-1"), "Third");
    $("save").click();
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "nope" }], id: lastSaveId(ws) });
    expect(status()).toBe("Not saved — fix these and try again:\n• nope"); // a rejection for the current save is honoured
  });

  test("R8-F9 renaming a scope refreshes the dropdown, the summary and the button names once the box is left", () => {
    loadedPanel();
    const name = byLabel<HTMLInputElement>("Name of scope-1");
    setInput(name, "Desk");
    expect(document.querySelector(".ds-scope summary")!.textContent).toBe("Scope 1: parent Deck P, 1 child"); // not yet
    name.dispatchEvent(new Event("change"));
    expect(document.querySelector(".ds-scope summary")!.textContent).toBe("Desk: parent Deck P, 1 child");
    expect(byLabel("Remove scope Desk")).not.toBeNull();
    expect([...byLabel<HTMLSelectElement>("Scope for Deck P").options].map((o) => o.textContent)).toContain("Desk");
  });

  test("R8-F13 odd inputs: a socket error, malformed JSON, a reply without settings, edits while disconnected, an unknown device", () => {
    const ws = openPanel({}, "");
    expect($("thisDevice").textContent).toBe("(unknown)");
    ws.receive({ event: "sendToPropertyInspector", payload: { event: "globalSettings", issues: [] } } as Msg); // no settings: defaults
    expect($("setup").textContent).toContain("No Stream Deck devices known yet.");
    (ws as unknown as { emitRaw: (d: string) => void }).emitRaw?.("not json");
    ws.receive({ event: "nonsense" });
    ws.close();
    setInput($("pageIndex"), "2");
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    $("save").click();
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    expect(ws.events("setSettings")).toHaveLength(0);
  });

  test("R7-F11 a save confirmed after the watchdog gave up still clears the error and the dirty state", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as Msg;
    jest.advanceTimersByTime(5000);
    expect(status()).toBe("No reply from the plugin — is it running? Try Save again.");
    ws.fromPlugin({ event: "globalSettings", settings: sent, issues: [], id: lastSaveId(ws) });
    expect(status()).toBe("Saved.");
    $("discard").click();
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Desk"); // it was saved, so there is nothing to discard
  });

  test("R7-F12 a rejection arriving after Discard says so instead of asking to fix fields no longer shown", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    $("discard").click();
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "page 9 is beyond the page count" }], id: lastSaveId(ws) });
    expect(status()).toBe("The save sent earlier was rejected; the panel shows the last saved configuration:\n• page 9 is beyond the page count");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Scope 1");
  });

  test("R7-F13 a device push while a number is being typed keeps the text and its validity mark", () => {
    const ws = loadedPanel();
    const pages = byLabel<HTMLInputElement>("Page count of Deck P");
    pages.focus();
    setInput(pages, "0");
    expect(pages.getAttribute("aria-invalid")).toBe("true");
    ws.fromPlugin({ event: "devices", devices: [DEVICES[0], { ...DEVICES[1], isConnected: true }] }); // re-renders
    const again = byLabel<HTMLInputElement>("Page count of Deck P");
    expect(again.value).toBe("0");
    expect(again.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(again);
    $("save").click();
    expect(status()).toBe("Fix the highlighted fields first.");
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
  });

  test("R6-F8 a rejected save leaves the override rows pointing at the right overrides, stale ones included", () => {
    // Saved: P parent with an override. Swapping roles makes that override stale (hidden, dropped on Save).
    const saved = { version: 2, scopes: [{ ...SAVED.scopes[0], mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 1 }, b: { deviceId: "C1", page: 2 } }] } }] };
    const ws = loadedPanel(saved);
    select(byLabel("Role of Deck C1 (disconnected)"), "parent");
    expect($("setup").textContent).toContain("1 override(s) no longer involve the parent");
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    setInput(byLabel("Parent page (override 2 of scope-1)"), "9"); // rows are numbered by their place in the draft
    setInput(byLabel("Child page (override 3 of scope-1)"), "3");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ parentDeviceId: string; mapping: { overrides: unknown[] } }> };
    expect(sent.scopes[0].parentDeviceId).toBe("C1");
    expect(sent.scopes[0].mapping.overrides).toEqual([{ a: { deviceId: "C1", page: 9 }, b: { deviceId: "P", page: 0 } }, { a: { deviceId: "C1", page: 0 }, b: { deviceId: "P", page: 3 } }]);
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "page 9 is beyond the page count" }], id: lastSaveId(ws) });
    expect(status()).toContain("Not saved");
    byLabel<HTMLButtonElement>("Remove override 2 of scope-1").click(); // the page-9 row
    expect(byLabel<HTMLInputElement>("Child page (override 3 of scope-1)")).toBeNull();
    expect(byLabel<HTMLInputElement>("Parent page (override 2 of scope-1)").value).toBe("0"); // the other live row survived, renumbered
    expect(byLabel<HTMLInputElement>("Child page (override 2 of scope-1)").value).toBe("3");
    expect($("setup").textContent).toContain("1 override(s) no longer involve the parent"); // the stale one is still kept for Discard
    $("discard").click();
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("parent");
    expect(byLabel<HTMLInputElement>("Child page (override 1 of scope-1)").value).toBe("2"); // the original override is back
  });

  test("R6-F15 the page-count and override-page validators flag bad values with their messages and block Save until fixed", () => {
    const ws = loadedPanel();
    setInput(byLabel("Page count of Deck P"), "0");
    expect(byLabel("Page count of Deck P").getAttribute("aria-invalid")).toBe("true");
    expect(status()).toBe("Pages must be a whole number, 1 or more.");
    $("save").click();
    expect(status()).toBe("Fix the highlighted fields first.");
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
    setInput(byLabel("Page count of Deck P"), "8");
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    setInput(byLabel("Child page (override 1 of scope-1)"), "-1");
    expect(status()).toBe("Child page (override 1 of scope-1) must be a whole number, 0 or more.");
    $("save").click();
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
    setInput(byLabel("Child page (override 1 of scope-1)"), "2");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ members: Array<{ pageCount?: number }>; mapping: { overrides: unknown[] } }> };
    expect(sent.scopes[0].members[0].pageCount).toBe(8);
    expect(sent.scopes[0].mapping.overrides).toEqual([{ a: { deviceId: "P", page: 0 }, b: { deviceId: "C1", page: 2 } }]);
  });

  test("R6-F14 scope buttons are named after their scope", () => {
    loadedPanel();
    expect(byLabel("Remove scope Scope 1")).not.toBeNull();
    expect(byLabel("Add override to Scope 1")).not.toBeNull();
  });

  test("R4-F13 removing an override with the keyboard moves the focus to Add override, not to the next row's remove button", () => {
    loadedPanel();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    const remove = byLabel<HTMLButtonElement>("Remove override 1 of scope-1");
    remove.focus();
    remove.click();
    expect(document.querySelectorAll('[aria-label^="Remove override"]')).toHaveLength(1);
    expect(document.activeElement).toBe(byFocus("addov:scope-1"));
  });

  test("R4-F14 stepping a device through the scope list does not leave empty scopes behind", () => {
    loadedPanel({ version: 2, scopes: [] });
    const scopeSelect = () => byLabel<HTMLSelectElement>("Scope for Deck P");
    select(scopeSelect(), "__new");
    expect(document.querySelectorAll(".ds-scope")).toHaveLength(1);
    select(scopeSelect(), "");
    expect(document.querySelectorAll(".ds-scope")).toHaveLength(0);
    select(scopeSelect(), "__new");
    select(scopeSelect(), "__new");
    expect(document.querySelectorAll(".ds-scope")).toHaveLength(1);
    expect(scopeSelect().value).toBe("scope-1");
  });

  test("Remove scope and Add scope: an empty scope is dropped on Save; a removed scope frees its devices", () => {
    const ws = loadedPanel();
    $("addScope").click();
    expect(document.querySelectorAll(".ds-scope")).toHaveLength(2);
    const remove = byFocus<HTMLButtonElement>("rmscope:scope-1");
    remove.focus();
    remove.click();
    expect(byLabel<HTMLSelectElement>("Scope for Deck P").value).toBe("");
    expect(document.activeElement).toBe($("addScope")); // R4-F13: focus has somewhere to go
    $("save").click();
    expect(ws.toPlugin("setGlobalSettings")[0].settings).toEqual({ version: 2, scopes: [] });
  });

  test("a device push re-renders only when the list changed, keeping the control being edited", () => {
    const ws = loadedPanel();
    const name = byLabel<HTMLInputElement>("Name of scope-1");
    name.focus();
    setInput(name, "Des");
    ws.fromPlugin({ event: "devices", devices: DEVICES }); // unchanged list
    expect(document.activeElement).toBe(name);
    ws.fromPlugin({ event: "devices", devices: [DEVICES[0], { ...DEVICES[1], isConnected: true }] });
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Des");
    expect(document.activeElement).toBe(byLabel("Name of scope-1")); // focus restored on the re-rendered control
    expect(document.querySelector(".ds-scope summary")!.textContent).toBe("Des: parent Deck P, 1 child");
  });
});
