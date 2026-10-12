/**
 * PRD §7.3 AC [agent] (a)–(e), §7.6 logging, the edge cases from the engine
 * design (E-numbers; E4 was folded into the mapping tests and E19 into E2),
 * and the review findings (R<round>-F<n>), against the pure SyncEngine with
 * fake SDK dependencies.
 *
 * Fixture scope "desk": P (parent, Stream Deck +, profiles/plus), C1 (child,
 * Mini → profiles/mini), C2 (child, XL → profiles/xl); override P:2 ↔ C1:4,
 * so C1's page 2 and P's page 4 have no counterpart.
 */
import { SyncEngine, type DeviceInfo, type EngineOptions, type Outcome } from "../syncEngine";
import { GLOBAL_SETTINGS_VERSION, type GlobalSettings, type Scope } from "../settings";

class FakeSwitcher {
  calls: Array<{ deviceId: string; profile: string; page: number }> = [];
  private failing = new Map<string, { err: Error; once: boolean }>();
  private deferring = new Set<string>();
  private deferred: Array<{ reject: (err: Error) => void }> = [];
  private throwSync = false;
  failFor(deviceId: string, err: Error, once = false) { this.failing.set(deviceId, { err, once }); }
  /** Switches to this device stay pending until rejectDeferred() is called. */
  deferFor(deviceId: string) { this.deferring.add(deviceId); }
  rejectDeferred(err: Error) { for (const d of this.deferred.splice(0)) d.reject(err); }
  /** Switches to this device resolve again. */
  undefer(deviceId: string) { this.deferring.delete(deviceId); }
  throwSynchronously() { this.throwSync = true; }
  switchToProfile = (deviceId: string, profile: string, page: number): Promise<void> => {
    if (this.throwSync) throw new Error("switcher exploded");
    this.calls.push({ deviceId, profile, page });
    const f = this.failing.get(deviceId);
    if (f) {
      if (f.once) this.failing.delete(deviceId);
      return Promise.reject(f.err);
    }
    if (this.deferring.has(deviceId)) return new Promise<void>((_, reject) => this.deferred.push({ reject }));
    return Promise.resolve();
  };
}

class FakeClock {
  t = 1_000;
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

class MemoryLog {
  lines: Array<{ level: string; msg: string }> = [];
  debug = (msg: string) => { this.lines.push({ level: "debug", msg }); };
  info = (msg: string) => { this.lines.push({ level: "info", msg }); };
  warn = (msg: string) => { this.lines.push({ level: "warn", msg }); };
  error = (msg: string) => { this.lines.push({ level: "error", msg }); };
  find(level: string, re: RegExp) { return this.lines.filter((l) => l.level === level && re.test(l.msg)); }
}

class FakeDevices {
  map = new Map<string, DeviceInfo>();
  throwOnGet = false;
  set(id: string, type: number, isConnected = true) { this.map.set(id, { id, name: `Deck ${id}`, type, isConnected }); }
  connect(id: string, isConnected: boolean) { this.map.get(id)!.isConnected = isConnected; }
  list = () => [...this.map.values()];
  get = (id: string) => { if (this.throwOnGet) throw new Error("directory offline"); return this.map.get(id); };
}

const deskScope = (patch: Partial<Scope> = {}): Scope => ({
  id: "desk",
  name: "Desk",
  parentDeviceId: "P",
  members: [
    { deviceId: "P", role: "parent", profile: "profiles/plus" },
    { deviceId: "C1", role: "child" },
    { deviceId: "C2", role: "child" },
  ],
  mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 4 } }] },
  ...patch,
});

const settingsWith = (...scopes: Scope[]): GlobalSettings => ({ version: GLOBAL_SETTINGS_VERSION, scopes });

type AppearOpts = { actionId?: string; enabled?: boolean; multi?: boolean };

function harness(scope: Scope | Scope[] = deskScope(), options: EngineOptions = {}) {
  const sw = new FakeSwitcher();
  const clock = new FakeClock();
  const log = new MemoryLog();
  const devices = new FakeDevices();
  devices.set("P", 7);
  devices.set("C1", 1);
  devices.set("C2", 2);
  const settings = settingsWith(...(Array.isArray(scope) ? scope : [scope]));
  const engine = new SyncEngine({ switcher: sw, clock, log, devices }, options);
  /** The page each simulated deck physically shows — kept apart from the engine's belief, so a stale belief cannot hide. */
  const physical: Record<string, number | null> = {};
  const appear = (dev: string, page: number | undefined, o: AppearOpts = {}) => {
    if (page !== undefined && !o.multi) physical[dev] = page;
    return engine.onAppear({ deviceId: dev, actionId: o.actionId ?? `${dev}-p${page}`, pageIndex: page, enabled: o.enabled ?? true, isInMultiAction: o.multi ?? false });
  };
  const leave = (dev: string, page: number, o: AppearOpts = {}) => {
    if (physical[dev] === page) physical[dev] = null;
    engine.onDisappear({ deviceId: dev, actionId: o.actionId ?? `${dev}-p${page}`, pageIndex: page, isInMultiAction: o.multi ?? false });
  };
  const state = (dev: string) => engine.snapshot().devices.find((d) => d.id === dev)!;
  const pendingPages = (dev: string) => state(dev).pending.map((p) => p.page);
  const page = (dev: string) => state(dev).lastKnownPage;
  /** Start and replay the launch burst: everyone on page 0, nothing issued. */
  const boot = async (ids = ["P", "C1", "C2"]) => {
    await engine.start(settings);
    for (const id of ids) expect((await appear(id, 0)).classification).toBe("STARTUP");
    expect(sw.calls).toEqual([]);
  };
  /** Human navigation: leave the page the deck physically shows, then appear on the new one. */
  const nav = async (dev: string, to: number, o: AppearOpts = {}) => {
    const from = physical[dev] ?? null;
    if (from !== null) leave(dev, from);
    return appear(dev, to, o);
  };
  /** Human navigation as an app that reports the new page before the old page's disappear would. */
  const navAppearFirst = async (dev: string, to: number, o: AppearOpts = {}) => {
    const from = physical[dev] ?? null;
    const out = await appear(dev, to, o);
    if (from !== null) leave(dev, from);
    return out;
  };
  const cls = async (p: Promise<Outcome>) => (await p).classification;
  const call = (deviceId: string, profile: string, page: number) => ({ deviceId, profile, page });
  return { engine, sw, clock, log, devices, settings, appear, leave, nav, navAppearFirst, boot, state, pendingPages, page, physical, cls, call };
}

describe("PRD §7.3 acceptance criteria", () => {
  test("(a) a plugin-issued arrival produces no outbound switch", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.nav("P", 1))).toBe("SEND");
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1)]);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 1))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(2);
    expect(h.pendingPages("C1")).toEqual([]);
    expect(h.pendingPages("C2")).toEqual([]);
    expect(h.log.find("info", /^RECEIVE dev=C1 page=1 seq=1 origin=P/)).toHaveLength(1);
  });

  test("(b) a human arrival fans out to the correct mapped pages", async () => {
    const h = harness();
    await h.boot();
    const out = await h.nav("P", 2);
    expect(out.classification).toBe("SEND");
    expect(out.issued).toEqual([
      { deviceId: "C1", profile: "profiles/mini", page: 4, seq: 1 },
      { deviceId: "C2", profile: "profiles/xl", page: 2, seq: 1 },
    ]);
    expect(h.log.find("info", /^SEND dev=P role=parent scope=desk page=2 canonical=2 seq=1 targets=\[C1→profiles\/mini#4, C2→profiles\/xl#2\]$/)).toHaveLength(1);
    expect(await h.cls(h.appear("C1", 4))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 2))).toBe("RECEIVE");
    // the child leads back: C1 page 1 → parent 1, C2 1
    expect(await h.cls(h.nav("C1", 1))).toBe("SEND");
    expect(h.sw.calls.slice(2)).toEqual([h.call("P", "profiles/plus", 1), h.call("C2", "profiles/xl", 1)]);
  });

  test("(c) a parent change overrides an in-flight child change", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND"); // seq 1 → P#3, C2#3 (not landed yet)
    expect(h.sw.calls).toEqual([h.call("P", "profiles/plus", 3), h.call("C2", "profiles/xl", 3)]);
    const out = await h.nav("P", 1); // the parent flips before the child's switch lands
    expect(out.classification).toBe("SEND"); // never suppressed
    expect(h.sw.calls.slice(2)).toEqual([h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1)]);
    // the child's switch lands on the parent after the parent's own send: swallowed and undone
    const stale = await h.appear("P", 3);
    expect(stale).toMatchObject({ classification: "RECEIVE_STALE", seq: 1 });
    expect(h.sw.calls[4]).toEqual(h.call("P", "profiles/plus", 1));
    for (const [dev, pg] of [["P", 1], ["C1", 1], ["C2", 3], ["C2", 1]] as const) {
      expect(await h.cls(h.appear(dev, pg))).toBe("RECEIVE");
    }
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
    expect(h.sw.calls).toHaveLength(5);
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("(d) startup appears are suppressed", async () => {
    const h = harness();
    await h.engine.start(h.settings);
    expect(await h.cls(h.appear("P", 2, { actionId: "a" }))).toBe("STARTUP");
    expect((await h.appear("P", 2, { actionId: "b" })).reason).toBe("duplicate");
    expect(await h.cls(h.appear("C1", 0))).toBe("STARTUP");
    expect(await h.cls(h.appear("C2", 4))).toBe("STARTUP");
    expect(h.sw.calls).toEqual([]);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([2, 0, 4]);
    expect(h.engine.snapshot().devices.every((d) => d.armed)).toBe(true);
    expect(h.log.find("info", /^STARTUP dev=P page=2/)).toHaveLength(1);
  });

  test("(e) disabled markers don't SEND (but still consume echoes)", async () => {
    const h = harness();
    await h.boot();
    const out = await h.nav("P", 2, { enabled: false });
    expect(out).toMatchObject({ classification: "IGNORED", reason: "disabled" });
    expect(h.sw.calls).toEqual([]);
    expect(h.page("P")).toBe(2);
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND");
    expect(await h.cls(h.appear("P", 3, { enabled: false }))).toBe("RECEIVE");
  });
});

describe("edge cases", () => {
  test("E1 echo matching is by (device, page); the profile is never compared", async () => {
    const h = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child", profile: "profiles/xl" }, { deviceId: "C2", role: "child" }] }));
    await h.boot();
    await h.nav("P", 1);
    expect(h.sw.calls[0]).toEqual(h.call("C1", "profiles/xl", 1));
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
  });

  test("E2 a target already on the mapped page gets no switch, so nothing dangles", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C2", 1); // P#1, C1#1
    await h.appear("P", 1);
    await h.appear("C1", 1);
    h.leave("P", 1);
    const out = await h.appear("P", 1); // left page 1 and came straight back: a human navigation
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "already-there" }, { deviceId: "C2", reason: "already-there" }]);
    expect(h.sw.calls).toHaveLength(2);
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("E2/E19 an unconfirmed switch expires with a warning, stays an echo tag, and is dropped after the grace period", async () => {
    const h = harness();
    await h.boot();
    h.leave("C1", 0); // C1's page is now unknown (e.g. it sits on an un-anchored page)
    await h.nav("P", 3); // C1#3 issued because its page is unknown
    expect(h.pendingPages("C1")).toEqual([3]);
    await h.appear("C2", 3);
    h.clock.advance(3000);
    await h.nav("P", 1); // ages C1's entries during fan-out planning: at exactly the TTL the entry is still expected
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[3, false], [1, false]]);
    expect(h.log.find("warn", /SWITCH unconfirmed/)).toHaveLength(0);
    h.clock.advance(1);
    await h.nav("P", 2); // one ms later the first entry has expired; C1#4 (override) joins the queue
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[3, "ttl"], [1, false], [4, false]]);
    expect(h.log.find("warn", /^SWITCH unconfirmed dev=C1 profile=profiles\/mini page=3 seq=1 origin=P — no appear within 3000ms/)).toHaveLength(1);
    h.clock.advance(31000);
    const out = await h.appear("C1", 2); // a human navigation after the grace: the old tags are gone
    expect(out.classification).toBe("SEND");
    expect(h.pendingPages("C1")).toEqual([]);
    for (const [pg, seq] of [[3, 1], [1, 2], [4, 3]]) expect(h.log.find("debug", new RegExp(`^GC dev=C1 page=${pg} seq=${seq} reason=grace-elapsed`))).toHaveLength(1);
  });

  test("E3 several anchors on one page produce one SEND and consume one echo", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.nav("P", 2, { actionId: "a" }))).toBe("SEND");
    expect((await h.appear("P", 2, { actionId: "b" })).reason).toBe("duplicate");
    expect(h.sw.calls).toHaveLength(2);
    expect(await h.cls(h.appear("C1", 4, { actionId: "x" }))).toBe("RECEIVE");
    expect((await h.appear("C1", 4, { actionId: "y" })).reason).toBe("duplicate");
    expect(h.sw.calls).toHaveLength(2);
  });

  test("E5 a reconnecting device's appears are startup; its pending switches are dropped", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1);
    expect(h.pendingPages("C1")).toEqual([1]);
    h.engine.onDeviceDisconnected("C1");
    expect(h.pendingPages("C1")).toEqual([]);
    h.engine.onDeviceConnected("C1");
    expect(await h.cls(h.appear("C1", 1))).toBe("STARTUP");
    expect(h.sw.calls).toHaveLength(2);
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND");
  });

  test("E6 rapid parent flips: children land in order, or coalesce, without ping-pong", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1);
    await h.nav("P", 3);
    expect(h.pendingPages("C1")).toEqual([1, 3]);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C1", 3))).toBe("RECEIVE");
    // C2 shows only the last page: the earlier entry is superseded, kept as a tag only
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect(h.state("C2").pending.map((p) => [p.page, p.expired])).toEqual([[1, "superseded"]]);
    expect(h.log.find("debug", /^GC dev=C2 page=1 seq=1 reason=superseded by seq=2/)).toHaveLength(1);
    expect(h.sw.calls.filter((c) => c.deviceId === "P")).toEqual([]);
  });

  test("E6' parent 1→3→1: the switch back is not skipped as already-there", async () => {
    const h = harness();
    await h.boot();
    for (const to of [1, 3, 1]) await h.nav("P", to);
    expect(h.sw.calls.filter((c) => c.deviceId === "C1").map((c) => c.page)).toEqual([1, 3, 1]);
    for (const pg of [1, 3, 1]) expect(await h.cls(h.appear("C1", pg))).toBe("RECEIVE");
    expect(h.page("C1")).toBe(1);
  });

  test("E7 a child flip while the parent's switch to it is in flight is suppressed; the parent's switch lands", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2); // C1#4 pending, origin parent
    const out = await h.nav("C1", 1);
    expect(out).toMatchObject({ classification: "SUPPRESSED", reason: "parent-in-flight" });
    expect(h.sw.calls).toHaveLength(2);
    expect(h.state("C1").lastHumanSeq).toBe(0); // a suppressed navigation is discarded, not recorded
    expect(h.log.find("info", /^SUPPRESSED dev=C1 page=1 scope=desk reason=parent-in-flight pending=\[page=4 seq=1\]/)).toHaveLength(1);
    expect(await h.cls(h.appear("C1", 4))).toBe("RECEIVE");
    expect(h.page("C1")).toBe(4);
  });

  test("E7' once the parent's switch has landed, the child may lead again", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2);
    await h.appear("C1", 4);
    expect(await h.cls(h.nav("C1", 1))).toBe("SEND");
    expect(h.sw.calls.slice(2)).toEqual([h.call("P", "profiles/plus", 1), h.call("C2", "profiles/xl", 1)]);
  });

  test("E8 a child SEND drives the parent and the other children (peer follow)", async () => {
    const h = harness();
    await h.boot();
    const out = await h.nav("C1", 3);
    expect(out.classification).toBe("SEND");
    expect(h.sw.calls).toEqual([h.call("P", "profiles/plus", 3), h.call("C2", "profiles/xl", 3)]);
    expect(h.state("P").pending[0]).toMatchObject({ originId: "C1", originRole: "child" });
    expect(await h.cls(h.appear("P", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(2);
  });

  test("E9 a rejected switch is logged at warn, its entry removed, and nothing throws", async () => {
    const h = harness();
    await h.boot();
    h.sw.failFor("C1", new Error("device not found"));
    const out = await h.nav("P", 2);
    expect(out.classification).toBe("SEND");
    expect(h.pendingPages("C1")).toEqual([]);
    expect(h.pendingPages("C2")).toEqual([2]);
    expect(h.log.find("warn", /^SWITCH failed dev=C1 profile=profiles\/mini page=4 seq=1 origin=P error="device not found"/)).toHaveLength(1);
    // a later human navigation of C1 to that page is not swallowed
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND");
  });

  test("E10/F4 a settings change keeps in-flight switches as echo tags: their landings never become sends", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2); // C1#4, C2#2 pending
    h.engine.onSettingsChanged(JSON.parse(JSON.stringify(h.settings))); // a reload that changes nothing (the PI opened) keeps state
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 4, expired: false })]);
    expect(h.log.find("debug", /^SETTINGS unchanged/)).toHaveLength(1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk 2" })));
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 4, expired: "detached" })]);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([2, 0, 0]);
    expect(h.engine.snapshot().devices.every((d) => d.armed)).toBe(true);
    expect(h.log.find("info", /^SETTINGS applied \(update\) scopes=\[desk\{parent=P,children=2,overrides=1\}\] detachedPending=2$/)).toHaveLength(1);
    expect(await h.appear("C1", 4)).toMatchObject({ classification: "RECEIVE", late: false, issued: [] });
    expect(h.log.find("info", /^RECEIVE dev=C1 page=4 seq=1 origin=P scope=desk detached=true/)).toHaveLength(1);
    expect(await h.cls(h.appear("C2", 2))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(2);
    // a detached parent-origin entry no longer suppresses the child
    expect(await h.cls(h.nav("C1", 1))).toBe("SEND");
  });

  test("E11 a disabled anchor consumes its echo and records the page, but never sends", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2);
    expect(await h.cls(h.appear("C1", 4, { enabled: false }))).toBe("RECEIVE");
    expect(h.page("C1")).toBe(4);
    expect((await h.nav("C1", 3, { enabled: false })).reason).toBe("disabled");
    expect(h.page("C1")).toBe(3);
    expect(h.sw.calls).toHaveLength(2);
  });

  test("E12 an anchor without a page index warns once and changes nothing", async () => {
    const h = harness();
    await h.engine.start(h.settings);
    for (let i = 0; i < 3; i++) expect((await h.appear("P", undefined, { actionId: "z" })).reason).toBe("no-page-index");
    expect(h.log.find("warn", /reason=no-page-index/)).toHaveLength(1);
    expect(h.log.find("warn", /action=z/)).toHaveLength(1);
    expect(h.state("P").armed).toBe(false);
    expect(h.sw.calls).toEqual([]);
  });

  test("E13 a device in no scope is armed and tracked, logs once, and never sends; it works once added", async () => {
    const h = harness();
    h.devices.set("X", 0);
    await h.boot();
    expect(await h.cls(h.appear("X", 1))).toBe("STARTUP");
    expect((await h.nav("X", 2)).reason).toBe("no-scope");
    expect((await h.nav("X", 3)).reason).toBe("no-scope");
    expect(h.log.find("warn", /^IGNORED dev=X .*reason=no-scope/)).toHaveLength(1); // PRD §7.6: recoverable → warn, once
    expect(h.log.find("debug", /^IGNORED dev=X .*reason=no-scope/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([]);
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk 2" }))); // a new configuration that still leaves X out
    expect((await h.nav("X", 4)).reason).toBe("no-scope");
    expect(h.log.find("warn", /^IGNORED dev=X .*reason=no-scope/)).toHaveLength(2); // warned again for the new configuration
    const scope = deskScope();
    scope.members.push({ deviceId: "X", role: "child" });
    h.engine.onSettingsChanged(settingsWith(scope));
    expect(await h.cls(h.nav("X", 1))).toBe("SEND");
    expect(h.sw.calls.map((c) => c.deviceId)).toEqual(["P", "C1", "C2"]);
  });

  test("E14 no switch is issued toward a page the configuration says does not exist or is reserved", async () => {
    const h = harness(deskScope({
      members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }, { deviceId: "C2", role: "child", pageCount: 3 }],
      mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 0 } }] },
    }));
    await h.boot();
    let out = await h.nav("P", 4); // C2 has only 3 pages
    expect(out.skipped).toEqual([{ deviceId: "C2", reason: "no-counterpart" }]);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 4)]);
    expect(h.log.find("info", /^SKIP target=C2 seq=1 reason=no-counterpart/)).toHaveLength(1);
    await h.appear("C1", 4);
    out = await h.nav("P", 0); // C1's page 0 is reserved for parent page 2
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "no-counterpart" }, { deviceId: "C2", reason: "already-there" }]);
    out = await h.nav("C1", 2); // parent page 2 is reserved for C1's page 0: no canonical page
    expect(out.classification).toBe("SEND");
    expect(out.issued).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["no-counterpart", "no-counterpart"]);
    expect(h.log.find("info", /^SEND dev=C1 role=child scope=desk page=2 canonical=none seq=3 targets=\[\]/)).toHaveLength(1);
  });

  test("E15 a peer's stale switch landing after this device's own send is swallowed and the page restored", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C2", 3); // seq 1: P#3, C1#3 (origin child)
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND"); // seq 2: P#2, C2#2 (C1:4 is canonical page 2)
    expect(h.pendingPages("C1")).toEqual([3]);
    const out = await h.appear("C1", 3); // the stale switch lands
    expect(out).toMatchObject({ classification: "RECEIVE_STALE", seq: 1 });
    expect(h.sw.calls[h.sw.calls.length - 1]).toEqual(h.call("C1", "profiles/mini", 4));
    expect(h.log.find("info", /^RECEIVE_STALE dev=C1 page=3 seq=1 origin=C2 scope=desk landed after this device's own navigation seq=2; restoring page=4 seq=3$/)).toHaveLength(1);
    expect(await h.cls(h.appear("C1", 4))).toBe("RECEIVE");
    expect(await h.cls(h.appear("P", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("P", 2))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 2))).toBe("RECEIVE");
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([2, 4, 2]); // all on canonical page 2
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("E16 cross-fire, parent first: the child is suppressed and everyone ends on the parent's page", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.nav("P", 1))).toBe("SEND");
    expect(await h.cls(h.nav("C1", 2))).toBe("SUPPRESSED");
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 1))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(2);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
  });

  test("E16 cross-fire, child first: the parent is never suppressed and everyone ends on the parent's page", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND"); // seq 1: P#3, C2#3
    expect(await h.cls(h.nav("P", 1))).toBe("SEND"); // seq 2: C1#1, C2#1
    expect(await h.appear("P", 3)).toMatchObject({ classification: "RECEIVE_STALE", seq: 1 }); // the child's switch lands late → restore P#1
    expect(h.sw.calls).toEqual([
      h.call("P", "profiles/plus", 3),
      h.call("C2", "profiles/xl", 3),
      h.call("C1", "profiles/mini", 1),
      h.call("C2", "profiles/xl", 1),
      h.call("P", "profiles/plus", 1),
    ]);
    for (const [dev, pg] of [["P", 1], ["C1", 1], ["C2", 3], ["C2", 1]] as const) {
      expect(await h.cls(h.appear(dev, pg))).toBe("RECEIVE");
    }
    expect(h.sw.calls).toHaveLength(5);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("E17 the source of a SEND only records its own page and send", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2);
    expect(h.state("P")).toMatchObject({ lastKnownPage: 2, pending: [], lastHumanSeq: 1, lastHumanPage: 2 });
    expect(h.sw.calls.some((c) => c.deviceId === "P")).toBe(false);
  });

  test("E18 a disconnected parent is skipped with a warning; connected children still follow", async () => {
    const h = harness();
    h.devices.connect("P", false);
    await h.boot(["C1", "C2"]);
    const out = await h.nav("C1", 3);
    expect(out.skipped).toEqual([{ deviceId: "P", reason: "disconnected" }]);
    expect(h.sw.calls).toEqual([h.call("C2", "profiles/xl", 3)]);
    expect(h.log.find("warn", /^SKIP target=P seq=1 reason=disconnected — .*remove it from scope "Desk"$/)).toHaveLength(1);
    h.devices.connect("P", true);
    h.engine.onDeviceConnected("P");
    expect(await h.cls(h.appear("P", 0))).toBe("STARTUP");
    expect(h.sw.calls).toHaveLength(1);
  });

  test("E20 anchors inside multi-actions are ignored without touching state", async () => {
    const h = harness();
    await h.boot();
    const before = h.engine.snapshot();
    expect((await h.appear("P", 2, { multi: true })).reason).toBe("multi-action");
    h.leave("P", 0, { multi: true });
    expect(h.engine.snapshot()).toEqual(before);
    expect(h.sw.calls).toEqual([]);
  });

  test("a child with no default profile for its device type is skipped with a warning", async () => {
    const h = harness();
    h.devices.set("C2", 10); // Studio: no default profile
    await h.boot();
    const out = await h.nav("P", 1);
    expect(out.skipped).toEqual([{ deviceId: "C2", reason: "no-profile" }]);
    expect(h.log.find("warn", /^SKIP target=C2 seq=1 reason=no-profile/)).toHaveLength(1);
  });

  test("an unknown device appearing is created un-armed (startup)", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.appear("Z", 0))).toBe("STARTUP");
  });

  test("a switcher that throws synchronously never breaks the handler", async () => {
    const h = harness();
    await h.boot();
    h.sw.throwSynchronously();
    const out = await h.nav("P", 1);
    expect(out.classification).toBe("SEND");
    expect(h.log.find("warn", /^SWITCH failed .*error="switcher exploded"/)).toHaveLength(2);
    for (const dev of ["C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("pending entries exist synchronously, before any switch resolves", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    const p = h.appear("P", 1);
    expect(h.pendingPages("C1")).toEqual([1]);
    await p;
  });
});

describe("review findings", () => {
  test("F1a a late echo (after the TTL) is still a RECEIVE and never re-fans out", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C1", 3); // P#3, C2#3
    h.clock.advance(2000);
    await h.nav("C1", 1); // P#1, C2#1 — the human moved on
    h.clock.advance(1100);
    const late = await h.appear("P", 3); // P's echo of page 3 arrives 3.1 s after it was issued
    expect(late).toMatchObject({ classification: "RECEIVE", late: true, issued: [] });
    expect(h.sw.calls).toHaveLength(4);
    expect(await h.cls(h.appear("P", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 1))).toBe("RECEIVE");
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
    expect(h.log.find("info", /^RECEIVE dev=P page=3 seq=1 origin=C1 scope=desk late=true/)).toHaveLength(1);
  });

  test("F1b a switch that stalls past the TTL and lands after the parent's own flip is absorbed, never rebroadcast, and not fought", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C1", 1); // P#1, C2#1
    h.clock.advance(4000); // the app stalls on P
    expect(await h.cls(h.nav("P", 3))).toBe("SEND"); // C1#3, C2#3
    expect(h.sw.calls).toHaveLength(4);
    // The stalled switch lands: a late match is indistinguishable from the human flipping back to 1,
    // so it is a plain RECEIVE — no restore, no fan-out. The next human flip re-syncs the scope.
    expect(await h.appear("P", 1)).toMatchObject({ classification: "RECEIVE", late: true, issued: [] });
    expect(h.sw.calls).toHaveLength(4);
    expect(await h.cls(h.appear("C1", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect(await h.cls(h.nav("P", 3))).toBe("SEND");
    expect(h.sw.calls).toHaveLength(4); // everyone else is already there
  });

  test("R2-F1 a dangling expired tag plus a later human navigation never reverts the human's flip", async () => {
    const h = harness();
    await h.boot();
    for (const to of [1, 3, 0]) await h.nav("P", to); // the app coalesces on C2: it stays on 0, tags [1,3,0] dangle
    expect(h.pendingPages("C2")).toEqual([1, 3, 0]);
    h.clock.advance(3001);
    expect(await h.cls(h.nav("C2", 2))).toBe("SEND");
    const calls = h.sw.calls.length;
    const out = await h.nav("C2", 3); // the human flips to a tagged page: swallowed once, never fought
    expect(out).toMatchObject({ classification: "RECEIVE", late: true, issued: [] });
    expect(h.sw.calls).toHaveLength(calls);
    expect(h.page("C2")).toBe(3);
    expect(h.state("C2").pending.map((p) => [p.page, p.expired])).toEqual([[1, "superseded"], [0, "ttl"]]); // the older tag lives one more TTL (a stalled app may still apply it)
    h.clock.advance(3001);
    expect(await h.cls(h.nav("C2", 1))).toBe("SEND"); // and the next flip syncs again
  });

  test("R2-F4 a stale landing is a plain RECEIVE when a later switch is already heading for the device", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C2", 3); // seq 1: P#3, C1#3 (child origin)
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND"); // seq 2: P#2, C2#2 — before C1#3 lands
    expect(await h.cls(h.nav("P", 1))).toBe("SEND"); // seq 3: C1#1, C2#1 — the parent decides
    expect(await h.appear("C1", 3)).toMatchObject({ classification: "RECEIVE", issued: [] }); // not restored: the parent's switch is coming
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    // the parent itself: C2's stale switch lands after its own navigation with nothing later coming → restored to 1
    expect(await h.appear("P", 3)).toMatchObject({ classification: "RECEIVE_STALE", issued: [{ deviceId: "P", profile: "profiles/plus", page: 1, seq: 4 }] });
    for (const [dev, pg] of [["P", 2], ["P", 1], ["C2", 2], ["C2", 1]] as const) expect(await h.cls(h.appear(dev, pg))).toBe("RECEIVE");
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("R2-F5 a stale landing restores the human's last page, even one with a disabled marker", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C2", 3); // seq 1: P#3, C1#3
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND"); // seq 2
    expect((await h.nav("C1", 0, { enabled: false })).reason).toBe("disabled"); // the human moved on to page 0
    const out = await h.appear("C1", 3); // the lagging switch lands
    expect(out).toMatchObject({ classification: "RECEIVE_STALE", seq: 1 });
    expect(h.sw.calls[h.sw.calls.length - 1]).toEqual(h.call("C1", "profiles/mini", 0));
    expect(await h.cls(h.appear("C1", 0))).toBe("RECEIVE");
  });

  test("R2-F3 a reconnect whose appears arrive before the connect event does not drop the first flip", async () => {
    const h = harness();
    await h.boot();
    h.engine.onDeviceDisconnected("C1");
    expect(await h.cls(h.appear("C1", 0))).toBe("STARTUP"); // the burst comes first
    h.engine.onDeviceConnected("C1"); // then the connect event
    expect(h.state("C1").armed).toBe(true);
    expect(await h.cls(h.nav("C1", 2))).toBe("SEND");
  });

  /**
   * A scope where copied anchors carry wrong page indices, plus a simulated app: either
   * appear/disappear order, the copied anchor reporting before or after the page's own, two or
   * three decks. Every anchor on the page being left disappears, as it would on a real deck.
   */
  function strayAnchorRig(hopMs: number, { appearFirst = false, threeDecks = false, copyFirst = false, strays = undefined as Record<string, Record<number, number>> | undefined } = {}) {
    const members: Scope["members"] = [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }];
    if (threeDecks) members.push({ deviceId: "C2", role: "child" });
    const h = harness(deskScope({ members, mapping: { mode: "positional", overrides: [] } }));
    // By default: P page 2 also says 1, P page 3 also says 4, C1 page 1 also says 3, C1 page 4 also says 2 (and C2 page 3 also says 1).
    strays ??= { P: { 2: 1, 3: 4 }, C1: { 1: 3, 4: 2 }, C2: { 3: 1 } };
    const current: Record<string, number> = { P: 0, C1: 0, C2: 0 };
    const shown: Record<string, Array<[number, string]>> = { P: [[0, "P-p0"]], C1: [[0, "C1-p0"]], C2: [[0, "C2-p0"]] };
    let applied = 0;
    const drain = async (max = 400) => {
      while (applied < h.sw.calls.length && applied < max) {
        const { deviceId, page } = h.sw.calls[applied++];
        h.clock.advance(hopMs);
        const leaving = shown[deviceId];
        const stray = strays[deviceId][page];
        const anchors: Array<[number, string]> = [[page, `${deviceId}-p${page}`]];
        if (stray !== undefined) anchors[copyFirst ? "unshift" : "push"]([stray, `${deviceId}-stray-on-${page}`]);
        const leaveAll = () => { for (const [idx, actionId] of leaving) h.leave(deviceId, idx, { actionId }); };
        if (!appearFirst) leaveAll();
        current[deviceId] = page;
        shown[deviceId] = anchors;
        for (const [idx, actionId] of anchors) await h.appear(deviceId, idx, { actionId });
        if (appearFirst) leaveAll();
      }
    };
    /** The person flips a deck by hand: every anchor on the old page leaves, the new page's anchors appear. */
    const flip = async (deviceId: string, page: number) => {
      for (const [idx, actionId] of shown[deviceId]) h.leave(deviceId, idx, { actionId });
      current[deviceId] = page;
      const stray = strays[deviceId][page];
      shown[deviceId] = [[page, `${deviceId}-p${page}`], ...(stray !== undefined ? [[stray, `${deviceId}-stray-on-${page}`] as [number, string]] : [])];
      const outs = [];
      for (const [idx, actionId] of shown[deviceId]) outs.push(await h.appear(deviceId, idx, { actionId }));
      return outs;
    };
    return { h, current, drain, flip };
  }

  test.each([
    [false, false, false], [true, false, false], [false, true, false], [true, true, false],
    [false, false, true], [true, false, true], [false, true, true], [true, true, true],
  ])("R2-F2/R3-F2/R4-F3/R7-F1/R8-F1 stray anchors cannot drive decks forever, however slow the app (appear first: %s, three decks: %s, copy reports first: %s)", async (appearFirst, threeDecks, copyFirst) => {
    // Hops well past the TTL included. A backlog that outgrows the grace period (three decks queue two switches
    // per send, so at 5 s per switch the tags of a long backlog are dropped before they land) is out of scope by design.
    for (const hopMs of threeDecks ? [50, 300, 1000, 1300, 3000] : [50, 300, 1000, 1300, 3000, 5000]) {
      const { h, flip, drain } = strayAnchorRig(hopMs, { appearFirst, threeDecks, copyFirst });
      await h.boot(threeDecks ? ["P", "C1", "C2"] : ["P", "C1"]);
      await flip("P", 1); // one human flip
      await drain();
      expect(h.sw.calls.length).toBeLessThan(threeDecks ? 100 : 60); // the decks come to rest
      const trips = h.log.find("warn", /reason=conflicting-anchors/);
      if (h.sw.calls.length > 6) {
        // The cycle ran and the breaker cut it (with the copy reporting first on this rig, parent precedence
        // suppresses the child's copied anchor while the parent's switch is landing, so it never starts).
        expect(trips.length).toBeGreaterThan(0);
        expect(trips[0].msg).toMatch(/conflicts in a row \(pages reporting two page indices\).*a Page Anchor on this device's pages carries the wrong page index/);
      }
    }
  });

  test.each([false, true])("R8-F1 pages 1 and 2 of both decks carrying each other's copied anchor, copy reporting first, cannot loop (appear first: %s)", async (appearFirst) => {
    for (const hopMs of [50, 500, 2000, 5000]) {
      const strays = { P: { 1: 2, 2: 1 }, C1: { 1: 2, 2: 1 }, C2: {} };
      const { h, flip, drain } = strayAnchorRig(hopMs, { appearFirst, copyFirst: true, strays });
      await h.boot(["P", "C1"]);
      const outs = await flip("P", 1); // one human flip: the copied anchor sends first, then the page's own
      expect(outs.map((o) => o.classification)).toEqual(["SEND", "SEND"]);
      await drain();
      expect(h.sw.calls.length).toBeLessThan(60); // the decks come to rest
      // With appears reported first, the copy's index equals the page just left and reads as a duplicate, so the
      // cycle dies on its own; with disappears first it runs until the breaker cuts it.
      if (h.sw.calls.length > 12) expect(h.log.find("warn", /reason=conflicting-anchors/).length).toBeGreaterThan(0);
    }
  });

  test("R3-F2 rapid human flipping never trips the breaker", async () => {
    const h = harness();
    await h.boot();
    for (const to of [1, 2, 3, 4, 3, 2, 1, 2, 3, 4]) {
      h.clock.advance(150); // ~7 presses per second
      expect(await h.cls(h.nav("P", to))).toBe("SEND");
    }
    expect(h.log.find("warn", /conflicting-anchors/)).toHaveLength(0);
    expect(h.sw.calls[h.sw.calls.length - 1]).toEqual(h.call("C2", "profiles/xl", 4));
  });

  test("R3-F2 a child flipping away right after each of the parent's switches is not a conflict", async () => {
    const h = harness();
    await h.boot();
    for (let i = 0; i < 20; i++) {
      const page = 1 + 2 * (i % 2); // 1 or 3: pages without an override, so C1 maps positionally
      h.clock.advance(500);
      await h.nav("P", page); // parent flips; C1#page in flight
      await h.appear("C1", page); // lands → RECEIVE (driven)
      expect(await h.cls(h.nav("C1", 0))).toBe("SEND"); // the human leaves the page (LEAVE) and flips: not driven
    }
    expect(h.log.find("warn", /conflicting-anchors/)).toHaveLength(0);
  });

  test("R3-F17/R7-F1 after tripping, a real page change (one index left) ends the run and the device sends again at once", async () => {
    const { h, flip, drain } = strayAnchorRig(100);
    await h.boot(["P", "C1"]);
    await flip("P", 1);
    await drain();
    expect(h.log.find("warn", /conflicting-anchors/).length).toBeGreaterThan(0);
    const tripped = h.log.find("warn", /conflicting-anchors/)[0].msg.match(/dev=(\w+)/)![1];
    expect(h.state(tripped).drivenRun).toBeGreaterThan(12);
    const calls = h.sw.calls.length;
    const outs = await flip(tripped, 0); // the person flips the tripped deck to a page with one anchor
    expect(outs.map((o) => o.classification)).toEqual(["IGNORED"]); // leaving the stray page was itself one more conflict: still cut off
    expect(h.sw.calls.length).toBe(calls);
    const again = await flip(tripped, tripped === "P" ? 4 : 3); // leaving a page with a single anchor ends the run (and this page is clean too)
    expect(again.map((o) => o.classification)).toEqual(["SEND"]);
    expect(h.state(tripped).drivenRun).toBe(0);
    expect(h.sw.calls.length).toBeGreaterThan(calls);
  });

  test("R3-F3 human navigation before start() is queued and replayed once the settings are known", async () => {
    const h = harness();
    expect(await h.cls(h.appear("P", 0))).toBe("STARTUP"); // the launch burst
    expect(await h.cls(h.appear("C1", 0))).toBe("STARTUP");
    expect(await h.nav("P", 1)).toMatchObject({ classification: "IGNORED", reason: "not-started" }); // a flip before the settings loaded
    expect(h.sw.calls).toEqual([]);
    expect(h.log.find("warn", /no-scope/)).toHaveLength(0);
    await h.engine.start(h.settings);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1)]);
    expect(h.log.find("info", /^START .*queued=1$/)).toHaveLength(1);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
  });

  test("R3-F4 a child flipping to a disabled page while the parent's switch is in flight is still suppressed", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2); // C1#4 (origin parent)
    expect(await h.cls(h.nav("C1", 3, { enabled: false }))).toBe("SUPPRESSED");
    expect(h.state("C1").lastHumanSeq).toBe(0);
    expect(await h.cls(h.appear("C1", 4))).toBe("RECEIVE"); // the parent's switch lands and stays
    expect(h.sw.calls).toHaveLength(2);
    expect([h.page("P"), h.page("C1")]).toEqual([2, 4]);
  });

  test("R3-F5 a member is not skipped as already-there on the strength of a switch the stale rule would undo", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C1", 3); // seq 1: P#3 (slow), C2#3
    await h.nav("P", 1); // seq 2: C1#1, C2#1 — P's own navigation outranks the pending P#3
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    const out = await h.nav("C1", 3); // the child goes back to 3: P must be switched, not assumed there
    expect(out.issued.map((i) => `${i.deviceId}#${i.page}`)).toContain("P#3");
    expect(await h.cls(h.appear("P", 3))).toBe("RECEIVE"); // the old P#3 lands: a later switch is coming, no restore
    expect((await h.appear("P", 3, { actionId: "second-landing" })).reason).toBe("duplicate");
    expect([h.page("P"), h.page("C1")]).toEqual([3, 3]);
  });

  test("R3-F8 a parent relying on a child-issued switch still takes precedence over that child", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C2", 1); // seq 1: P#1, C1#1 (origin child)
    await h.appear("P", 1);
    h.leave("P", 1);
    const out = await h.appear("P", 1); // the parent asserts page 1 itself
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "already-there" }, { deviceId: "C2", reason: "already-there" }]);
    expect(h.state("C1").pending[0]).toMatchObject({ page: 1, originRole: "parent", originId: "P" });
    expect(await h.cls(h.nav("C1", 2))).toBe("SUPPRESSED"); // before C1#1 lands, the child may not lead
  });

  test("R3-F15 start logs the applied configuration even on a fresh install", async () => {
    const h = harness();
    await h.engine.start({ version: 2, scopes: [] });
    expect(h.log.find("info", /^SETTINGS applied \(start\) scopes=\[\] detachedPending=0$/)).toHaveLength(1);
  });

  test("R3-F16 a dependency that throws mid-classification is caught, logged, and the device recovers", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1, C2#1 — C1's queue is non-empty, so ageing it consults the clock before any per-target guard
    const realNow = h.clock.now;
    h.clock.now = () => { throw new Error("clock broken"); };
    expect(await h.nav("C1", 2)).toMatchObject({ classification: "IGNORED", reason: "error" });
    expect(h.log.find("error", /^UNEXPECTED handler=onDisappear dev=C1 page=0 error="clock broken"/)).toHaveLength(1); // the leave touched the clock too
    expect(h.log.find("error", /^UNEXPECTED handler=onAppear dev=C1 page=2 error="clock broken"/)).toHaveLength(1);
    h.clock.now = realNow;
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE"); // the parent's switch lands as usual
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND"); // and the device is free to lead again
  });

  test("R2-F7 a failing target does not stop the fan-out and the send is still recorded", async () => {
    const h = harness();
    await h.boot();
    let calls = 0;
    const real = h.devices.get;
    h.devices.get = (id: string) => { if (id === "C1" && calls++ === 0) throw new Error("directory hiccup"); return real(id); };
    const out = await h.nav("P", 1);
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "error" }]);
    expect(h.sw.calls).toEqual([h.call("C2", "profiles/xl", 1)]);
    expect(h.log.find("warn", /^SKIP target=C1 seq=1 reason=error error="directory hiccup"/)).toHaveLength(1);
    expect(h.state("P")).toMatchObject({ lastHumanSeq: 1, lastHumanPage: 1 });
  });

  test("R2-F21 a switch rejected after its echo was consumed leaves pending untouched", async () => {
    const h = harness();
    await h.boot();
    h.sw.deferFor("C1");
    const send = h.nav("P", 1);
    expect(h.pendingPages("C1")).toEqual([1]);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    h.sw.rejectDeferred(new Error("late rejection"));
    await send;
    expect(h.log.find("warn", /^SWITCH failed dev=C1 .*late rejection/)).toHaveLength(1);
    expect(h.pendingPages("C1")).toEqual([]);
  });

  test("F2 a parent switch that never lands stops suppressing the child after the TTL, with a warning naming the profile", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2); // C1#4 (origin parent), never confirmed
    expect(await h.cls(h.nav("C1", 1))).toBe("SUPPRESSED");
    h.clock.advance(3001);
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND");
    expect(h.log.find("warn", /^SWITCH unconfirmed dev=C1 profile=profiles\/mini page=4 seq=1 origin=P/)).toHaveLength(1);
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 4, expired: "ttl" })]);
    // an expired entry does not predict where the device is: a send to its page is issued again
    await h.appear("P", 3);
    await h.appear("C2", 3); // supersedes C2's own unconfirmed page-2 entry: a tag for one more TTL
    expect(h.state("C2").pending.map((p) => [p.page, p.expired])).toEqual([[2, "superseded"]]);
    expect(h.log.find("debug", /^GC dev=C2 page=2 seq=1 reason=superseded by seq=\d+ \(kept as an echo tag for 3000ms\)/)).toHaveLength(1);
    expect(await h.cls(h.nav("P", 2))).toBe("SEND"); // → C1#4 again (the expired tag predicts nothing), C2#2
    expect(h.sw.calls.filter((c) => c.deviceId === "C1").map((c) => c.page)).toEqual([4, 4]);
  });

  test("F3 a connect event for a device that never disconnected does not disarm it", async () => {
    const h = harness();
    await h.boot();
    h.engine.onDeviceConnected("P"); // the app announcing a device it already showed us
    expect(h.state("P").armed).toBe(true);
    expect(await h.cls(h.nav("P", 1))).toBe("SEND");
    expect(h.log.find("debug", /^DEVICE connected dev=P \(already armed; no change\)/)).toHaveLength(1);
  });

  test("F5 coalesced switches that net to the current page: the bounded cost is one swallowed navigation within the TTL", async () => {
    const h = harness();
    await h.boot();
    for (const to of [1, 3, 0]) await h.nav("P", to);
    expect(h.pendingPages("C2")).toEqual([1, 3, 0]); // the app may show none of these: C2 is already on 0
    expect(await h.cls(h.nav("C2", 3))).toBe("RECEIVE"); // swallowed once: indistinguishable from the echo
    h.clock.advance(3001);
    expect(await h.cls(h.nav("C2", 1))).toBe("SEND"); // after the TTL the parent-origin tag no longer suppresses
  });

  test("the per-device cap turns the oldest still-expected switches into echo tags (warn), and the grace period drops them", async () => {
    const h = harness(deskScope(), { pendingTtlMs: 100, pendingGraceMs: 200, maxPendingPerDevice: 3 });
    await h.boot();
    for (const to of [1, 2, 3, 1, 2]) await h.nav("P", to);
    expect(h.state("C2").pending.map((p) => [p.page, p.expired])).toEqual([[1, "cap"], [2, "cap"], [3, false], [1, false], [2, false]]);
    expect(h.log.find("warn", /^GC dev=C2 page=\d seq=\d reason=cap — more than 3 switches to this device still awaiting a landing; kept as an echo tag only$/)).toHaveLength(2);
    h.clock.advance(201);
    expect(await h.cls(h.nav("P", 4))).toBe("SEND");
    expect(h.pendingPages("C2")).toEqual([4]);
  });

  test("R5-F2 a switch pushed past the cap still lands as a RECEIVE, never as a SEND, even on the parent", async () => {
    const h = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }), { maxPendingPerDevice: 3 });
    await h.boot(["P", "C1"]);
    for (const to of [1, 2, 3, 4]) expect(await h.cls(h.nav("C1", to))).toBe("SEND"); // the parent's app applies none of them yet
    expect(h.state("P").pending.map((p) => [p.page, p.expired])).toEqual([[1, "cap"], [2, false], [3, false], [4, false]]);
    const calls = h.sw.calls.length;
    expect(await h.appear("P", 1)).toMatchObject({ classification: "RECEIVE", seq: 1, late: false }); // the backlog plays out
    expect(h.log.find("info", /^RECEIVE dev=P page=1 seq=1 origin=C1 scope=desk capped=true/)).toHaveLength(1);
    for (const pg of [2, 3, 4]) {
      h.leave("P", h.page("P")!);
      expect(await h.cls(h.appear("P", pg))).toBe("RECEIVE");
    }
    expect(h.sw.calls).toHaveLength(calls); // no fan-out, no restore: everyone ends on the child's last page
    expect(h.log.find("info", /^SEND dev=P/)).toHaveLength(0);
    expect(h.pendingPages("P")).toEqual([]);
  });

  test("R5-F2 one expired tag per page is kept, so tags are bounded by the page count rather than by time", async () => {
    const h = harness();
    await h.boot();
    h.leave("C1", 0); // C1's position is unknown, so every switch to it is issued
    for (let round = 0; round < 3; round++) {
      for (const to of [1, 3]) await h.nav("P", to);
      h.clock.advance(3001);
    }
    await h.nav("P", 0); // ages the last round's entries too
    expect(h.state("C1").pending.map((p) => [p.page, p.seq, p.expired])).toEqual([[1, 5, "ttl"], [3, 6, "ttl"], [0, 7, false]]);
    expect(h.log.find("debug", /^GC dev=C1 page=\d seq=\d reason=duplicate-tag/).map((l) => l.msg.replace(/ reason=.*/, ""))).toEqual([
      "GC dev=C1 page=3 seq=2", "GC dev=C1 page=1 seq=1", "GC dev=C1 page=3 seq=4", "GC dev=C1 page=1 seq=3",
    ]);
    expect(await h.appear("C1", 3)).toMatchObject({ classification: "RECEIVE", seq: 6, late: true }); // the kept tag still absorbs a late landing
  });

  test("F26 a switch issued to a device before its first appear is recognized as an echo and arms it", async () => {
    const h = harness();
    await h.engine.start(h.settings);
    await h.appear("P", 0);
    await h.nav("P", 1); // C1 and C2 have never appeared; their pages are unknown
    expect(h.sw.calls.map((c) => c.deviceId)).toEqual(["C1", "C2"]);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    expect(h.state("C1").armed).toBe(true);
  });

  test("F26 appear(new) arriving before disappear(old) does not lose the new page", async () => {
    const h = harness();
    await h.boot();
    expect(await h.cls(h.appear("P", 1))).toBe("SEND"); // no leave yet
    h.leave("P", 0); // the old page's disappear comes afterwards
    expect(h.page("P")).toBe(1);
    expect((await h.appear("P", 1, { actionId: "second" })).reason).toBe("duplicate");
  });

  test("F26 two scopes are isolated from each other", async () => {
    const other: Scope = { id: "other", name: "Other", parentDeviceId: "Q", members: [{ deviceId: "Q", role: "parent", profile: "profiles/original" }, { deviceId: "C2", role: "child" }], mapping: { mode: "positional", overrides: [] } };
    const desk = deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }] });
    const h = harness([desk, other]);
    h.devices.set("Q", 0);
    await h.boot(["P", "C1", "Q", "C2"]);
    await h.nav("P", 1);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1)]);
    await h.nav("Q", 2);
    expect(h.sw.calls.slice(1)).toEqual([h.call("C2", "profiles/xl", 2)]);
  });

  test("F26 an appear before start() is a startup appear and never throws", async () => {
    const h = harness();
    expect(await h.cls(h.appear("P", 0))).toBe("STARTUP");
    await h.engine.start(h.settings);
    expect(await h.cls(h.nav("P", 1))).toBe("SEND");
  });

  test("F26 a duplicate appear consumes a pending entry for the page the device already shows", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C1", 3); // P#3
    await h.appear("P", 3);
    await h.nav("C2", 0); // P#0 (P shows 3)
    expect(h.pendingPages("P")).toEqual([0]);
    await h.appear("P", 0); // P lands on 0 → RECEIVE
    await h.nav("C1", 3); // P#3 again; P shows 0
    await h.nav("C2", 0); // P#0 queued behind it; the app may show only the last: P stays on 0
    expect(h.pendingPages("P")).toEqual([3, 0]);
    const out = await h.appear("P", 0, { actionId: "editor-re-emit" });
    expect(out.reason).toBe("duplicate");
    expect(h.state("P").pending.map((p) => [p.page, p.expired])).toEqual([[3, "superseded"]]);
    expect(h.log.find("debug", /reason=duplicate \(consumed seq=/)).toHaveLength(1);
  });

  test("R4-F2 a reissued switch is matched by its fresh tag, not an earlier expired one for the same page", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1 seq 1 never lands
    await h.appear("C2", 1);
    h.clock.advance(3001);
    await h.nav("P", 3); // C1#1 expires (warn); C1#3 seq 2
    await h.appear("C2", 3);
    await h.nav("P", 1); // C1#1 reissued, seq 3
    await h.appear("C2", 1);
    expect(h.state("C1").pending.map((p) => [p.page, p.seq, p.expired])).toEqual([[1, 1, "ttl"], [3, 2, false], [1, 3, false]]);
    const out = await h.appear("C1", 1);
    expect(out).toMatchObject({ classification: "RECEIVE", seq: 3, late: false });
    expect(h.log.find("info", /^RECEIVE dev=C1 page=1 seq=3 origin=P scope=desk \(echo/)).toHaveLength(1);
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[1, "superseded"], [3, "superseded"]]); // tags only, one TTL
    expect(h.log.find("debug", /^GC dev=C1 page=3 seq=2 reason=superseded by seq=3 \(kept as an echo tag for 3000ms\)/)).toHaveLength(1);
    expect(await h.cls(h.nav("C1", 0))).toBe("SEND"); // no dangling parent-origin entry suppresses the child
  });

  test("R4-F2 the same with a tag detached by a settings change", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1 seq 1 never lands
    await h.appear("C2", 1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk (renamed)" }))); // detaches it
    await h.nav("P", 3);
    await h.appear("C2", 3);
    await h.nav("P", 1); // reissued, seq 3
    await h.appear("C2", 1);
    const out = await h.appear("C1", 1);
    expect(out).toMatchObject({ classification: "RECEIVE", seq: 3, late: false });
    expect(h.log.find("info", /^RECEIVE dev=C1 page=1 seq=3 origin=P scope=desk \(echo/)).toHaveLength(1);
    expect(h.log.find("info", /detached=true/)).toHaveLength(0);
    expect(await h.cls(h.nav("C1", 0))).toBe("SEND");
  });

  test("R4-F3 alternating flips between parent and child never trip the breaker when the app reports appears before disappears", async () => {
    const h = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }));
    await h.boot(["P", "C1"]);
    let c1Before = 0;
    for (let i = 0; i < 20; i++) {
      h.clock.advance(400);
      const pPage = 1 + (i % 3); // 1,2,3 …
      const cPage = (pPage + 2) % 5; // 3,4,0 …: never where the other deck is about to go
      expect(await h.cls(h.navAppearFirst("P", pPage))).toBe("SEND"); // right after P's own RECEIVE below
      expect(await h.cls(h.appear("C1", pPage))).toBe("RECEIVE");
      h.leave("C1", c1Before); // the late disappear of the page C1 was switched away from
      h.clock.advance(400);
      expect(await h.cls(h.navAppearFirst("C1", cPage))).toBe("SEND"); // right after C1's RECEIVE
      expect(await h.cls(h.appear("P", cPage))).toBe("RECEIVE");
      h.leave("P", pPage); // and of the page P was switched away from
      c1Before = cPage;
    }
    expect(h.log.find("warn", /conflicting-anchors/)).toHaveLength(0);
    expect(h.log.find("debug", /^CONFLICT dev=P page=\d+ also=/).length).toBeGreaterThan(10); // each flip looks like one for a moment …
    expect(h.state("P").drivenRun).toBeLessThanOrEqual(1); // … and the single-index disappear that follows ends it
  });

  test("R4-F3/R8-F1 a page whose two anchors leave together is a conflict in its own right; a run of them trips the breaker", async () => {
    const h = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }), { drivenSendMax: 4 });
    await h.boot(["P", "C1"]);
    // C1's page 1 carries a stray anchor saying 3: every switch of C1 to 1 produces a conflicting send to 3,
    // and leaving page 1 makes both anchors disappear together (a second conflict).
    for (let i = 0; i < 3; i++) {
      h.clock.advance(100);
      await h.nav("P", 1);
      await h.appear("C1", 1); // RECEIVE
      const out = await h.appear("C1", 3, { actionId: "C1-stray-on-1" }); // conflicting send: P#3 issued (runs 1, 3, 5)
      expect(out.classification).toBe(i < 2 ? "SEND" : "IGNORED");
      await h.appear("P", 3);
      await h.nav("P", 0); // the human moves P on; C1#0 issued
      h.leave("C1", 1);
      h.leave("C1", 3, { actionId: "C1-stray-on-1" }); // both indices leave together: proof of the copied anchor (runs 2, 4)
      await h.appear("C1", 0);
    }
    expect(h.log.find("warn", /conflicting-anchors/)).toHaveLength(1);
    expect(h.log.find("debug", /^CONFLICT dev=C1 pages=\[1,3\] \(two page indices left one page together/)).toHaveLength(3);
  });

  test("R4-F4 when the pre-start queue is full the oldest navigation is dropped with a warning, never the newest", async () => {
    const h = harness(deskScope(), { maxQueuedBeforeStart: 2 });
    expect(await h.cls(h.appear("P", 0))).toBe("STARTUP");
    expect(await h.cls(h.appear("C1", 0))).toBe("STARTUP");
    expect(await h.cls(h.appear("C2", 0))).toBe("STARTUP");
    for (const to of [1, 2, 3]) expect(await h.cls(h.nav("P", to))).toBe("IGNORED");
    expect(h.log.find("warn", /^QUEUE full dev=P page=3 reason=not-started — more than 2 navigations before the settings loaded; dropped the oldest \(dev=P page=1\)/)).toHaveLength(1);
    await h.engine.start(h.settings);
    expect(h.log.find("info", /^START .*queued=2$/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 4), h.call("C2", "profiles/xl", 2), h.call("C1", "profiles/mini", 3), h.call("C2", "profiles/xl", 3)]); // P:2 ↔ C1:4
  });

  test("R4-F6 navigation queued before start is discarded when the device disconnects, so its reconnect burst stays startup", async () => {
    const h = harness();
    expect(await h.cls(h.appear("P", 0))).toBe("STARTUP");
    expect(await h.cls(h.appear("C1", 0))).toBe("STARTUP");
    expect(await h.cls(h.nav("C1", 1))).toBe("IGNORED"); // queued
    h.engine.onDeviceDisconnected("C1");
    expect(h.log.find("info", /^DEVICE disconnected dev=C1 droppedPending=0 droppedQueued=1;/)).toHaveLength(1);
    await h.engine.start(h.settings);
    expect(h.log.find("info", /^START .*queued=0$/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([]);
    expect(h.state("C1").armed).toBe(false);
    h.engine.onDeviceConnected("C1");
    expect(await h.cls(h.appear("C1", 3))).toBe("STARTUP"); // the reconnect burst, on whatever page it comes back
    expect(h.sw.calls).toEqual([]);
  });

  test("R5-F4/R6-F1 pre-start navigations never conflict: a replayed fan-out leaves a device alone whose own later flip is replayed next", async () => {
    const h = harness();
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    expect(await h.cls(h.nav("P", 1))).toBe("IGNORED");
    expect(await h.cls(h.nav("C1", 3))).toBe("IGNORED");
    await h.engine.start(h.settings);
    expect(h.sw.calls).toEqual([h.call("C2", "profiles/xl", 1), h.call("P", "profiles/plus", 3), h.call("C2", "profiles/xl", 3)]); // C1's later flip is never driven, then leads
    expect(h.log.find("debug", /^SKIP target=C1 seq=1 reason=queued-later/)).toHaveLength(1);
    expect(h.log.find("info", /^SEND dev=P .*skipped=\[C1:queued-later\]$/)).toHaveLength(1);
    expect(h.log.find("info", /SUPPRESSED/)).toHaveLength(0);
    expect(h.page("P")).toBe(1); // where the human left it, until the switch lands
    expect(await h.cls(h.appear("P", 3))).toBe("RECEIVE");
  });

  test("R5-F4 … and in the other order the parent's later flip leads, with the child's recorded position honoured", async () => {
    const h = harness();
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    await h.nav("C1", 3);
    await h.nav("P", 1);
    await h.engine.start(h.settings);
    expect(h.sw.calls).toEqual([h.call("C2", "profiles/xl", 3), h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1)]); // C1 is on 3, so it is not already there
    expect(h.page("C1")).toBe(3);
  });

  test("R6-F1 when the later pre-start flip cannot lead (disabled page, no counterpart), the parent's earlier flip still reaches everyone else", async () => {
    const disabled = harness();
    for (const id of ["P", "C1", "C2"]) expect(await disabled.cls(disabled.appear(id, 0))).toBe("STARTUP");
    await disabled.nav("P", 1);
    await disabled.nav("C1", 3, { enabled: false });
    await disabled.engine.start(disabled.settings);
    expect(disabled.sw.calls).toEqual([disabled.call("C2", "profiles/xl", 1)]); // C2 follows the parent; C1 stays where its own flip put it
    expect(disabled.log.find("info", /^IGNORED dev=C1 page=3 scope=desk reason=disabled$/)).toHaveLength(1);
    expect([disabled.page("P"), disabled.page("C1")]).toEqual([1, 3]);

    const orphan = harness();
    for (const id of ["P", "C1", "C2"]) expect(await orphan.cls(orphan.appear(id, 0))).toBe("STARTUP");
    await orphan.nav("P", 1);
    await orphan.nav("C1", 2); // C1's page 2 has no counterpart (P:2 ↔ C1:4)
    await orphan.engine.start(orphan.settings);
    expect(orphan.sw.calls).toEqual([orphan.call("C2", "profiles/xl", 1)]);
    expect(orphan.log.find("info", /^SEND dev=C1 .*skipped=\[P:no-counterpart, C2:no-counterpart\]$/)).toHaveLength(1);
  });

  test("R6-F2 a page left again before start is forgotten after its replay, so returning to it is navigation, not a duplicate", async () => {
    const h = harness();
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    await h.nav("P", 1); // queued
    h.leave("P", 1); // into a folder / an un-anchored page, still before start
    await h.engine.start(h.settings);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1)]); // the flip is still replayed
    expect(h.log.find("debug", /^LEAVE dev=P page=1 \(left before the settings loaded\)/)).toHaveLength(1);
    expect(h.page("P")).toBeNull();
    await h.appear("C1", 1);
    await h.appear("C2", 1);
    await h.nav("C1", 2); // no counterpart for P or C2
    const back = await h.appear("P", 1); // out of the folder
    expect(back.classification).toBe("SEND");
    expect(h.sw.calls[h.sw.calls.length - 1]).toEqual(h.call("C1", "profiles/mini", 1)); // C1 is brought back
  });

  test("R6-F5 switches superseded by a later landing stay echo tags for one TTL: a backlog the app applies late is never rebroadcast", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2); // C1#4 (override), C2#2
    await h.appear("C2", 2);
    h.clock.advance(5000); // C1's app stalls past the TTL
    await h.nav("P", 1); // C1#4 expires; C1#1, C2#1
    await h.appear("C2", 1);
    await h.nav("P", 2); // C1#4 again (seq 3), C2#2
    await h.appear("C2", 2);
    expect(h.state("C1").pending.map((p) => [p.page, p.seq, p.expired])).toEqual([[4, 1, "ttl"], [1, 2, false], [4, 3, false]]);
    const calls = h.sw.calls.length;
    // The stalled app now applies all three switches in order: 4, 1, 4.
    expect(await h.appear("C1", 4)).toMatchObject({ classification: "RECEIVE", seq: 3 }); // the fresh tag matches first; the rest become tags
    expect(h.state("C1").pending.map((p) => [p.page, p.seq, p.expired])).toEqual([[4, 1, "superseded"], [1, 2, "superseded"]]);
    h.leave("C1", 4);
    expect(await h.appear("C1", 1)).toMatchObject({ classification: "RECEIVE", seq: 2, late: false });
    expect(h.log.find("info", /^RECEIVE dev=C1 page=1 seq=2 origin=P scope=desk superseded=true/)).toHaveLength(1);
    h.leave("C1", 1);
    expect(await h.appear("C1", 4)).toMatchObject({ classification: "RECEIVE", seq: 1, late: false });
    expect(h.sw.calls).toHaveLength(calls); // nothing was rebroadcast
    expect(h.log.find("info", /^SEND dev=C1/)).toHaveLength(0);
    // The superseded tag lives one TTL from the landing that superseded it, not the full grace period.
    const g = harness();
    await g.boot();
    await g.nav("P", 1);
    await g.nav("P", 3);
    await g.appear("C2", 3); // coalesced: page 1 superseded
    g.clock.advance(3001);
    await g.appear("C2", 3, { actionId: "poke" }); // ages C2's tags
    expect(g.pendingPages("C2")).toEqual([]);
    expect(g.log.find("debug", /^GC dev=C2 page=1 seq=1 reason=grace-elapsed \(3000ms without an appear\)/)).toHaveLength(1);
  });

  test("R6-F7 a device removed from its scope still has its detached switch undone when that lands after its own later flip", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1 (seq 1), C2#1
    await h.appear("C2", 1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C2", role: "child" }] }))); // C1 unscoped
    expect(await h.nav("C1", 3)).toMatchObject({ classification: "IGNORED", reason: "no-scope" }); // recorded as C1's page (seq 2)
    h.leave("C1", 3);
    const out = await h.appear("C1", 1); // the detached switch lands after C1's own flip
    expect(out).toMatchObject({ classification: "RECEIVE_STALE", seq: 1, issued: [{ deviceId: "C1", profile: "profiles/mini", page: 3, seq: 3 }] });
    expect(h.log.find("info", /^RECEIVE_STALE dev=C1 page=1 seq=1 origin=P scope=none detached=true landed after/)).toHaveLength(1);
    expect(await h.appear("C1", 3)).toMatchObject({ classification: "RECEIVE", seq: 3 });
    expect(h.log.find("info", /^RECEIVE dev=C1 page=3 seq=3 origin=C1 scope=none \(echo/)).toHaveLength(1);
  });

  test("R6-F7 a switch detached by a settings change is still in flight: landing after the device's own later flip it is stale and restored", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1, C2#1 (seq 1)
    await h.appear("C2", 1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk (renamed)" }))); // C1#1 detached
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND"); // not suppressed any more (seq 2): P#3, C2#3
    await h.appear("P", 3);
    await h.appear("C2", 3);
    h.leave("C1", 3);
    const out = await h.appear("C1", 1); // the detached switch lands after C1's own flip
    expect(out).toMatchObject({ classification: "RECEIVE_STALE", seq: 1, issued: [{ deviceId: "C1", profile: "profiles/mini", page: 3, seq: 3 }] });
    expect(h.log.find("info", /^RECEIVE_STALE dev=C1 page=1 seq=1 origin=P scope=desk detached=true landed after this device's own navigation seq=2; restoring page=3 seq=3$/)).toHaveLength(1);
    expect(await h.cls(h.appear("C1", 3))).toBe("RECEIVE"); // everyone on 3
    // Past the TTL a detached entry ages into a plain late tag and no longer restores.
    const g = harness();
    await g.boot();
    await g.nav("P", 1);
    await g.appear("C2", 1);
    g.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk 2" })));
    g.clock.advance(3001);
    expect(await g.cls(g.nav("C1", 3))).toBe("SEND");
    expect(g.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[1, "ttl"]]);
    g.leave("C1", 3);
    expect(await g.appear("C1", 1)).toMatchObject({ classification: "RECEIVE", late: true, issued: [] });
  });

  test("R5-F4 a device that leaves and returns to the same page before start still leads once", async () => {
    const h = harness();
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    h.leave("P", 0);
    await h.appear("P", 1);
    h.leave("P", 1); // to an un-anchored page …
    await h.appear("P", 1); // … and back; queued twice
    await h.engine.start(h.settings);
    expect(h.log.find("info", /^START .*queued=2$/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1)]); // not read as a duplicate
    expect(h.log.find("debug", /reason=duplicate/)).toHaveLength(0);
  });

  test("R5-F4 scopes replay independently: each scope's queued navigation reaches its own members", async () => {
    const second: Scope = { id: "shelf", name: "Shelf", parentDeviceId: "X", members: [{ deviceId: "X", role: "parent" }, { deviceId: "Y", role: "child" }], mapping: { mode: "positional", overrides: [] } };
    const h = harness([deskScope(), second]);
    h.devices.set("X", 0);
    h.devices.set("Y", 1);
    for (const id of ["P", "C1", "C2", "X", "Y"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    await h.nav("P", 1);
    await h.nav("X", 2);
    await h.engine.start(h.settings);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1), h.call("C2", "profiles/xl", 1), h.call("Y", "profiles/mini", 2)]);
  });

  test("R5-F4 a pre-start navigation on a device in no scope is replayed as it is (it warns once, sends nothing)", async () => {
    const h = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }));
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    await h.nav("C2", 2); // C2 is in no scope
    await h.nav("P", 1);
    await h.engine.start(h.settings);
    expect(h.log.find("warn", /^IGNORED dev=C2 page=2 reason=no-scope/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([h.call("C1", "profiles/mini", 1)]);
    expect(h.page("C2")).toBe(2);
  });

  test("R5-F12 a flip to a page beyond the device's configured page count warns once, naming the fix", async () => {
    const h = harness();
    await h.boot();
    const out = await h.nav("P", 6);
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "no-counterpart" }, { deviceId: "C2", reason: "no-counterpart" }]);
    expect(h.log.find("info", /^SEND dev=P .*page=6 canonical=none/)).toHaveLength(1);
    expect(h.log.find("warn", /^SEND dev=P page=6 scope=desk reason=beyond-page-count pageCount=5 — no member can follow; raise Pages for this device/)).toHaveLength(1);
    await h.nav("P", 0);
    await h.nav("P", 6);
    expect(h.log.find("warn", /beyond-page-count/)).toHaveLength(1); // once per device and page
    await h.nav("P", 4); // a page the configuration knows: C1 has no counterpart (its page 4 is pinned), C2 does — not a configuration error
    expect(h.log.find("warn", /beyond-page-count/)).toHaveLength(1);
    expect(h.sw.calls[h.sw.calls.length - 1]).toEqual(h.call("C2", "profiles/xl", 4));
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk 2" }))); // a new configuration may have fixed it: warn again
    await h.nav("P", 6);
    expect(h.log.find("warn", /beyond-page-count/)).toHaveLength(2);
  });

  test("R6-F16 log levels are pinned: a disabled page is info, already-there is debug", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 3, { enabled: false });
    expect(h.log.find("info", /^IGNORED dev=P page=3 scope=desk reason=disabled$/)).toHaveLength(1);
    expect(h.log.find("debug", /reason=disabled/)).toHaveLength(0);
    expect(h.log.find("warn", /reason=disabled/)).toHaveLength(0);
    await h.nav("P", 0); // everyone is already on 0
    expect(h.log.find("debug", /^SKIP target=C1 seq=2 reason=already-there$/)).toHaveLength(1);
    expect(h.log.find("info", /^SKIP/)).toHaveLength(0);
    expect(h.log.find("warn", /^SKIP/)).toHaveLength(0);
  });

  test("R6-F18 the grace period really is clamped to the TTL: an echo between the two is a plain RECEIVE", async () => {
    const h = harness(deskScope(), { pendingTtlMs: 5000, pendingGraceMs: 100 });
    await h.boot();
    await h.nav("P", 1);
    h.clock.advance(1000); // past the requested grace, within the TTL
    const calls = h.sw.calls.length;
    expect(await h.appear("C1", 1)).toMatchObject({ classification: "RECEIVE", late: false });
    expect(h.sw.calls).toHaveLength(calls);
    expect(h.log.find("debug", /grace-elapsed/)).toHaveLength(0);
  });

  test("R5-F17 a member the app has never reported is skipped as disconnected, with the warning", async () => {
    const h = harness(deskScope({ members: [...deskScope().members, { deviceId: "C3", role: "child", profile: "profiles/original" }] }));
    await h.boot();
    const out = await h.nav("P", 1);
    expect(out.skipped).toEqual([{ deviceId: "C3", reason: "disconnected" }]);
    expect(h.sw.calls.map((c) => c.deviceId)).toEqual(["C1", "C2"]);
    expect(h.log.find("warn", /^SKIP target=C3 seq=1 reason=disconnected — the app has not reported the device as connected/)).toHaveLength(1);
  });

  test("R5-F18 a stale-switch restore is the device's own: it never suppresses the child's next flip", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C2", 1); // C2 leads: P#1, C1#1 (seq 1)
    await h.appear("P", 1);
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND"); // C1's own flip before the peer's switch lands (seq 2)
    await h.appear("P", 3);
    await h.appear("C2", 3);
    h.leave("C1", 3);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE_STALE"); // the peer's switch lands late
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 3, originRole: "self", originId: "C1" })]);
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND"); // flipping again while the restore is in flight is not suppressed
  });

  test("R7-F2 an older tag for the page a fresh switch just landed on never fights or outlives that landing", async () => {
    // Detached variant: the old tag was detached by a settings change.
    const d = harness();
    await d.boot();
    await d.nav("P", 1); // C1#1 seq 1 never lands
    await d.appear("C2", 1);
    d.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk (renamed)" })));
    await d.nav("P", 3);
    await d.appear("C2", 3);
    await d.nav("P", 1); // C1#1 reissued, seq 3
    await d.appear("C2", 1);
    expect(await d.appear("C1", 1)).toMatchObject({ classification: "RECEIVE", seq: 3 });
    expect(d.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[1, "superseded"], [3, "superseded"]]);
    expect(await d.cls(d.nav("C1", 0))).toBe("SEND"); // seq 4
    const calls = d.sw.calls.length;
    expect(await d.nav("C1", 1)).toMatchObject({ classification: "RECEIVE", issued: [] }); // back within the TTL: swallowed once, never fought
    expect(d.sw.calls).toHaveLength(calls);
    expect(d.log.find("info", /RECEIVE_STALE/)).toHaveLength(0);
    d.clock.advance(3001);
    expect(await d.cls(d.nav("C1", 0))).toBe("SEND");
    expect(await d.cls(d.nav("C1", 1))).toBe("SEND"); // the tag is gone after one TTL
    // TTL variant: the old tag had expired.
    const t = harness();
    await t.boot();
    await t.nav("P", 1);
    await t.appear("C2", 1);
    t.clock.advance(3001);
    await t.nav("P", 3);
    await t.appear("C2", 3);
    await t.nav("P", 1);
    await t.appear("C2", 1);
    expect(await t.appear("C1", 1)).toMatchObject({ classification: "RECEIVE", seq: 3 });
    expect(await t.cls(t.nav("C1", 0))).toBe("SEND");
    t.clock.advance(3001);
    expect(await t.cls(t.nav("C1", 1))).toBe("SEND"); // not swallowed by the stale tag for the rest of its grace period
  });

  test("R7-F3 a detached switch still predicts where its device will be, so the parent's flip back is not skipped as already-there", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1, C2#1
    await h.appear("C2", 1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk (renamed)" }))); // C1#1 detached, still heading for C1
    const out = await h.nav("P", 0);
    expect(out.issued.map((i) => `${i.deviceId}#${i.page}`)).toEqual(["C1#0", "C2#0"]);
    expect(await h.appear("C1", 1)).toMatchObject({ classification: "RECEIVE", seq: 1 }); // the detached switch lands
    h.leave("C1", 1);
    expect(await h.appear("C1", 0)).toMatchObject({ classification: "RECEIVE", seq: 2 }); // and the flip back brings C1 along
  });

  test("R7-F4 editing a visible anchor's page index updates the engine's view of the device without syncing", async () => {
    const h = harness(deskScope({ mapping: { mode: "positional", overrides: [] } }));
    await h.boot();
    // P's page-2 anchor was saved with the wrong index 3; the person corrects it in the Property Inspector.
    await h.nav("P", 3); // (as the wrong anchor reports it) → C1#3, C2#3
    await h.appear("C1", 3);
    await h.appear("C2", 3);
    const calls = h.sw.calls.length;
    h.engine.onAnchorUpdated({ deviceId: "P", actionId: "P-p3", pageIndex: 2, enabled: true, isInMultiAction: false });
    expect(h.sw.calls).toHaveLength(calls); // editing is not navigation
    expect(h.page("P")).toBe(2);
    expect(h.log.find("info", /^ANCHOR updated dev=P action=P-p3 page=3→2 enabled=true \(no sync\)$/)).toHaveLength(1);
    expect(await h.cls(h.nav("C1", 2))).toBe("SEND"); // P is already on 2 as far as the engine now knows
    expect(h.sw.calls.slice(calls)).toEqual([h.call("C2", "profiles/xl", 2)]);
    // First-time setup: an anchor placed without an index arms the device once the index is typed.
    const g = harness();
    await g.engine.start(g.settings);
    expect(await g.cls(g.appear("P", undefined, { actionId: "new-anchor" }))).toBe("IGNORED");
    expect(g.state("P").armed).toBe(false);
    g.engine.onAnchorUpdated({ deviceId: "P", actionId: "new-anchor", pageIndex: 0, enabled: true, isInMultiAction: false });
    expect(g.state("P")).toMatchObject({ armed: true, lastKnownPage: 0 });
    expect(await g.cls(g.appear("C1", 0))).toBe("STARTUP");
    expect(await g.cls(g.nav("P", 1))).toBe("SEND");
    // A switch to the edited index counts as landed; clearing the index forgets the page; a multi-action edit is ignored.
    await g.appear("C1", 1);
    await g.nav("C1", 3); // P#3 (seq 2)
    expect(g.pendingPages("P")).toEqual([3]);
    g.engine.onAnchorUpdated({ deviceId: "P", actionId: "P-p3", pageIndex: 3, enabled: false, isInMultiAction: false });
    expect(g.pendingPages("P")).toEqual([]);
    expect(g.log.find("info", /^ANCHOR updated dev=P action=P-p3 page=1→3 enabled=false \(consumed seq=2\) \(no sync\)$/)).toHaveLength(1);
    g.engine.onAnchorUpdated({ deviceId: "P", actionId: "P-p3", pageIndex: undefined, enabled: true, isInMultiAction: false });
    expect(g.page("P")).toBeNull();
    expect(g.log.find("info", /^ANCHOR updated dev=P action=P-p3 page=3→none/)).toHaveLength(1);
    g.engine.onAnchorUpdated({ deviceId: "P", actionId: "multi", pageIndex: 4, enabled: true, isInMultiAction: true });
    expect(g.page("P")).toBeNull();
  });

  test("R7-F10 a human flip arriving while the replay awaits the app is queued and replayed after it, under the normal rules", async () => {
    const h = harness();
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    await h.nav("P", 1); // queued
    h.sw.deferFor("C2"); // the app is slow to acknowledge C2's switch
    const starting = h.engine.start(h.settings);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the requests go out in a microtask
    expect(h.sw.calls.map((c) => `${c.deviceId}#${c.page}`)).toEqual(["C1#1", "C2#1"]); // P's replay is already issued …
    const live = await h.nav("C1", 4); // … when a live flip arrives: it waits its turn
    expect(live).toMatchObject({ classification: "IGNORED", reason: "not-started" });
    expect(h.engine.snapshot().started).toBe(false);
    h.sw.rejectDeferred(new Error("slow app")); // settle the acknowledgement either way
    h.sw.undefer("C2");
    await starting;
    expect(h.engine.snapshot().started).toBe(true);
    // Replayed after P's: the parent's switch to C1 was genuinely issued before the flip, so precedence applies as it would live.
    expect(h.log.find("info", /^SUPPRESSED dev=C1 page=4 scope=desk reason=parent-in-flight pending=\[page=1 seq=1\]/)).toHaveLength(1);
    expect(h.sw.calls).toHaveLength(2);
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    expect(await h.cls(h.nav("C1", 4))).toBe("SEND"); // and now it leads
  });

  test("R8-F2 a landing satisfies every switch to that page: a reissued same-page switch does not dangle and suppress the child", async () => {
    const h = harness(deskScope({ mapping: { mode: "positional", overrides: [] } }));
    await h.boot();
    await h.nav("C1", 3); // seq 1: P#3, C2#3 (C2's app is slow)
    await h.nav("C2", 1); // seq 2: P#1, C1#1
    await h.appear("P", 3);
    h.leave("P", 3);
    await h.appear("P", 1);
    await h.appear("C1", 1);
    expect(h.state("C2").pending.map((p) => [p.page, p.seq, p.originRole])).toEqual([[3, 1, "child"]]);
    await h.nav("P", 3); // seq 3: C1#3 and, since C2's in-flight switch predates its own flip, C2#3 again
    expect(h.state("C2").pending.map((p) => [p.page, p.seq, p.originRole])).toEqual([[3, 1, "child"], [3, 3, "parent"]]);
    await h.appear("C1", 3);
    h.leave("C2", 1);
    expect(await h.appear("C2", 3)).toMatchObject({ classification: "RECEIVE", seq: 3 }); // the latest switch to the page
    expect(h.state("C2").pending.map((p) => [p.page, p.seq, p.expired])).toEqual([[3, 1, "superseded"]]); // nothing in flight dangles
    expect(await h.cls(h.nav("C2", 0))).toBe("SEND"); // the person's next flip is not suppressed
  });

  test("R8-F4 leaving a page overtakes a switch to it still in flight: the person's return is not read as a stale landing and fought", async () => {
    const h = harness(deskScope({ mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 0 } }] } }));
    await h.boot();
    h.engine.onAnchorUpdated({ deviceId: "C1", actionId: "C1-p0", pageIndex: undefined, enabled: true, isInMultiAction: false }); // the engine no longer knows C1 is on 0
    await h.nav("C2", 2); // seq 1: P#2, C1#0 — C1 is already on 0, so nothing shows
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[0, false]]);
    expect(await h.cls(h.nav("C1", 1))).toBe("SEND"); // leaving 0 overtakes the switch to 0 (seq 2)
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[0, "superseded"]]);
    expect(h.log.find("debug", /^GC dev=C1 page=0 seq=1 reason=left-page/)).toHaveLength(1);
    const calls = h.sw.calls.length;
    expect(await h.nav("C1", 0)).toMatchObject({ classification: "RECEIVE", issued: [] }); // back within the TTL: swallowed once, never fought
    expect(h.sw.calls).toHaveLength(calls);
    expect(h.log.find("info", /RECEIVE_STALE/)).toHaveLength(0);
    h.clock.advance(3001);
    expect(await h.cls(h.nav("C1", 1))).toBe("SEND");
    expect(await h.cls(h.nav("C1", 0))).toBe("SEND"); // the tag is gone
  });

  test("R8-F7 before start, several anchors on one page take one queue slot and replay as one navigation", async () => {
    const h = harness(deskScope(), { maxQueuedBeforeStart: 3 });
    for (const id of ["P", "C1", "C2"]) expect(await h.cls(h.appear(id, 0))).toBe("STARTUP");
    for (const to of [1, 2, 3]) {
      h.leave("P", h.physical.P!);
      for (const a of ["a", "b", "c"]) await h.appear("P", to, { actionId: `P-p${to}-${a}` });
    }
    expect(h.log.find("debug", /reason=duplicate \(already queued\)/)).toHaveLength(6);
    expect(h.log.find("warn", /QUEUE full/)).toHaveLength(0);
    await h.engine.start(h.settings);
    expect(h.log.find("info", /^START .*queued=3$/)).toHaveLength(1);
    expect(h.log.find("info", /^SEND dev=P/)).toHaveLength(3);
    expect(h.sw.calls.map((c) => `${c.deviceId}#${c.page}`)).toEqual(["C1#1", "C2#1", "C1#4", "C2#2", "C1#3", "C2#3"]); // P:2 ↔ C1:4
  });

  test("R8-F11 a stale-switch restore uses the profile the switch landed in, not the member's current one", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1 in profiles/mini (seq 1)
    await h.appear("C2", 1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child", profile: "profiles/custom" }, { deviceId: "C2", role: "child" }] })));
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND"); // seq 2
    await h.appear("P", 3);
    await h.appear("C2", 3);
    h.leave("C1", 3);
    expect(await h.appear("C1", 1)).toMatchObject({ classification: "RECEIVE_STALE", issued: [{ deviceId: "C1", profile: "profiles/mini", page: 3, seq: 3 }] });
    await h.appear("C1", 3);
    await h.nav("P", 0);
    expect(h.sw.calls[h.sw.calls.length - 2]).toEqual(h.call("C1", "profiles/custom", 0)); // the next fan-out uses the new profile
  });

  test("R4-F17 a disappear for a device the engine has never seen is ignored", () => {
    const h = harness();
    expect(() => h.engine.onDisappear({ deviceId: "ghost", actionId: "g", pageIndex: 0, isInMultiAction: false })).not.toThrow();
    expect(h.engine.snapshot().devices.map((d) => d.id)).toEqual([]);
  });

  test("R4-F17 a settings change leaves already-expired entries as they are and counts only fresh ones as detached", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 1); // C1#1, C2#1
    await h.appear("C2", 1);
    h.clock.advance(3001);
    await h.nav("P", 3); // C1#1 expires; C1#3, C2#3 fresh
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk 2" })));
    expect(h.log.find("info", /^SETTINGS applied \(update\) .*detachedPending=2$/)).toHaveLength(1);
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[1, "ttl"], [3, "detached"]]);
  });

  test("R4-F19 engine options: the grace period never undercuts the TTL, and the breaker threshold is honoured", async () => {
    const clamped = harness(deskScope(), { pendingTtlMs: 5000, pendingGraceMs: 100 });
    await clamped.boot();
    expect(clamped.log.find("info", /^START .*ttlMs=5000 graceMs=5000 /)).toHaveLength(1);
    const bareLog = new MemoryLog();
    await new SyncEngine({ switcher: new FakeSwitcher(), clock: new FakeClock(), log: bareLog, devices: new FakeDevices() }).start(settingsWith());
    expect(bareLog.find("info", /^START devices=\[\] scopes=0 ttlMs=3000 graceMs=30000 queued=0$/)).toHaveLength(1); // the defaults

    const tight = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } }), { drivenSendMax: 1 });
    await tight.boot(["P", "C1"]);
    // Two conflicting sends in a row: the second trips a threshold of 1, however much time passes between them.
    await tight.nav("P", 1);
    await tight.appear("C1", 1);
    expect(await tight.cls(tight.appear("C1", 3, { actionId: "stray-a" }))).toBe("SEND"); // run 1
    await tight.appear("P", 3);
    tight.clock.advance(600_000);
    await tight.nav("P", 1); // C1 is believed on 3 → C1#1 issued; C1 shows page 1 again without leaving it (its two anchors are still up)
    await tight.appear("C1", 1);
    expect(await tight.cls(tight.appear("C1", 3, { actionId: "stray-a" }))).toBe("IGNORED"); // run 2 > 1
    // A real page change (one index leaving) ends the run.
    await tight.appear("P", 3);
    tight.leave("C1", 1);
    tight.leave("C1", 3, { actionId: "stray-a" }); // both anchors leave: one more conflict …
    expect(await tight.cls(tight.appear("C1", 0))).toBe("IGNORED"); // … so the device is still cut off on the next page
    tight.leave("C1", 0); // a single-index group: the run is over
    expect(await tight.cls(tight.appear("C1", 2))).toBe("SEND");
    await tight.appear("P", 2);
    await tight.nav("P", 1);
    tight.leave("C1", 2);
    await tight.appear("C1", 1);
    expect(await tight.cls(tight.appear("C1", 3, { actionId: "stray-a" }))).toBe("SEND"); // one conflict, under the threshold again
  });

  test("F26 a directory that fails for every target yields a SEND with every target skipped, nothing thrown", async () => {
    const h = harness();
    await h.boot();
    h.devices.throwOnGet = true;
    const out = await h.nav("P", 1);
    expect(out.classification).toBe("SEND");
    expect(out.skipped.map((s) => s.reason)).toEqual(["error", "error"]);
    expect(h.log.find("error", /UNEXPECTED/)).toHaveLength(0);
    expect(h.sw.calls).toEqual([]);
  });
});
