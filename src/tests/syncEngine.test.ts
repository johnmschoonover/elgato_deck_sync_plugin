/**
 * PRD §7.3 AC [agent] (a)–(e), §7.6 logging, and the edge cases E1–E20 from
 * the engine design, against the pure SyncEngine with fake SDK dependencies.
 *
 * Fixture scope "desk": P (parent, Stream Deck +, profiles/plus), C1 (child,
 * Mini → profiles/mini), C2 (child, XL → profiles/xl); override P:2 ↔ C1:4.
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
  set(id: string, type: number, isConnected = true) { this.map.set(id, { id, name: `Deck ${id}`, type, isConnected }); }
  connect(id: string, isConnected: boolean) { this.map.get(id)!.isConnected = isConnected; }
  list = () => [...this.map.values()];
  get = (id: string) => this.map.get(id);
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

function harness(scope: Scope = deskScope(), options: EngineOptions = {}) {
  const sw = new FakeSwitcher();
  const clock = new FakeClock();
  const log = new MemoryLog();
  const devices = new FakeDevices();
  devices.set("P", 7);
  devices.set("C1", 1);
  devices.set("C2", 2);
  const settings = settingsWith(scope);
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
  const cls = async (p: Promise<Outcome>) => (await p).classification;
  return { engine, sw, clock, log, devices, settings, appear, leave, boot, state, pendingPages, page, cls };
}

describe("PRD §7.3 acceptance criteria", () => {
  test("(a) a plugin-issued arrival produces no outbound switch", async () => {
    const h = await (async () => { const h = harness(); await h.boot(); return h; })();
    expect(await h.cls(h.appear("P", 1))).toBe("SEND");
    expect(h.sw.calls).toEqual([{ deviceId: "C1", profile: "profiles/mini", page: 1 }, { deviceId: "C2", profile: "profiles/xl", page: 1 }]);
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
    const out = await h.appear("P", 2);
    expect(out.classification).toBe("SEND");
    expect(out.issued).toEqual([
      { deviceId: "C1", profile: "profiles/mini", page: 4, seq: 1 },
      { deviceId: "C2", profile: "profiles/xl", page: 2, seq: 1 },
    ]);
    expect(h.log.find("info", /^SEND dev=P role=parent scope=desk page=2 canonical=2 seq=1 targets=\[C1→profiles\/mini#4, C2→profiles\/xl#2\]$/)).toHaveLength(1);
    expect(await h.cls(h.appear("C1", 4))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 2))).toBe("RECEIVE");
    // the child leads back: C1 page 1 → parent 1, C2 1
    h.leave("C1", 4);
    expect(await h.cls(h.appear("C1", 1))).toBe("SEND");
    expect(h.sw.calls.slice(2)).toEqual([{ deviceId: "P", profile: "profiles/plus", page: 1 }, { deviceId: "C2", profile: "profiles/xl", page: 1 }]);
  });

  test("(c) a parent change overrides an in-flight child change", async () => {
    const h = harness();
    await h.boot();
    h.leave("C1", 0);
    expect(await h.cls(h.appear("C1", 3))).toBe("SEND"); // seq 1 → P#3, C2#3 (not landed yet)
    expect(h.sw.calls).toEqual([{ deviceId: "P", profile: "profiles/plus", page: 3 }, { deviceId: "C2", profile: "profiles/xl", page: 3 }]);
    h.leave("P", 0);
    const out = await h.appear("P", 1); // parent flips before the child's switch lands
    expect(out.classification).toBe("SEND"); // never suppressed
    expect(h.sw.calls.slice(2)).toEqual([
      { deviceId: "P", profile: "profiles/plus", page: 1 }, // re-asserts its own page behind the in-flight switch
      { deviceId: "C1", profile: "profiles/mini", page: 1 },
      { deviceId: "C2", profile: "profiles/xl", page: 1 },
    ]);
    for (const [dev, pg] of [["P", 3], ["P", 1], ["C1", 1], ["C2", 3], ["C2", 1]] as const) {
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
    h.leave("P", 0);
    const out = await h.appear("P", 2, { enabled: false });
    expect(out).toMatchObject({ classification: "IGNORED", reason: "disabled" });
    expect(h.sw.calls).toEqual([]);
    expect(h.page("P")).toBe(2);
    h.leave("C1", 0);
    expect(await h.cls(h.appear("C1", 3))).toBe("SEND");
    expect(await h.cls(h.appear("P", 3, { enabled: false }))).toBe("RECEIVE");
  });
});

describe("edge cases", () => {
  test("E1 echo matching is by (device, page); the profile is never compared", async () => {
    const h = harness(deskScope({ members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child", profile: "profiles/xl" }, { deviceId: "C2", role: "child" }] }));
    await h.boot();
    await h.appear("P", 1);
    expect(h.sw.calls[0]).toEqual({ deviceId: "C1", profile: "profiles/xl", page: 1 });
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
  });

  test("E2 a target already on the mapped page gets no switch, so nothing dangles", async () => {
    const h = harness();
    await h.boot();
    h.leave("C2", 0);
    await h.appear("C2", 1); // P#1, C1#1
    await h.appear("P", 1);
    await h.appear("C1", 1);
    h.leave("P", 1);
    const out = await h.appear("P", 1); // left page 1 and came straight back: a human navigation
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "already-there" }, { deviceId: "C2", reason: "already-there" }]);
    expect(h.sw.calls).toHaveLength(2);
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("E2/E19 an entry that never echoes is garbage-collected after the TTL and cannot swallow a later navigation", async () => {
    const h = harness();
    await h.boot();
    h.leave("C1", 0); // C1's page is now unknown (e.g. it sits on an un-anchored page)
    h.leave("P", 0);
    await h.appear("P", 3); // C1#3 issued because its page is unknown
    expect(h.pendingPages("C1")).toEqual([3]);
    await h.appear("C2", 3);
    h.clock.advance(3000);
    await h.appear("C2", 3, { actionId: "poke" }); // duplicate; only triggers expiry on C2
    expect(h.pendingPages("C1")).toEqual([3]); // not expired at exactly the TTL
    h.clock.advance(1);
    const out = await h.appear("C1", 3); // a human navigation to that very page, later
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "P", reason: "already-there" }, { deviceId: "C2", reason: "already-there" }]);
    expect(h.sw.calls).toHaveLength(2);
    expect(h.log.find("debug", /^GC dev=C1 page=3 seq=1 reason=expired/)).toHaveLength(1);
  });

  test("E3 several anchors on one page produce one SEND and consume one echo", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    expect(await h.cls(h.appear("P", 2, { actionId: "a" }))).toBe("SEND");
    expect((await h.appear("P", 2, { actionId: "b" })).reason).toBe("duplicate");
    expect(h.sw.calls).toHaveLength(2);
    expect(await h.cls(h.appear("C1", 4, { actionId: "x" }))).toBe("RECEIVE");
    expect((await h.appear("C1", 4, { actionId: "y" })).reason).toBe("duplicate");
    expect(h.sw.calls).toHaveLength(2);
  });

  test("E5 a reconnecting device's appears are startup; its pending switches are dropped", async () => {
    const h = harness();
    await h.boot();
    await h.appear("P", 1);
    expect(h.pendingPages("C1")).toEqual([1]);
    h.engine.onDeviceDisconnected("C1");
    expect(h.pendingPages("C1")).toEqual([]);
    h.engine.onDeviceConnected("C1");
    expect(await h.cls(h.appear("C1", 1))).toBe("STARTUP");
    expect(h.sw.calls).toHaveLength(2);
    h.leave("C1", 1);
    expect(await h.cls(h.appear("C1", 4))).toBe("SEND");
  });

  test("E6 rapid parent flips: children land in order, or coalesce, without ping-pong", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    await h.appear("P", 1);
    h.leave("P", 1);
    await h.appear("P", 3);
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
    for (const [from, to] of [[0, 1], [1, 3], [3, 1]]) { h.leave("P", from); await h.appear("P", to); }
    expect(h.sw.calls.filter((c) => c.deviceId === "C1").map((c) => c.page)).toEqual([1, 3, 1]);
    for (const pg of [1, 3, 1]) expect(await h.cls(h.appear("C1", pg))).toBe("RECEIVE");
    expect(h.page("C1")).toBe(1);
  });

  test("E7 a child flip while the parent's switch to it is in flight is suppressed; the parent's switch lands", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    await h.appear("P", 2); // C1#4 pending, origin parent
    h.leave("C1", 0);
    const out = await h.appear("C1", 1);
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
    h.leave("P", 0);
    await h.appear("P", 2);
    await h.appear("C1", 4);
    h.leave("C1", 4);
    expect(await h.cls(h.appear("C1", 1))).toBe("SEND");
    expect(h.sw.calls.slice(2)).toEqual([{ deviceId: "P", profile: "profiles/plus", page: 1 }, { deviceId: "C2", profile: "profiles/xl", page: 1 }]);
  });

  test("E8 a child SEND drives the parent and the other children (peer follow)", async () => {
    const h = harness();
    await h.boot();
    h.leave("C1", 0);
    const out = await h.appear("C1", 3);
    expect(out.classification).toBe("SEND");
    expect(h.sw.calls).toEqual([{ deviceId: "P", profile: "profiles/plus", page: 3 }, { deviceId: "C2", profile: "profiles/xl", page: 3 }]);
    expect(h.state("P").pending[0]).toMatchObject({ originId: "C1", originRole: "child" });
    expect(await h.cls(h.appear("P", 3))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 3))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(2);
  });

  test("E9 a rejected switch is logged at warn, its entry removed, and nothing throws", async () => {
    const h = harness();
    await h.boot();
    h.sw.failFor("C1", new Error("device not found"));
    h.leave("P", 0);
    const out = await h.appear("P", 2);
    expect(out.classification).toBe("SEND");
    expect(h.pendingPages("C1")).toEqual([]);
    expect(h.pendingPages("C2")).toEqual([2]);
    expect(h.log.find("warn", /^SWITCH failed dev=C1 profile=profiles\/mini page=4 seq=1 origin=P error="device not found"/)).toHaveLength(1);
    // a later human navigation of C1 to that page is not swallowed
    h.leave("C1", 0);
    expect(await h.cls(h.appear("C1", 4))).toBe("SEND");
  });

  test("E10 a settings change clears pending switches but keeps physical facts; a late landing re-syncs once", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    await h.appear("P", 2); // C1#4, C2#2 pending
    h.engine.onSettingsChanged(h.settings);
    for (const dev of ["C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([2, 0, 0]);
    expect(h.engine.snapshot().devices.every((d) => d.armed)).toBe(true);
    expect(h.log.find("info", /^SETTINGS applied \(update\) scopes=\[desk\{parent=P,children=2,overrides=1\}\] droppedPending=2$/)).toHaveLength(1);
    const out = await h.appear("C1", 4); // the cleared switch lands: classified human
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "P", reason: "already-there" }]);
    expect(h.sw.calls.slice(2)).toEqual([{ deviceId: "C2", profile: "profiles/xl", page: 2 }]);
    expect(await h.cls(h.appear("C2", 2))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(3);
  });

  test("E11 a disabled anchor consumes its echo and records the page, but never sends", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    await h.appear("P", 2);
    expect(await h.cls(h.appear("C1", 4, { enabled: false }))).toBe("RECEIVE");
    expect(h.page("C1")).toBe(4);
    h.leave("C1", 4);
    expect((await h.appear("C1", 3, { enabled: false })).reason).toBe("disabled");
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
    h.leave("X", 1);
    expect((await h.appear("X", 2)).reason).toBe("no-scope");
    h.leave("X", 2);
    expect((await h.appear("X", 3)).reason).toBe("no-scope");
    expect(h.log.find("info", /^IGNORED dev=X .*reason=no-scope/)).toHaveLength(1);
    expect(h.sw.calls).toEqual([]);
    const scope = deskScope();
    scope.members.push({ deviceId: "X", role: "child" });
    h.engine.onSettingsChanged(settingsWith(scope));
    h.leave("X", 3);
    expect(await h.cls(h.appear("X", 1))).toBe("SEND");
    expect(h.sw.calls.map((c) => c.deviceId)).toEqual(["P", "C1", "C2"]);
  });

  test("E14 no switch is issued toward a page the configuration says does not exist or is reserved", async () => {
    const h = harness(deskScope({
      members: [{ deviceId: "P", role: "parent", profile: "profiles/plus" }, { deviceId: "C1", role: "child" }, { deviceId: "C2", role: "child", pageCount: 3 }],
      mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 0 } }] },
    }));
    await h.boot();
    h.leave("P", 0);
    let out = await h.appear("P", 4); // C2 has only 3 pages
    expect(out.skipped).toEqual([{ deviceId: "C2", reason: "no-counterpart" }]);
    expect(h.sw.calls).toEqual([{ deviceId: "C1", profile: "profiles/mini", page: 4 }]);
    expect(h.log.find("info", /^SKIP target=C2 seq=1 reason=no-counterpart/)).toHaveLength(1);
    await h.appear("C1", 4);
    h.leave("P", 4);
    out = await h.appear("P", 0); // C1's page 0 is reserved for parent page 2
    expect(out.skipped).toEqual([{ deviceId: "C1", reason: "no-counterpart" }, { deviceId: "C2", reason: "already-there" }]);
    h.leave("C1", 4);
    out = await h.appear("C1", 2); // parent page 2 is reserved for C1's page 0: no canonical page
    expect(out.classification).toBe("SEND");
    expect(out.issued).toEqual([]);
    expect(out.skipped.map((s) => s.reason)).toEqual(["no-counterpart", "no-counterpart"]);
    expect(h.log.find("info", /^SEND dev=C1 role=child scope=desk page=2 canonical=none seq=3 targets=\[\]/)).toHaveLength(1);
  });

  test("E15 a peer's stale switch landing after this device's own send is swallowed and the page restored", async () => {
    const h = harness();
    await h.boot();
    h.leave("C2", 0);
    await h.appear("C2", 3); // seq 1: P#3, C1#3 (origin child)
    h.sw.failFor("C1", new Error("busy"), true); // the re-assert is lost
    h.leave("C1", 0);
    expect(await h.cls(h.appear("C1", 4))).toBe("SEND"); // seq 2: C1#4 (self, fails), P#2, C2#2
    expect(h.pendingPages("C1")).toEqual([3]);
    const out = await h.appear("C1", 3); // the stale switch lands
    expect(out).toMatchObject({ classification: "RECEIVE_STALE", seq: 1 });
    expect(h.sw.calls[h.sw.calls.length - 1]).toEqual({ deviceId: "C1", profile: "profiles/mini", page: 4 });
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
    h.leave("P", 0);
    expect(await h.cls(h.appear("P", 1))).toBe("SEND");
    h.leave("C1", 0);
    expect(await h.cls(h.appear("C1", 2))).toBe("SUPPRESSED");
    expect(await h.cls(h.appear("C1", 1))).toBe("RECEIVE");
    expect(await h.cls(h.appear("C2", 1))).toBe("RECEIVE");
    expect(h.sw.calls).toHaveLength(2);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
  });

  test("E16 cross-fire, child first: the parent is never suppressed and everyone ends on the parent's page", async () => {
    const h = harness();
    await h.boot();
    h.leave("C1", 0);
    expect(await h.cls(h.appear("C1", 3))).toBe("SEND"); // seq 1: P#3, C2#3
    h.leave("P", 0);
    expect(await h.cls(h.appear("P", 1))).toBe("SEND"); // seq 2: P#1 (self), C1#1, C2#1
    expect(h.sw.calls).toEqual([
      { deviceId: "P", profile: "profiles/plus", page: 3 },
      { deviceId: "C2", profile: "profiles/xl", page: 3 },
      { deviceId: "P", profile: "profiles/plus", page: 1 },
      { deviceId: "C1", profile: "profiles/mini", page: 1 },
      { deviceId: "C2", profile: "profiles/xl", page: 1 },
    ]);
    for (const [dev, pg] of [["P", 3], ["P", 1], ["C1", 1], ["C2", 3], ["C2", 1]] as const) {
      expect(await h.cls(h.appear(dev, pg))).toBe("RECEIVE");
    }
    expect(h.sw.calls).toHaveLength(5);
    expect([h.page("P"), h.page("C1"), h.page("C2")]).toEqual([1, 1, 1]);
    for (const dev of ["P", "C1", "C2"]) expect(h.pendingPages(dev)).toEqual([]);
  });

  test("E17 the source of a SEND only records its own page and send", async () => {
    const h = harness();
    await h.boot();
    h.leave("P", 0);
    await h.appear("P", 2);
    expect(h.state("P")).toMatchObject({ lastKnownPage: 2, pending: [], lastSendSeq: 1, lastSendPage: 2 });
    expect(h.sw.calls.some((c) => c.deviceId === "P")).toBe(false);
  });

  test("E18 a disconnected parent is skipped with a warning; connected children still follow", async () => {
    const h = harness();
    h.devices.connect("P", false);
    await h.boot(["C1", "C2"]);
    h.leave("C1", 0);
    const out = await h.appear("C1", 3);
    expect(out.skipped).toEqual([{ deviceId: "P", reason: "disconnected" }]);
    expect(h.sw.calls).toEqual([{ deviceId: "C2", profile: "profiles/xl", page: 3 }]);
    expect(h.log.find("warn", /^SKIP target=P seq=1 reason=disconnected — reconnect the device or remove it from scope "Desk"$/)).toHaveLength(1);
    h.devices.connect("P", true);
    h.engine.onDeviceConnected("P");
    expect(await h.cls(h.appear("P", 0))).toBe("STARTUP");
    expect(h.sw.calls).toHaveLength(1);
  });

  test("E19 the TTL is not a debounce: a late echo becomes a SEND that an aligned scope absorbs", async () => {
    const h = harness({ ...deskScope() }, { pendingTtlMs: 500 });
    await h.boot();
    h.leave("P", 0);
    await h.appear("P", 2); // C1#4, C2#2
    await h.appear("C2", 2);
    h.clock.advance(501);
    const out = await h.appear("C1", 4); // echo arrives after the TTL
    expect(out.classification).toBe("SEND");
    expect(out.skipped).toEqual([{ deviceId: "P", reason: "already-there" }, { deviceId: "C2", reason: "already-there" }]);
    expect(h.sw.calls).toHaveLength(2);
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
    h.leave("P", 0);
    const out = await h.appear("P", 1);
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
    h.leave("P", 0);
    const out = await h.appear("P", 1);
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
