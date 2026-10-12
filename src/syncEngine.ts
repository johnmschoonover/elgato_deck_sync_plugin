/**
 * Sync engine — the causal send/receive rule (PRD §6.3), parent precedence,
 * the startup guard, mapping fan-out and logging (PRD §7.3, §7.6).
 *
 * Pure TypeScript: the Stream Deck SDK reaches it only through the small
 * interfaces below, so every rule is unit-testable (src/tests/syncEngine.test.ts).
 *
 * The model:
 *
 * - Every `switchToProfile` the engine issues is recorded first, per target
 *   device, in issue order (`pending`). An appear whose page matches the
 *   earliest pending entry for that device is a RECEIVE: terminal, never
 *   rebroadcast. Entries issued before the match are dropped as superseded
 *   (the app showed only the last of several rapid switches).
 * - Any other appear on an armed device is human navigation → SEND to the
 *   rest of its scope, mapped through the parent's page (src/mapping.ts).
 * - Devices start un-armed; the first appear after plugin start or device
 *   (re)connect arms the device and never syncs (PRD §4.4). No settle window.
 * - Parent precedence: a child's human navigation while a parent-issued
 *   switch to it is still pending is SUPPRESSED; a parent's never is. A switch
 *   that lands on a device after that device's own later SEND is stale: it is
 *   swallowed and the device restored to its human page, and a SEND from a
 *   device with switches still heading for it re-asserts its page, so the
 *   human's choice outlives anything in flight.
 * - Time is used only to garbage-collect pending entries that can never echo
 *   (the device was already on that page); it never classifies an appear.
 */
import { resolveTargets, toCanonical } from "./mapping";
import type { Log } from "./log";
import { describeError } from "./log";
import { resolveProfile } from "./profiles";
import { createDefaultGlobalSettings, findScopeForDevice, type DeviceRole, type GlobalSettings, type Scope, type ScopeMember } from "./settings";

/* ---------------- injected dependencies ---------------- */

export interface Switcher {
  switchToProfile(deviceId: string, profile: string, page: number): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  /** `DeviceType` value. */
  type: number;
  isConnected: boolean;
}

export interface DeviceDirectory {
  list(): Iterable<DeviceInfo>;
  get(id: string): DeviceInfo | undefined;
}

export type EngineDeps = { switcher: Switcher; clock: Clock; log: Log; devices: DeviceDirectory };

export type EngineOptions = {
  /** How long a pending switch may wait for its appear before it is garbage-collected. Default 3000. */
  pendingTtlMs?: number;
};

/* ---------------- events in, outcomes out ---------------- */

export type AppearInput = {
  deviceId: string;
  /** The action instance id; several anchors may sit on one page. */
  actionId: string;
  /** Normalized page index (src/settings.ts normalizeAnchorSettings); undefined = not configured. */
  pageIndex: number | undefined;
  enabled: boolean;
  isInMultiAction: boolean;
};

export type DisappearInput = Omit<AppearInput, "enabled">;

export type Classification = "SEND" | "RECEIVE" | "RECEIVE_STALE" | "STARTUP" | "SUPPRESSED" | "IGNORED";
export type IgnoreReason = "multi-action" | "no-page-index" | "duplicate" | "no-scope" | "disabled";
export type SkipReason = "no-counterpart" | "disconnected" | "no-profile" | "already-there";

export type IssuedSwitch = { deviceId: string; profile: string; page: number; seq: number };
export type SkippedTarget = { deviceId: string; reason: SkipReason };

export type Outcome = {
  classification: Classification;
  reason?: IgnoreReason | "parent-in-flight";
  /** The SEND's sequence number, or the consumed entry's for RECEIVE*. */
  seq?: number;
  issued: IssuedSwitch[];
  skipped: SkippedTarget[];
};

/* ---------------- runtime state ---------------- */

type Origin = DeviceRole | "self";

type Pending = {
  seq: number;
  page: number;
  profile: string;
  originId: string;
  originRole: Origin;
  issuedAt: number;
};

type DeviceState = {
  id: string;
  /** False until the first appear after start/connect; such an appear is STARTUP. */
  armed: boolean;
  /** The page the device is believed to show; null when unknown (left the page, reconnect). */
  lastKnownPage: number | null;
  /** Plugin-issued switches that have not landed, in issue order. */
  pending: Pending[];
  /** This device's most recent human SEND. */
  lastSendSeq: number;
  lastSendPage: number | null;
};

type Plan = IssuedSwitch & { settled: Promise<void> };

export type EngineSnapshot = {
  seq: number;
  devices: Array<Omit<DeviceState, "pending"> & { pending: Array<Omit<Pending, "issuedAt">> }>;
};

const ignored = (reason: IgnoreReason): Outcome => ({ classification: "IGNORED", reason, issued: [], skipped: [] });

export class SyncEngine {
  private settings: GlobalSettings = createDefaultGlobalSettings();
  private readonly devices = new Map<string, DeviceState>();
  private seq = 0;
  private readonly warnedNoPage = new Set<string>();
  private readonly notedNoScope = new Set<string>();
  private readonly ttl: number;
  private readonly log: Log;

  constructor(private readonly deps: EngineDeps, options: EngineOptions = {}) {
    this.ttl = options.pendingTtlMs ?? 3000;
    this.log = deps.log;
  }

  /* ---------------- lifecycle ---------------- */

  /** Call once after the plugin connects. Never issues a switch. */
  start(settings: GlobalSettings): void {
    for (const d of this.deps.devices.list()) this.device(d.id);
    this.applySettings(settings, "start");
    this.log.info(`START devices=[${[...this.devices.keys()].join(",")}] scopes=${this.settings.scopes.length} ttlMs=${this.ttl}`);
  }

  /** Validated settings from the PI or the global-settings event. */
  onSettingsChanged(settings: GlobalSettings): void {
    this.applySettings(settings, "update");
  }

  private applySettings(settings: GlobalSettings, why: "start" | "update"): void {
    // The global-settings event also fires for plain reads (e.g. when the PI opens); a
    // reload that changes nothing must not drop switches in flight.
    if (why === "update" && JSON.stringify(settings) === JSON.stringify(this.settings)) {
      this.log.debug("SETTINGS unchanged; keeping state");
      return;
    }
    this.settings = settings;
    this.notedNoScope.clear();
    // Pending switches were issued under the old topology; their origins mean nothing now.
    let dropped = 0;
    for (const dev of this.devices.values()) {
      dropped += dev.pending.length;
      dev.pending = [];
    }
    const scopes = settings.scopes
      .map((s) => `${s.id}{parent=${s.parentDeviceId},children=${s.members.length - 1},overrides=${s.mapping.overrides.length}}`)
      .join(" ");
    this.log.info(`SETTINGS applied (${why}) scopes=[${scopes}] droppedPending=${dropped}`);
  }

  onDeviceConnected(deviceId: string): void {
    const dev = this.device(deviceId);
    dev.armed = false; // its (re)connect appears are STARTUP
    this.log.info(`DEVICE connected dev=${deviceId} (disarmed until its first appear)`);
  }

  onDeviceDisconnected(deviceId: string): void {
    const dev = this.device(deviceId);
    const dropped = dev.pending.length;
    dev.armed = false;
    dev.lastKnownPage = null; // it may come back on another page
    dev.pending = []; // nothing can land on an absent device
    this.log.info(`DEVICE disconnected dev=${deviceId} droppedPending=${dropped}; it is skipped by its scope until it reconnects`);
  }

  /** JSON-safe view for tests and diagnostics. */
  snapshot(): EngineSnapshot {
    return {
      seq: this.seq,
      devices: [...this.devices.values()].map((d) => ({
        ...d,
        pending: d.pending.map(({ seq, page, profile, originId, originRole }) => ({ seq, page, profile, originId, originRole })),
      })),
    };
  }

  /* ---------------- page events ---------------- */

  /** A Page Anchor stopped being visible: the device left that page. */
  onDisappear(ev: DisappearInput): void {
    if (ev.isInMultiAction || ev.pageIndex === undefined) return;
    const dev = this.devices.get(ev.deviceId);
    if (!dev) return;
    // Only when the engine still believes the device is there, so appear(new)/disappear(old) order does not matter.
    if (dev.lastKnownPage === ev.pageIndex) {
      dev.lastKnownPage = null;
      this.log.debug(`LEAVE dev=${dev.id} page=${ev.pageIndex}`);
    }
  }

  /** A Page Anchor became visible. Resolves once any switches it issued have been acknowledged or rejected. */
  async onAppear(ev: AppearInput): Promise<Outcome> {
    try {
      return await this.classify(ev);
    } catch (err) {
      this.log.error(`UNEXPECTED handler=onAppear dev=${ev.deviceId} page=${ev.pageIndex} error="${describeError(err)}"`);
      return { classification: "IGNORED", issued: [], skipped: [] };
    }
  }

  private async classify(ev: AppearInput): Promise<Outcome> {
    // 1. Anchors inside multi-actions are not page markers.
    if (ev.isInMultiAction) {
      this.log.debug(`IGNORED dev=${ev.deviceId} page=${ev.pageIndex} action=${ev.actionId} reason=multi-action`);
      return ignored("multi-action");
    }
    // 2. No page identity: nothing to classify. Warn once per anchor.
    if (ev.pageIndex === undefined) {
      if (!this.warnedNoPage.has(ev.actionId)) {
        this.warnedNoPage.add(ev.actionId);
        this.log.warn(`IGNORED dev=${ev.deviceId} action=${ev.actionId} reason=no-page-index — open this Page Anchor's Property Inspector and set its page index`);
      } else {
        this.log.debug(`IGNORED dev=${ev.deviceId} action=${ev.actionId} reason=no-page-index`);
      }
      return ignored("no-page-index");
    }

    const page = ev.pageIndex;
    const dev = this.device(ev.deviceId);
    this.expire(dev);

    // 3. The device is already known to be on this page: a second anchor on the page or a re-emit.
    if (dev.lastKnownPage === page) {
      const consumed = this.consume(dev, page);
      this.log.debug(`IGNORED dev=${dev.id} page=${page} action=${ev.actionId} reason=duplicate${consumed ? ` (consumed seq=${consumed.seq})` : ""}`);
      return ignored("duplicate");
    }

    // 4. Echo of a switch the engine issued → RECEIVE, terminal. Checked before the startup guard so a
    //    switch issued to a device before its first appear is still recognized.
    const entry = this.consume(dev, page);
    if (entry) {
      dev.armed = true;
      dev.lastKnownPage = page;
      return this.receive(dev, page, entry);
    }

    // 5. Startup / reconnect guard (PRD §4.4): record the page, arm, never sync.
    if (!dev.armed) {
      dev.armed = true;
      dev.lastKnownPage = page;
      this.log.info(`STARTUP dev=${dev.id} page=${page} (armed; no sync)`);
      return { classification: "STARTUP", issued: [], skipped: [] };
    }

    // From here on this is human navigation. Record the physical fact first.
    dev.lastKnownPage = page;

    // 6. Scope membership.
    const scope = findScopeForDevice(this.settings, dev.id);
    if (!scope) {
      if (!this.notedNoScope.has(dev.id)) {
        this.notedNoScope.add(dev.id);
        this.log.info(`IGNORED dev=${dev.id} page=${page} reason=no-scope — this device has a Page Anchor but is not in any scope; assign it in the Page Anchor Property Inspector`);
      } else {
        this.log.debug(`IGNORED dev=${dev.id} page=${page} reason=no-scope`);
      }
      return ignored("no-scope");
    }
    const member = scope.members.find((m) => m.deviceId === dev.id)!;

    // 7. Disabled marker (PRD §7.3).
    if (!ev.enabled) {
      this.log.info(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} reason=disabled`);
      return ignored("disabled");
    }

    // 8. Parent precedence (PRD §6.3.3): a child may not lead while the parent's switch to it is still landing.
    if (member.role === "child") {
      const parentSwitch = dev.pending.find((p) => p.originRole === "parent");
      if (parentSwitch) {
        this.log.info(`SUPPRESSED dev=${dev.id} page=${page} scope=${scope.id} reason=parent-in-flight pending=[page=${parentSwitch.page} seq=${parentSwitch.seq}] (parent wins; its switch will land)`);
        return { classification: "SUPPRESSED", reason: "parent-in-flight", issued: [], skipped: [] };
      }
    }

    // 9. SEND.
    return this.send(dev, scope, member, page);
  }

  private async receive(dev: DeviceState, page: number, entry: Pending): Promise<Outcome> {
    const stale =
      entry.seq < dev.lastSendSeq &&
      dev.lastSendPage !== null &&
      dev.lastSendPage !== page &&
      !dev.pending.some((p) => p.page === dev.lastSendPage);
    if (!stale) {
      this.log.info(`RECEIVE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId} (echo consumed; no rebroadcast)`);
      return { classification: "RECEIVE", seq: entry.seq, issued: [], skipped: [] };
    }
    // The switch landed after this device's own later SEND: swallow it and restore the human's page.
    const restorePage = dev.lastSendPage as number;
    const seq = ++this.seq;
    this.log.info(`RECEIVE_STALE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId} landed after this device's own send seq=${dev.lastSendSeq}; restoring page=${restorePage} seq=${seq}`);
    const profile = this.profileFor(dev.id);
    if (!profile) {
      this.log.warn(`RESTORE skipped dev=${dev.id} seq=${seq} reason=no-profile — set a profile for this device in the Page Anchor Property Inspector`);
      return { classification: "RECEIVE_STALE", seq: entry.seq, issued: [], skipped: [{ deviceId: dev.id, reason: "no-profile" }] };
    }
    const plan = this.issue(dev, profile, restorePage, dev.id, "self", seq);
    await plan.settled;
    return { classification: "RECEIVE_STALE", seq: entry.seq, issued: [toIssued(plan)], skipped: [] };
  }

  private async send(dev: DeviceState, scope: Scope, member: ScopeMember, page: number): Promise<Outcome> {
    const seq = ++this.seq;
    dev.lastSendSeq = seq;
    dev.lastSendPage = page;
    const plans: Plan[] = [];
    const skipped: SkippedTarget[] = [];

    // Switches still heading for this device must not outlive the human's choice: re-assert it last.
    if (dev.pending.length > 0) {
      const profile = this.profileFor(dev.id);
      if (profile) plans.push(this.issue(dev, profile, page, dev.id, "self", seq));
      else skipped.push({ deviceId: dev.id, reason: "no-profile" });
    }

    const from = { deviceId: dev.id, page };
    for (const { member: target, page: targetPage } of resolveTargets(scope, from)) {
      if (targetPage === undefined) {
        skipped.push({ deviceId: target.deviceId, reason: "no-counterpart" });
        continue;
      }
      const info = this.deps.devices.get(target.deviceId);
      if (!info || !info.isConnected) {
        skipped.push({ deviceId: target.deviceId, reason: "disconnected" });
        continue;
      }
      const profile = resolveProfile(target.profile, info.type);
      if (!profile) {
        skipped.push({ deviceId: target.deviceId, reason: "no-profile" });
        continue;
      }
      const state = this.device(target.deviceId);
      this.expire(state);
      // What the device will show once its queue drains; an aligned target gets no switch (nothing to echo).
      const willShow = state.pending.length ? state.pending[state.pending.length - 1].page : state.lastKnownPage;
      if (willShow === targetPage) {
        skipped.push({ deviceId: target.deviceId, reason: "already-there" });
        continue;
      }
      plans.push(this.issue(state, profile, targetPage, dev.id, member.role, seq));
    }

    const canonical = toCanonical(scope, from);
    const targets = plans.map((p) => `${p.deviceId}→${p.profile}#${p.page}`).join(", ");
    const skips = skipped.length ? ` skipped=[${skipped.map((s) => `${s.deviceId}:${s.reason}`).join(", ")}]` : "";
    this.log.info(`SEND dev=${dev.id} role=${member.role} scope=${scope.id} page=${page} canonical=${canonical ?? "none"} seq=${seq} targets=[${targets}]${skips}`);
    for (const s of skipped) this.logSkip(scope, seq, s);

    await Promise.all(plans.map((p) => p.settled));
    return { classification: "SEND", seq, issued: plans.map(toIssued), skipped };
  }

  private logSkip(scope: Scope, seq: number, s: SkippedTarget): void {
    switch (s.reason) {
      case "disconnected":
        this.log.warn(`SKIP target=${s.deviceId} seq=${seq} reason=disconnected — reconnect the device or remove it from scope "${scope.name}"`);
        break;
      case "no-profile":
        this.log.warn(`SKIP target=${s.deviceId} seq=${seq} reason=no-profile — set a profile for this device in the Page Anchor Property Inspector`);
        break;
      case "no-counterpart":
        this.log.info(`SKIP target=${s.deviceId} seq=${seq} reason=no-counterpart (no page maps to this one)`);
        break;
      case "already-there":
        this.log.debug(`SKIP target=${s.deviceId} seq=${seq} reason=already-there`);
        break;
    }
  }

  /** Records the switch, then issues it. The entry exists before the call so an echo can never beat it. */
  private issue(target: DeviceState, profile: string, page: number, originId: string, originRole: Origin, seq: number): Plan {
    const entry: Pending = { seq, page, profile, originId, originRole, issuedAt: this.deps.clock.now() };
    target.pending.push(entry);
    const settled = Promise.resolve()
      .then(() => this.deps.switcher.switchToProfile(target.id, profile, page))
      .then(
        () => this.log.debug(`SWITCH ok dev=${target.id} profile=${profile} page=${page} seq=${seq} origin=${originId}`),
        (err: unknown) => {
          const i = target.pending.indexOf(entry);
          if (i >= 0) target.pending.splice(i, 1);
          this.log.warn(`SWITCH failed dev=${target.id} profile=${profile} page=${page} seq=${seq} origin=${originId} error="${describeError(err)}" — check the device is connected and "${profile}" is listed in manifest Profiles`);
        }
      );
    return { deviceId: target.id, profile, page, seq, settled };
  }

  /** Consumes the earliest pending entry for `page`; entries issued before it were superseded. */
  private consume(dev: DeviceState, page: number): Pending | undefined {
    const i = dev.pending.findIndex((p) => p.page === page);
    if (i < 0) return undefined;
    const superseded = dev.pending.splice(0, i);
    const entry = dev.pending.shift()!;
    for (const s of superseded) this.log.debug(`GC dev=${dev.id} page=${s.page} seq=${s.seq} reason=superseded by seq=${entry.seq}`);
    return entry;
  }

  /** Drops entries that never echoed (the device was already on that page). Never consulted for classification. */
  private expire(dev: DeviceState): void {
    if (!dev.pending.length) return;
    const now = this.deps.clock.now();
    const keep: Pending[] = [];
    for (const p of dev.pending) {
      if (now - p.issuedAt > this.ttl) {
        this.log.debug(`GC dev=${dev.id} page=${p.page} seq=${p.seq} reason=expired (no appear within ${this.ttl}ms; is there a Page Anchor on that page?)`);
      } else {
        keep.push(p);
      }
    }
    dev.pending = keep;
  }

  private profileFor(deviceId: string): string | undefined {
    const member = findScopeForDevice(this.settings, deviceId)?.members.find((m) => m.deviceId === deviceId);
    return resolveProfile(member?.profile, this.deps.devices.get(deviceId)?.type);
  }

  private device(id: string): DeviceState {
    let dev = this.devices.get(id);
    if (!dev) {
      dev = { id, armed: false, lastKnownPage: null, pending: [], lastSendSeq: 0, lastSendPage: null };
      this.devices.set(id, dev);
    }
    return dev;
  }
}

const toIssued = ({ deviceId, profile, page, seq }: Plan): IssuedSwitch => ({ deviceId, profile, page, seq });
