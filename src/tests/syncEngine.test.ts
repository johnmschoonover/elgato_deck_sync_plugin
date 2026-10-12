/**
 * PRD §7.3 AC [agent] (a)–(e), §7.6 logging, the edge cases E1–E20 from the
 * engine design, and the review findings (F-numbers), against the pure
 * SyncEngine with fake SDK dependencies.
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
  private throwSync = false;
  failFor(deviceId: string, err: Error, once = false) { this.failing.set(deviceId, { err, once }); }
  throwSynchronously() { this.throwSync = true; }
  switchToProfile = (deviceId: string, profile: string, page: number): Promise<void> => {
    if (this.throwSync) throw new Error("switcher exploded");
    this.calls.push({ deviceId, profile, page });
    const f = this.failing.get(deviceId);
    if (f) {
      if (f.once) this.failing.delete(deviceId);
      return Promise.reject(f.err);
    }
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
  const appear = (dev: string, page: number | undefined, o: AppearOpts = {}) =>
    engine.onAppear({ deviceId: dev, actionId: o.actionId ?? `${dev}-p${page}`, pageIndex: page, enabled: o.enabled ?? true, isInMultiAction: o.multi ?? false });
  const leave = (dev: string, page: number, o: AppearOpts = {}) =>
    engine.onDisappear({ deviceId: dev, actionId: o.actionId ?? `${dev}-p${page}`, pageIndex: page, isInMultiAction: o.multi ?? false });
  const state = (dev: string) => engine.snapshot().devices.find((d) => d.id === dev)!;
  const pendingPages = (dev: string) => state(dev).pending.map((p) => p.page);
  const page = (dev: string) => state(dev).lastKnownPage;
  /** Start and replay the launch burst: everyone on page 0, nothing issued. */
  const boot = async (ids = ["P", "C1", "C2"]) => {
    engine.start(settings);
    for (const id of ids) expect((await appear(id, 0)).classification).toBe("STARTUP");
    expect(sw.calls).toEqual([]);
  };
  /** Human navigation: leave the current page, then appear on the new one. */
  const nav = async (dev: string, to: number, o: AppearOpts = {}) => {
    const from = page(dev);
    if (from !== null) leave(dev, from);
    return appear(dev, to, o);
  };
  const cls = async (p: Promise<Outcome>) => (await p).classification;
  const call = (deviceId: string, profile: string, page: number) => ({ deviceId, profile, page });
  return { engine, sw, clock, log, devices, settings, appear, leave, nav, boot, state, pendingPages, page, cls, call };
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
    h.engine.start(h.settings);
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
    await h.appear("C2", 3, { actionId: "poke" }); // duplicate; only ages C2's entries
    expect(h.state("C1").pending[0].expired).toBe(false); // not expired at exactly the TTL
    h.clock.advance(1);
    await h.nav("P", 1); // ages C1's entries during fan-out planning
    expect(h.state("C1").pending.map((p) => [p.page, p.expired])).toEqual([[3, true], [1, false]]);
    expect(h.log.find("warn", /^SWITCH unconfirmed dev=C1 profile=profiles\/mini page=3 seq=1 origin=P — no appear within 3000ms/)).toHaveLength(1);
    h.clock.advance(31000);
    await h.appear("C2", 1);
    const out = await h.appear("C1", 2); // a human navigation after the grace: the old tags are gone
    expect(out.classification).toBe("SEND");
    expect(h.log.find("debug", /^GC dev=C1 page=3 seq=1 reason=grace-elapsed/)).toHaveLength(1);
    expect(h.log.find("debug", /^GC dev=C1 page=1 seq=2 reason=grace-elapsed/)).toHaveLength(1);
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
    // C2 shows only the last page: the earlier entry is superseded
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect(h.pendingPages("C2")).toEqual([]);
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
    expect(h.state("C1").lastSendSeq).toBe(0);
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
    h.engine.onSettingsChanged(h.settings); // a reload that changes nothing (the PI opened) keeps state
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 4, expired: false })]);
    expect(h.log.find("debug", /^SETTINGS unchanged/)).toHaveLength(1);
    h.engine.onSettingsChanged(settingsWith(deskScope({ name: "Desk 2" })));
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 4, expired: true })]);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([2, 0, 0]);
    expect(h.engine.snapshot().devices.every((d) => d.armed)).toBe(true);
    expect(h.log.find("info", /^SETTINGS applied \(update\) scopes=\[desk\{parent=P,children=2,overrides=1\}\] detachedPending=2$/)).toHaveLength(1);
    expect(await h.appear("C1", 4)).toMatchObject({ classification: "RECEIVE", late: true, issued: [] });
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
    h.engine.start(h.settings);
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
    expect(h.log.find("info", /^IGNORED dev=X .*reason=no-scope/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([]);
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
    expect(h.log.find("info", /^RECEIVE_STALE dev=C1 page=3 seq=1 origin=C2 landed after this device's own send seq=2; restoring page=4 seq=3$/)).toHaveLength(1);
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
    expect(h.state("P")).toMatchObject({ lastKnownPage: 2, pending: [], lastSendSeq: 1, lastSendPage: 2 });
    expect(h.sw.calls.some((c) => c.deviceId === "P")).toBe(false);
  });

  test("E18 a disconnected parent is skipped with a warning; connected children still follow", async () => {
    const h = harness();
    h.devices.connect("P", false);
    await h.boot(["C1", "C2"]);
    const out = await h.nav("C1", 3);
    expect(out.skipped).toEqual([{ deviceId: "P", reason: "disconnected" }]);
    expect(h.sw.calls).toEqual([h.call("C2", "profiles/xl", 3)]);
    expect(h.log.find("warn", /^SKIP target=P seq=1 reason=disconnected — reconnect the device or remove it from scope "Desk"$/)).toHaveLength(1);
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
    expect(h.log.find("info", /^RECEIVE dev=P page=3 seq=1 origin=C1 late=true/)).toHaveLength(1);
  });

  test("F1b a switch that stalls past the TTL and lands after the parent's own flip is undone", async () => {
    const h = harness();
    await h.boot();
    await h.nav("C1", 1); // P#1, C2#1
    h.clock.advance(4000); // the app stalls on P
    expect(await h.cls(h.nav("P", 3))).toBe("SEND"); // C1#3, C2#3
    expect(h.sw.calls).toHaveLength(4);
    expect(await h.appear("P", 1)).toMatchObject({ classification: "RECEIVE_STALE", late: true }); // the stalled switch lands
    expect(h.sw.calls[4]).toEqual(h.call("P", "profiles/plus", 3));
    expect(await h.cls(h.appear("P", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C1", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([3, 3, 3]);
  });

  test("F2 a parent switch that never lands stops suppressing the child after the TTL, with a warning naming the profile", async () => {
    const h = harness();
    await h.boot();
    await h.nav("P", 2); // C1#4 (origin parent), never confirmed
    expect(await h.cls(h.nav("C1", 1))).toBe("SUPPRESSED");
    h.clock.advance(3001);
    expect(await h.cls(h.nav("C1", 3))).toBe("SEND");
    expect(h.log.find("warn", /^SWITCH unconfirmed dev=C1 profile=profiles\/mini page=4 seq=1 origin=P/)).toHaveLength(1);
    expect(h.state("C1").pending).toEqual([expect.objectContaining({ page: 4, expired: true })]);
    // an expired entry does not predict where the device is: a send to its page is issued again
    await h.appear("P", 3);
    await h.appear("C2", 3); // supersedes C2's own unconfirmed page-2 entry
    expect(await h.cls(h.nav("C2", 2))).toBe("SEND"); // → P#2, C1#4
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

  test("a stale entry's grace period and the per-device cap bound memory", async () => {
    const h = harness(deskScope(), { pendingTtlMs: 100, pendingGraceMs: 200, maxPendingPerDevice: 3 });
    await h.boot();
    for (const to of [1, 2, 3, 1, 2]) await h.nav("P", to);
    expect(h.pendingPages("C2")).toEqual([3, 1, 2]);
    expect(h.log.find("debug", /^GC dev=C2 .*reason=cap \(3 entries\)/)).toHaveLength(2);
    h.clock.advance(201);
    expect(await h.cls(h.nav("P", 4))).toBe("SEND");
    expect(h.pendingPages("C2")).toEqual([4]);
  });

  test("F26 a switch issued to a device before its first appear is recognized as an echo and arms it", async () => {
    const h = harness();
    h.engine.start(h.settings);
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
    h.engine.start(h.settings);
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
    expect(h.pendingPages("P")).toEqual([]);
    expect(h.log.find("debug", /reason=duplicate \(consumed seq=/)).toHaveLength(1);
  });

  test("F26 a failure inside the handler is logged, returns IGNORED, and leaves no half-recorded send", async () => {
    const h = harness();
    await h.boot();
    h.devices.throwOnGet = true;
    const out = await h.nav("P", 1);
    expect(out.classification).toBe("IGNORED");
    expect(h.log.find("error", /^UNEXPECTED handler=onAppear dev=P page=1 error="directory offline"/)).toHaveLength(1);
    expect(h.state("P").lastSendSeq).toBe(0);
    expect(h.sw.calls).toEqual([]);
  });
});
