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
  /** A raw frame, as a broken peer might send one. */
  emitRaw(data: string) { this.emit("message", { data }); }
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
/** Types a value and finishes the edit (blur/Enter), as a person does with the marker's page index. */
const commitInput = (el: HTMLInputElement, value: string) => { setInput(el, value); el.dispatchEvent(new Event("change")); };
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
    expect(status()).toBe("The plugin did not receive this panel's messages — make sure the device is connected and this page is showing on it, then close and reopen the panel.");
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
  test("a finished page-index edit saves it (typing alone does not, R13-F6); blank clears it; the enabled box is saved too", () => {
    const ws = loadedPanel();
    setInput($("pageIndex"), "1"); // on the way to "12"
    expect(ws.events("setSettings")).toHaveLength(0);
    commitInput($("pageIndex"), "12");
    expect(ws.events("setSettings")).toEqual([{ event: "setSettings", context: "pi-uuid", payload: { enabled: true, pageIndex: 12 } }]);
    commitInput($("pageIndex"), "3");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: true, pageIndex: 3 } });
    commitInput($("pageIndex"), "");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: true } });
    $<HTMLInputElement>("enabled").checked = false;
    $("enabled").dispatchEvent(new Event("change"));
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: false } });
  });

  test("an invalid page index is flagged and not saved, while Enabled still is (R5-F13)", () => {
    const ws = loadedPanel(SAVED, { pageIndex: 2, enabled: true });
    setInput($("pageIndex"), "-1");
    expect($("pageIndex").getAttribute("aria-invalid")).toBe("true");
    expect(status()).toBe("Page index must be a whole number, 0 or more. It is saved once it is.");
    expect(ws.events("setSettings")).toHaveLength(0); // nothing sent while typing
    commitInput($("pageIndex"), "-1");
    expect(status()).toBe("Page index must be a whole number, 0 or more. The page index was not saved; Enabled was.");
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: true, pageIndex: 2 } }); // the last valid index
    $<HTMLInputElement>("enabled").checked = false;
    $("enabled").dispatchEvent(new Event("change"));
    expect(ws.events("setSettings").pop()).toEqual({ event: "setSettings", context: "pi-uuid", payload: { enabled: false, pageIndex: 2 } });
    commitInput($("pageIndex"), "4");
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

  test("R14-F7 the problems a rejected Save reported stay up while the user works through them; the next Save or a Discard replaces them", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "Scope 'scope-1' ignored: duplicate page pin." }], id: lastSaveId(ws) });
    const list = "Not saved — fix these and try again:\n• Scope 'scope-1' ignored: duplicate page pin.";
    expect(status()).toBe(list);
    setInput(byLabel("Name of scope-1"), "Desk 2"); // the first keystroke of the fix
    expect(status()).toBe(list);
    select(byLabel("Role of Deck P"), "parent");
    expect(status()).toBe(list);
    $("save").click();
    expect(status()).toBe("Saving…");
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "still wrong" }], id: lastSaveId(ws) });
    expect(status()).toBe("Not saved — fix these and try again:\n• still wrong");
    $("discard").click();
    expect(status()).toBe("");
    setInput(byLabel("Name of scope-1"), "Desk 3");
    expect(status()).toBe("Unsaved changes.");
    // A rejection answered after a Discard (the draft is clean) is informational: the next edit is an unsaved change like any other.
    setInput(byLabel("Name of scope-1"), "Desk 4");
    $("save").click();
    $("discard").click();
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "late" }], id: lastSaveId(ws) });
    expect(status()).toBe("The save sent earlier was rejected; the panel shows the last saved configuration:\n• late");
    setInput(byLabel("Name of scope-1"), "Desk 5");
    expect(status()).toBe("Unsaved changes.");
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
    expect(status()).toMatch(/^Fix the highlighted fields first: /);
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

  test("R8-F9/R9-F6 renaming a scope refreshes the dropdown, the summary and the button names in place, keeping the controls", () => {
    loadedPanel();
    const name = byLabel<HTMLInputElement>("Name of scope-1");
    const remove = byLabel<HTMLButtonElement>("Remove scope Scope 1");
    name.focus();
    setInput(name, "Desk");
    expect(document.querySelector(".ds-scope summary")!.textContent).toBe("Desk: parent Deck P, 1 child");
    expect(remove.getAttribute("aria-label")).toBe("Remove scope Desk");
    expect(byLabel("Add override to Desk")).not.toBeNull();
    expect([...byLabel<HTMLSelectElement>("Scope for Deck P").options].map((o) => o.textContent)).toContain("Desk");
    expect(remove.isConnected).toBe(true); // the same button is still in the document: a click that follows the rename lands
    expect(document.activeElement).toBe(name);
    name.dispatchEvent(new Event("change"));
    expect(remove.isConnected).toBe(true);
  });

  test("R9-F10 an invalid number survives a re-render, still flagged, until it is fixed", () => {
    const ws = loadedPanel();
    setInput(byLabel("Page count of Deck P"), "0");
    select(byLabel("Role of Deck C1 (disconnected)"), "parent"); // re-renders everything
    const pages = byLabel<HTMLInputElement>("Page count of Deck P");
    expect(pages.value).toBe("0");
    expect(pages.getAttribute("aria-invalid")).toBe("true");
    $("save").click();
    expect(status()).toMatch(/^Fix the highlighted fields first: /);
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
    setInput(byLabel("Page count of Deck P"), "6");
    select(byLabel("Role of Deck P"), "parent"); // re-renders again: the fixed value is in the draft, nothing is flagged
    expect(byLabel<HTMLInputElement>("Page count of Deck P").value).toBe("6");
    expect(byLabel<HTMLInputElement>("Page count of Deck P").getAttribute("aria-invalid")).not.toBe("true");
    $("save").click();
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(1);
    $("discard").click();
    expect(byLabel<HTMLInputElement>("Page count of Deck P").value).toBe("");
  });

  test("R9-F11 editing while a save is pending keeps 'Saving…' on screen", () => {
    loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    setInput(byLabel("Name of scope-1"), "Desk 2");
    expect(status()).toBe("Saving…");
  });

  test("R8-F13 odd inputs: a socket error, malformed JSON, a reply without settings, edits while disconnected, an unknown device", () => {
    const ws = openPanel({}, "");
    expect($("thisDevice").textContent).toBe("(unknown)");
    ws.receive({ event: "sendToPropertyInspector", payload: { event: "globalSettings", issues: [] } } as Msg); // no settings: defaults
    expect($("setup").textContent).toContain("No Stream Deck devices known yet.");
    ws.emitRaw("not json"); // ignored
    ws.receive({ event: "nonsense" });
    expect($("setup").textContent).toContain("No Stream Deck devices known yet.");
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
    expect(status()).toMatch(/^Fix the highlighted fields first: /);
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
  });

  test("R10-F7 invalid page-count text does not follow a device out of its scope: the disabled box never blocks Save", () => {
    const ws = loadedPanel();
    setInput(byLabel("Page count of Deck P"), "0");
    expect(byLabel("Page count of Deck P").getAttribute("aria-invalid")).toBe("true");
    select(byLabel("Scope for Deck P"), ""); // — not synced —
    const box = byLabel<HTMLInputElement>("Page count of Deck P");
    expect(box.disabled).toBe(true);
    expect(box.getAttribute("aria-invalid")).not.toBe("true");
    $("save").click();
    expect(status()).toBe("Saving…");
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(1);
  });

  test("R10-F8 removing an override row does not hand its invalid text to the row that takes its place", () => {
    const ws = loadedPanel();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    setInput(byLabel("Parent page (override 2 of scope-1)"), "3");
    setInput(byLabel("Parent page (override 1 of scope-1)"), "-1");
    expect(byLabel("Parent page (override 1 of scope-1)").getAttribute("aria-invalid")).toBe("true");
    byLabel<HTMLButtonElement>("Remove override 1 of scope-1").click();
    const survivor = byLabel<HTMLInputElement>("Parent page (override 1 of scope-1)");
    expect(survivor.value).toBe("3"); // the other row, renumbered, with its own value
    expect(survivor.getAttribute("aria-invalid")).not.toBe("true");
    $("save").click();
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(1);
  });

  test("R10-F9/R14-F9 a Save blocked by a field inside a collapsed scope opens the scope, focuses the field and names it", () => {
    const ws = loadedPanel();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    setInput(byLabel("Parent page (override 1 of scope-1)"), "-1");
    const scope = () => document.querySelector<HTMLDetailsElement>("details.ds-scope")!;
    scope().open = false;
    scope().dispatchEvent(new Event("toggle")); // the person collapsed it (jsdom queues the browser's own toggle event; the panel listens for it)
    select(byLabel("Role of Deck P"), "parent"); // a re-render keeps it collapsed
    expect(scope().open).toBe(false);
    $("save").click();
    expect(status()).toBe("Fix the highlighted fields first: Parent page (override 1 of scope-1).");
    expect(scope().open).toBe(true);
    expect(document.activeElement).toBe(byLabel("Parent page (override 1 of scope-1)"));
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
    setInput(byLabel("Parent page (override 1 of scope-1)"), "1");
    select(byLabel("Role of Deck P"), "parent"); // a re-render keeps the scope open: the blocked Save un-collapsed it for good
    expect(scope().open).toBe(true);
    // Collapsing and expanding by hand round-trips the same way.
    scope().open = false;
    scope().dispatchEvent(new Event("toggle"));
    scope().open = true;
    scope().dispatchEvent(new Event("toggle"));
    select(byLabel("Role of Deck P"), "parent");
    expect(scope().open).toBe(true);
  });

  test("R10-F10 a late load reply with problems does not overwrite 'Saving…' while a save is pending", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Edited");
    $("save").click();
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [{ scopeId: "bad", message: "Scope 'bad' ignored: x" }] }); // a slow initial-load retry, no id
    expect(status()).toBe("Saving…");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Edited");
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [{ scopeId: "bad", message: "Scope 'bad' ignored: x" }], id: lastSaveId(ws) }); // the confirmation reports its problems
    expect(status()).toBe("Saved settings had problems; invalid scopes were ignored:\n• Scope 'bad' ignored: x");
  });

  test("R11-F10 a blank override page box stays blank across a device push and still blocks Save", () => {
    const ws = loadedPanel();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    setInput(byLabel("Child page (override 1 of scope-1)"), "4");
    setInput(byLabel("Child page (override 1 of scope-1)"), "");
    ws.fromPlugin({ event: "devices", devices: [DEVICES[0], { ...DEVICES[1], isConnected: true }] }); // re-renders
    expect(byLabel<HTMLInputElement>("Child page (override 1 of scope-1)").value).toBe("");
    $("save").click();
    expect(status()).toBe("Fix the highlighted fields first: Child page (override 1 of scope-1).");
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
    setInput(byLabel("Child page (override 1 of scope-1)"), "3");
    $("save").click();
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(1);
  });

  test("R11-F11 after a disconnect, edits keep the disconnect message and Add scope is disabled with Save", () => {
    const ws = loadedPanel();
    ws.close();
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    select(byLabel("Role of Deck C1 (disconnected)"), "parent");
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    expect($<HTMLButtonElement>("save").disabled).toBe(true);
    expect($<HTMLButtonElement>("addScope").disabled).toBe(true);
  });

  test("R11-F12 once the Save watchdog has fired, Discard and later edits no longer report a save in progress", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Lost");
    $("save").click();
    jest.advanceTimersByTime(5000);
    expect(status()).toBe("No reply from the plugin — is it running? Try Save again.");
    $("discard").click();
    expect(status()).toBe("");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Scope 1");
    setInput(byLabel("Name of scope-1"), "Again");
    expect(status()).toBe("Unsaved changes.");
    jest.advanceTimersByTime(60_000);
    expect(status()).toBe("Unsaved changes.");
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [], id: lastSaveId(ws) }); // the lost reply arrives after all: still the confirmation of that save
    expect(status()).toBe("Saved; you have further unsaved changes.");
  });

  test("R12-F5 the confirmation of a Save that a later Save replaced still updates what the panel takes as saved", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Desk");
    $("save").click();
    setInput(byLabel("Name of scope-1"), "Desk 2");
    $("save").click();
    const [first, second] = ws.toPlugin("setGlobalSettings");
    const desk = { version: 2, scopes: [{ ...SAVED.scopes[0], name: "Desk" }] };
    ws.fromPlugin({ event: "globalSettings", settings: desk, issues: [], id: first.id }); // the plugin holds "Desk" now
    expect(status()).toBe("Saving…"); // the second Save is still awaiting its verdict
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "Could not save settings (boom)." }], id: second.id });
    expect(status()).toMatch(/^Not saved — fix these and try again:/);
    $("discard").click();
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Desk"); // what the plugin holds, not the stale load
    expect(status()).toBe("");
  });

  test("R12-F6 a device's profile and page count follow it into another scope, and back from — not synced —", () => {
    const saved = { version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child", profile: "profiles/xl", pageCount: 7 }], mapping: { mode: "positional", overrides: [] } }] };
    const ws = loadedPanel(saved);
    expect(byLabel<HTMLInputElement>("Profile for Deck C1 (disconnected)").value).toBe("profiles/xl");
    select(byLabel("Scope for Deck C1 (disconnected)"), "__new");
    expect(byLabel<HTMLInputElement>("Profile for Deck C1 (disconnected)").value).toBe("profiles/xl");
    expect(byLabel<HTMLInputElement>("Page count of Deck C1 (disconnected)").value).toBe("7");
    select(byLabel("Scope for Deck C1 (disconnected)"), "");
    select(byLabel("Scope for Deck C1 (disconnected)"), "scope-1");
    expect(byLabel<HTMLInputElement>("Profile for Deck C1 (disconnected)").value).toBe("profiles/xl");
    expect(byLabel<HTMLInputElement>("Page count of Deck C1 (disconnected)").value).toBe("7");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ members: Array<Record<string, unknown>> }> };
    expect(sent.scopes[0].members).toContainEqual({ deviceId: "C1", role: "child", profile: "profiles/xl", pageCount: 7 });
  });

  test("R14-F8 a profile typed for a device and then discarded, or saved away, does not come back when the device is assigned again", () => {
    const saved = { version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }], mapping: { mode: "positional", overrides: [] } }] };
    const ws = loadedPanel(saved);
    const assign = (to: string) => select(byLabel("Scope for Deck C1 (disconnected)"), to);
    assign("scope-1");
    setInput(byLabel("Profile for Deck C1 (disconnected)"), "profiles/typed-then-discarded");
    assign(""); // out of the scope: the profile is remembered for its next scope …
    $("discard").click(); // … until the draft is thrown away
    assign("scope-1");
    expect(byLabel<HTMLInputElement>("Profile for Deck C1 (disconnected)").value).toBe("");
    setInput(byLabel("Profile for Deck C1 (disconnected)"), "profiles/typed-then-saved-away");
    assign("");
    $("save").click(); // saved with C1 in no scope
    ws.fromPlugin({ event: "globalSettings", settings: saved, issues: [], id: lastSaveId(ws) });
    assign("scope-1");
    expect(byLabel<HTMLInputElement>("Profile for Deck C1 (disconnected)").value).toBe("");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings").at(-1)!.settings as { scopes: Array<{ members: Array<Record<string, unknown>> }> };
    expect(sent.scopes[0].members).toContainEqual({ deviceId: "C1", role: "child" });
    // Within one draft the memory still works (R12-F6).
    setInput(byLabel("Profile for Deck C1 (disconnected)"), "profiles/kept");
    assign("");
    assign("scope-1");
    expect(byLabel<HTMLInputElement>("Profile for Deck C1 (disconnected)").value).toBe("profiles/kept");
  });

  test("R14-F10 an override's child device can be changed, and an override is dropped with the member it names", () => {
    const three = [...DEVICES, { id: "C2", name: "Deck C2", type: 2, isConnected: true }];
    const saved = { version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }, { deviceId: "C2", role: "child" }], mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 1 }, b: { deviceId: "C1", page: 2 } }] } }] };
    const ws = openPanel();
    ws.fromPlugin({ event: "devices", devices: three });
    ws.fromPlugin({ event: "globalSettings", settings: saved, issues: [] });
    expect(byLabel<HTMLSelectElement>("Child device (override 1 of scope-1)").value).toBe("C1");
    select(byLabel("Child device (override 1 of scope-1)"), "C2");
    expect(status()).toBe("Unsaved changes.");
    $("save").click();
    const overrides = () => (ws.toPlugin("setGlobalSettings").at(-1)!.settings as { scopes: Array<{ mapping: { overrides: unknown[] } }> }).scopes[0].mapping.overrides;
    expect(overrides()).toEqual([{ a: { deviceId: "P", page: 1 }, b: { deviceId: "C2", page: 2 } }]);
    ws.fromPlugin({ event: "globalSettings", settings: { ...saved, scopes: [{ ...saved.scopes[0], mapping: { mode: "positional", overrides: overrides() } }] }, issues: [], id: lastSaveId(ws) });
    select(byLabel("Scope for Deck C2"), ""); // the override's child leaves the scope: the override goes with it
    expect(byLabel("Child device (override 1 of scope-1)")).toBeNull();
    expect(document.querySelector(".ds-scope summary")!.textContent).not.toContain("override");
    $("save").click();
    expect(overrides()).toEqual([]);
  });

  test("R12-F10 text the browser cannot parse (a bad input with a blank value) stays flagged across a re-render and blocks Save", () => {
    const ws = loadedPanel();
    const box = byLabel<HTMLInputElement>("Page count of Deck P");
    Object.defineProperty(box, "validity", { value: { badInput: true } }); // as Chromium reports "7e"
    setInput(box, "");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    ws.fromPlugin({ event: "devices", devices: [DEVICES[0], { ...DEVICES[1], isConnected: true }] }); // re-renders
    const again = byLabel<HTMLInputElement>("Page count of Deck P");
    expect(again.value).toBe("");
    expect(again.getAttribute("aria-invalid")).toBe("true");
    $("save").click();
    expect(status()).toBe("Fix the highlighted fields first: Page count of Deck P.");
    expect(ws.toPlugin("setGlobalSettings")).toHaveLength(0);
  });

  test("R12-F11 a new scope that reuses a removed scope's id is not shown collapsed", () => {
    loadedPanel();
    const section = document.querySelector<HTMLDetailsElement>("details.ds-scope")!;
    section.open = false;
    section.dispatchEvent(new Event("toggle"));
    byLabel<HTMLButtonElement>("Remove scope Scope 1").click();
    expect(document.querySelector("details.ds-scope")).toBeNull();
    $("addScope").click();
    const fresh = document.querySelector<HTMLDetailsElement>("details.ds-scope")!;
    expect(fresh.querySelector("summary")!.textContent).toContain("Scope 1");
    expect(fresh.open).toBe(true);
  });

  test("R13-F4 a load answered after a Save never reverts the panel to what it held before the Save", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "New");
    $("save").click();
    ws.fromPlugin({ event: "globalSettings", settings: { version: 2, scopes: [{ ...SAVED.scopes[0], name: "New" }] }, issues: [], id: lastSaveId(ws) });
    expect(status()).toBe("Saved.");
    ws.fromPlugin({ event: "globalSettings", settings: SAVED, issues: [] }); // the initial load's retry, answered late with the pre-save configuration
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("New");
    $("discard").click();
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("New");
  });

  test("R13-F5 making the child the parent keeps an override across the swap, normalised so the parent's page comes first", () => {
    const saved = { version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 4 } }] } }] };
    const ws = loadedPanel(saved);
    select(byLabel("Role of Deck C1 (disconnected)"), "parent");
    expect(document.querySelector(".ds-scope")!.textContent).not.toContain("no longer involve the parent");
    expect(byLabel<HTMLInputElement>("Parent page (override 1 of scope-1)").value).toBe("4"); // C1's page is the parent's page now
    expect(byLabel<HTMLInputElement>("Child page (override 1 of scope-1)").value).toBe("2");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ parentDeviceId: string; mapping: { overrides: unknown[] } }> };
    expect(sent.scopes[0].parentDeviceId).toBe("C1");
    expect(sent.scopes[0].mapping.overrides).toEqual([{ a: { deviceId: "C1", page: 4 }, b: { deviceId: "P", page: 2 } }]);
  });

  test("R13-F9 a confirmation that arrives while an invalid value is being typed keeps the text and its error", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "New");
    $("save").click();
    setInput(byLabel("Page count of Deck P"), "0"); // typing, still invalid, while the save is out
    ws.fromPlugin({ event: "globalSettings", settings: { version: 2, scopes: [{ ...SAVED.scopes[0], name: "New" }] }, issues: [], id: lastSaveId(ws) });
    expect(status()).toBe("Saved; you have further unsaved changes.");
    const pages = byLabel<HTMLInputElement>("Page count of Deck P");
    expect(pages.value).toBe("0");
    expect(pages.getAttribute("aria-invalid")).toBe("true");
  });

  test("R13-F10 Discard after a disconnect keeps the disconnect message", () => {
    const ws = loadedPanel();
    setInput(byLabel("Name of scope-1"), "Edited");
    ws.close();
    $("discard").click();
    expect(status()).toBe("Disconnected from Stream Deck — close and reopen this panel.");
    expect(byLabel<HTMLInputElement>("Name of scope-1").value).toBe("Scope 1");
  });

  test("R13-F11 the keyboard focus survives a device push on a scope summary, and a removal after a disconnect lands on an enabled control", () => {
    const ws = loadedPanel();
    const summary = document.querySelector<HTMLElement>("details.ds-scope summary")!;
    summary.setAttribute("tabindex", "0");
    summary.focus();
    expect(document.activeElement).toBe(summary);
    ws.fromPlugin({ event: "devices", devices: [DEVICES[0], { ...DEVICES[1], isConnected: true }] }); // re-renders
    expect(document.activeElement).toBe(document.querySelector("details.ds-scope summary"));
    ws.close();
    byLabel<HTMLButtonElement>("Remove scope Scope 1").click(); // its focus target, Add scope, is disabled now
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLButtonElement).disabled).toBeFalsy();
  });

  test("R6-F8/R13-F5 a rejected save leaves the override rows pointing at the right overrides across a role swap; an override with no parent left is kept for Discard", () => {
    const saved = { version: 2, scopes: [{ ...SAVED.scopes[0], mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 1 }, b: { deviceId: "C1", page: 2 } }] } }] };
    const ws = loadedPanel(saved);
    select(byLabel("Role of Deck C1 (disconnected)"), "parent"); // the pair now reads C1:2 ↔ P:1
    expect(byLabel<HTMLInputElement>("Parent page (override 1 of scope-1)").value).toBe("2");
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    byFocus<HTMLButtonElement>("addov:scope-1").click();
    setInput(byLabel("Parent page (override 2 of scope-1)"), "9"); // rows are numbered by their place in the draft
    setInput(byLabel("Child page (override 3 of scope-1)"), "3");
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ parentDeviceId: string; mapping: { overrides: unknown[] } }> };
    expect(sent.scopes[0].parentDeviceId).toBe("C1");
    expect(sent.scopes[0].mapping.overrides).toEqual([{ a: { deviceId: "C1", page: 2 }, b: { deviceId: "P", page: 1 } }, { a: { deviceId: "C1", page: 9 }, b: { deviceId: "P", page: 0 } }, { a: { deviceId: "C1", page: 0 }, b: { deviceId: "P", page: 3 } }]);
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "page 9 is beyond the page count" }], id: lastSaveId(ws) });
    expect(status()).toContain("Not saved");
    byLabel<HTMLButtonElement>("Remove override 2 of scope-1").click(); // the page-9 row
    expect(byLabel<HTMLInputElement>("Child page (override 3 of scope-1)")).toBeNull();
    expect(byLabel<HTMLInputElement>("Parent page (override 1 of scope-1)").value).toBe("2"); // the swapped pair is still first
    expect(byLabel<HTMLInputElement>("Parent page (override 2 of scope-1)").value).toBe("0"); // the other added row survived, renumbered
    expect(byLabel<HTMLInputElement>("Child page (override 2 of scope-1)").value).toBe("3");
    $("discard").click();
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("parent");
    expect(byLabel<HTMLInputElement>("Parent page (override 1 of scope-1)").value).toBe("1"); // back in the saved orientation
  });

  test("R6-F8 a pair that no longer involves the parent (a third device took the role) is hidden, counted, dropped on Save and kept for Discard", () => {
    const three = [...DEVICES, { id: "C2", name: "Deck C2", type: 2, isConnected: false }];
    const ws = openPanel();
    ws.fromPlugin({ event: "devices", devices: three });
    ws.fromPlugin({ event: "globalSettings", settings: { version: 2, scopes: [{ id: "scope-1", name: "Scope 1", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }, { deviceId: "C2", role: "child" }], mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 1 }, b: { deviceId: "C1", page: 2 } }] } }] }, issues: [] });
    select(byLabel("Role of Deck C2 (disconnected)"), "parent"); // neither side of the pair is the parent now
    expect($("setup").textContent).toContain("1 override(s) no longer involve the parent");
    expect(byLabel("Parent page (override 1 of scope-1)")).toBeNull();
    $("save").click();
    const sent = ws.toPlugin("setGlobalSettings")[0].settings as { scopes: Array<{ mapping: { overrides: unknown[] } }> };
    expect(sent.scopes[0].mapping.overrides).toEqual([]);
    ws.fromPlugin({ event: "globalSettingsRejected", issues: [{ message: "x" }], id: lastSaveId(ws) });
    $("discard").click();
    expect(byLabel<HTMLSelectElement>("Role of Deck P").value).toBe("parent");
    expect(byLabel<HTMLInputElement>("Parent page (override 1 of scope-1)").value).toBe("1");
  });
  test("R6-F15 the page-count and override-page validators flag bad values with their messages and block Save until fixed", () => {
    const ws = loadedPanel();
    setInput(byLabel("Page count of Deck P"), "0");
    expect(byLabel("Page count of Deck P").getAttribute("aria-invalid")).toBe("true");
    expect(status()).toBe("Pages must be a whole number, 1 or more.");
    $("save").click();
    expect(status()).toMatch(/^Fix the highlighted fields first: /);
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
