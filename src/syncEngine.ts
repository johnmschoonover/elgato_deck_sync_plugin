/**
 * Sync engine — the causal send/receive rule (PRD §6.3), parent precedence,
 * the startup guard, mapping fan-out and logging (PRD §7.3, §7.6).
 *
 * Pure TypeScript: the Stream Deck SDK reaches it only through the small
 * interfaces below, so every rule is unit-testable (src/tests/syncEngine.test.ts).
 * Design notes: docs/SYNC_ENGINE.md.
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
 *   switch to it is still expected is SUPPRESSED; a parent's never is. A
 *   still-expected switch that lands on a device after that device's own
 *   later human navigation is stale: swallowed, and the device restored to
 *   the human's page — unless a later switch is already heading there.
 * - Time never classifies an appear. After `pendingTtlMs` an unconfirmed
 *   entry is marked expired: it no longer suppresses a child, counts as where
 *   the device will be, or triggers a restore, but it remains an echo tag,
 *   so a late landing is still a RECEIVE. Expired entries are dropped after
 *   `pendingGraceMs` (bounded memory), when a later switch to the device
 *   lands, or when the device disconnects.
 * - A send-storm breaker caps how often one device may SEND in a short
 *   window; it is a circuit breaker for misconfigured anchors, not a classifier.
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
  /** After this long without an appear a pending switch stops suppressing/predicting/restoring (default 3000 ms). */
  pendingTtlMs?: number;
  /** An expired entry stays an echo tag this long after it was issued (default 30000 ms). */
  pendingGraceMs?: number;
  /** Hard cap on entries kept per device (default 50). */
  maxPendingPerDevice?: number;
  /** More than this many SENDs from one device within `sendStormWindowMs` trips the breaker (default 6). */
  sendStormMax?: number;
  /** Window for the send-storm breaker (default 1500 ms). */
  sendStormWindowMs?: number;
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
export type IgnoreReason = "multi-action" | "no-page-index" | "duplicate" | "no-scope" | "disabled" | "send-storm";
export type SkipReason = "no-counterpart" | "disconnected" | "no-profile" | "already-there" | "error";

export type IssuedSwitch = { deviceId: string; profile: string; page: number; seq: number };
export type SkippedTarget = { deviceId: string; reason: SkipReason };

export type Outcome = {
  classification: Classification;
  reason?: IgnoreReason | "parent-in-flight";
  /** The SEND's sequence number, or the consumed entry's for RECEIVE*. */
  seq?: number;
  /** True when a RECEIVE matched an entry that had already expired (a late echo). */
  late?: boolean;
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
  /** Past the TTL (or detached by a settings change): an echo tag only. */
  expired: boolean;
};

type DeviceState = {
  id: string;
  /** False until the first appear after start/connect; such an appear is STARTUP. */
  armed: boolean;
  /** Set by a disconnect and cleared when an appear arms the device; a connect disarms only a device still flagged. */
  disconnected: boolean;
  /** The page the device is believed to show; null when unknown (left the page, reconnect). */
  lastKnownPage: number | null;
  /** Plugin-issued switches that have not landed, in issue order. */
  pending: Pending[];
  /** This device's most recent human navigation (SEND, or an ignored one it still chose). */
  lastHumanSeq: number;
  lastHumanPage: number | null;
  /** Timestamps of recent SENDs, for the storm breaker. */
  sendTimes: number[];
};

type Plan = IssuedSwitch & { settled: Promise<void> };

export type EngineSnapshot = {
  seq: number;
  devices: Array<Omit<DeviceState, "pending" | "sendTimes"> & { pending: Array<Omit<Pending, "issuedAt">> }>;
};

const ignored = (reason: IgnoreReason): Outcome => ({ classification: "IGNORED", reason, issued: [], skipped: [] });
const fresh = (dev: DeviceState): Pending[] => dev.pending.filter((p) => !p.expired);

export class SyncEngine {
  private settings: GlobalSettings = createDefaultGlobalSettings();
  private readonly devices = new Map<string, DeviceState>();
  private seq = 0;
  private readonly warnedNoPage = new Set<string>();
  private readonly notedNoScope = new Set<string>();
  private readonly ttl: number;
  private readonly grace: number;
  private readonly cap: number;
  private readonly stormMax: number;
  private readonly stormWindow: number;
  private readonly log: Log;

  constructor(private readonly deps: EngineDeps, options: EngineOptions = {}) {
    this.ttl = options.pendingTtlMs ?? 3000;
    this.grace = Math.max(options.pendingGraceMs ?? 30000, this.ttl);
    this.cap = options.maxPendingPerDevice ?? 50;
    this.stormMax = options.sendStormMax ?? 6;
    this.stormWindow = options.sendStormWindowMs ?? 1500;
    this.log = deps.log;
  }

  /* ---------------- lifecycle ---------------- */

  /** Call once after the plugin connects. Never issues a switch. */
  start(settings: GlobalSettings): void {
    for (const d of this.deps.devices.list()) this.device(d.id);
    this.applySettings(settings, "start");
    this.log.info(`START devices=[${[...this.devices.keys()].join(",")}] scopes=${this.settings.scopes.length} ttlMs=${this.ttl} graceMs=${this.grace}`);
  }

  /** Validated settings from the PI or the global-settings event. */
  onSettingsChanged(settings: GlobalSettings): void {
    this.applySettings(settings, "update");
  }

  private applySettings(settings: GlobalSettings, why: "start" | "update"): void {
    // The global-settings event also fires for plain reads (e.g. when the PI opens).
    if (JSON.stringify(settings) === JSON.stringify(this.settings)) {
      this.log.debug(`SETTINGS unchanged (${why}); keeping state`);
      return;
    }
    this.settings = settings;
    this.notedNoScope.clear();
    // Switches in flight were issued under the old topology: their origins no longer mean
    // anything (no suppression, no prediction), but they remain echo tags so their landings
    // can never be mistaken for human navigation.
    let detached = 0;
    for (const dev of this.devices.values()) {
      for (const p of dev.pending) {
        if (!p.expired) {
          p.expired = true;
          detached++;
        }
      }
    }
    const scopes = settings.scopes
      .map((s) => `${s.id}{parent=${s.parentDeviceId},children=${s.members.length - 1},overrides=${s.mapping.overrides.length}}`)
      .join(" ");
    this.log.info(`SETTINGS applied (${why}) scopes=[${scopes}] detachedPending=${detached}`);
  }

  onDeviceConnected(deviceId: string): void {
    const dev = this.device(deviceId);
    // The app may announce devices it already showed us (at launch, or after a reconnect
    // whose appears arrived first); only a device still flagged as disconnected, or never
    // seen, is disarmed so its next appears count as startup.
    if (dev.armed && !dev.disconnected) {
      this.log.debug(`DEVICE connected dev=${deviceId} (already armed; no change)`);
      return;
    }
    dev.armed = false;
    dev.disconnected = false;
    this.log.info(`DEVICE connected dev=${deviceId} (disarmed until its first appear)`);
  }

  onDeviceDisconnected(deviceId: string): void {
    const dev = this.device(deviceId);
    const dropped = dev.pending.length;
    dev.armed = false;
    dev.disconnected = true;
    dev.lastKnownPage = null; // it may come back on another page
    dev.pending = []; // nothing can land on an absent device
    this.log.info(`DEVICE disconnected dev=${deviceId} droppedPending=${dropped}; it is skipped by its scope until it reconnects`);
  }

  /** JSON-safe view for tests and diagnostics. */
  snapshot(): EngineSnapshot {
    return {
      seq: this.seq,
      devices: [...this.devices.values()].map(({ sendTimes: _ignored, ...d }) => ({
        ...d,
        pending: d.pending.map(({ seq, page, profile, originId, originRole, expired }) => ({ seq, page, profile, originId, originRole, expired })),
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
      this.arm(dev, page);
      return this.receive(dev, page, entry);
    }

    // 5. Startup / reconnect guard (PRD §4.4): record the page, arm, never sync.
    if (!dev.armed) {
      this.arm(dev, page);
      this.log.info(`STARTUP dev=${dev.id} page=${page} (armed; no sync)`);
      return { classification: "STARTUP", issued: [], skipped: [] };
    }

    // From here on this is human navigation. Record the physical fact first.
    dev.lastKnownPage = page;

    // 6. Scope membership.
    const scope = findScopeForDevice(this.settings, dev.id);
    if (!scope) {
      this.recordHuman(dev, page);
      if (!this.notedNoScope.has(dev.id)) {
        this.notedNoScope.add(dev.id);
        this.log.warn(`IGNORED dev=${dev.id} page=${page} reason=no-scope — this device has a Page Anchor but is not in any scope; assign it in the Page Anchor Property Inspector`);
      } else {
        this.log.debug(`IGNORED dev=${dev.id} page=${page} reason=no-scope`);
      }
      return ignored("no-scope");
    }
    const member = scope.members.find((m) => m.deviceId === dev.id)!;

    // 7. Disabled marker (PRD §7.3): the human still chose this page.
    if (!ev.enabled) {
      this.recordHuman(dev, page);
      this.log.info(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} reason=disabled`);
      return ignored("disabled");
    }

    // 8. Parent precedence (PRD §6.3.3): a child may not lead while the parent's switch to it is still expected.
    //    The suppressed navigation is discarded, so it is not recorded as the human's page.
    if (member.role === "child") {
      const parentSwitch = fresh(dev).find((p) => p.originRole === "parent");
      if (parentSwitch) {
        this.log.info(`SUPPRESSED dev=${dev.id} page=${page} scope=${scope.id} reason=parent-in-flight pending=[page=${parentSwitch.page} seq=${parentSwitch.seq}] (parent wins; its switch will land)`);
        return { classification: "SUPPRESSED", reason: "parent-in-flight", issued: [], skipped: [] };
      }
    }

    // 9. Send-storm breaker: a device cannot humanly navigate this fast; stray anchors with a wrong page
    //    index on a page it was just switched to can, and two devices would then drive each other forever.
    const now = this.deps.clock.now();
    dev.sendTimes = dev.sendTimes.filter((t) => now - t <= this.stormWindow);
    if (dev.sendTimes.length >= this.stormMax) {
      this.log.warn(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} action=${ev.actionId} reason=send-storm — ${dev.sendTimes.length} sends in ${this.stormWindow}ms; check this device's pages for a Page Anchor with the wrong page index`);
      return ignored("send-storm");
    }
    dev.sendTimes.push(now);

    // 10. SEND.
    return this.send(dev, scope, member, page);
  }

  private arm(dev: DeviceState, page: number): void {
    dev.armed = true;
    dev.disconnected = false;
    dev.lastKnownPage = page;
  }

  private recordHuman(dev: DeviceState, page: number): void {
    dev.lastHumanSeq = ++this.seq;
    dev.lastHumanPage = page;
  }

  private async receive(dev: DeviceState, page: number, entry: Pending): Promise<Outcome> {
    const late = entry.expired;
    const expected = fresh(dev);
    // Stale: a still-expected switch issued before this device's own later human navigation has
    // landed on it, and nothing issued after that navigation is heading for the device (a later
    // switch wins). A late (expired) match never restores: it may be the human flipping to a page
    // the engine once sent the device to, and fighting that would be worse than one missed sync.
    const stale =
      !late &&
      entry.seq < dev.lastHumanSeq &&
      dev.lastHumanPage !== null &&
      dev.lastHumanPage !== page &&
      !expected.some((p) => p.seq > dev.lastHumanSeq);
    if (!stale) {
      this.log.info(`RECEIVE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId}${late ? " late=true" : ""} (echo consumed; no rebroadcast)`);
      return { classification: "RECEIVE", seq: entry.seq, late, issued: [], skipped: [] };
    }
    const restorePage = dev.lastHumanPage as number;
    const seq = ++this.seq;
    this.log.info(`RECEIVE_STALE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId} landed after this device's own navigation seq=${dev.lastHumanSeq}; restoring page=${restorePage} seq=${seq}`);
    const profile = this.profileFor(dev.id);
    if (!profile) {
      this.log.warn(`RESTORE skipped dev=${dev.id} seq=${seq} reason=no-profile — set a profile for this device in the Page Anchor Property Inspector`);
      return { classification: "RECEIVE_STALE", seq: entry.seq, late, issued: [], skipped: [{ deviceId: dev.id, reason: "no-profile" }] };
    }
    const plan = this.issue(dev, profile, restorePage, dev.id, "self", seq);
    await plan.settled;
    return { classification: "RECEIVE_STALE", seq: entry.seq, late, issued: [toIssued(plan)], skipped: [] };
  }

  private async send(dev: DeviceState, scope: Scope, member: ScopeMember, page: number): Promise<Outcome> {
    const seq = ++this.seq;
    const plans: Plan[] = [];
    const skipped: SkippedTarget[] = [];
    const from = { deviceId: dev.id, page };

    for (const { member: target, page: targetPage } of resolveTargets(scope, from)) {
      try {
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
        // Where the device will be once the switches still expected to land have landed; an
        // aligned target gets no switch (there would be nothing to echo).
        const expected = fresh(state);
        const willShow = expected.length ? expected[expected.length - 1].page : state.lastKnownPage;
        if (willShow === targetPage) {
          skipped.push({ deviceId: target.deviceId, reason: "already-there" });
          continue;
        }
        plans.push(this.issue(state, profile, targetPage, dev.id, member.role, seq));
      } catch (err) {
        // One bad target must not stop the others; the SEND is still recorded.
        skipped.push({ deviceId: target.deviceId, reason: "error" });
        this.log.warn(`SKIP target=${target.deviceId} seq=${seq} reason=error error="${describeError(err)}"`);
      }
    }

    // The human's navigation is recorded once the fan-out is planned.
    dev.lastHumanSeq = seq;
    dev.lastHumanPage = page;

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
        this.log.warn(`SKIP target=${s.deviceId} seq=${seq} reason=disconnected — the app has not reported the device as connected; reconnect it or remove it from scope "${scope.name}"`);
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
      case "error":
        break; // logged where it happened
    }
  }

  /** Records the switch, then issues it. The entry exists before the call so an echo can never beat it. */
  private issue(target: DeviceState, profile: string, page: number, originId: string, originRole: Origin, seq: number): Plan {
    const entry: Pending = { seq, page, profile, originId, originRole, issuedAt: this.deps.clock.now(), expired: false };
    target.pending.push(entry);
    while (target.pending.length > this.cap) {
      const dropped = target.pending.shift()!;
      this.log.debug(`GC dev=${target.id} page=${dropped.page} seq=${dropped.seq} reason=cap (${this.cap} entries)`);
    }
    const settled = Promise.resolve()
      .then(() => this.deps.switcher.switchToProfile(target.id, profile, page))
      .then(
        // The SDK resolves once the request is written; the landing is confirmed by the RECEIVE line.
        () => this.log.debug(`SWITCH sent dev=${target.id} profile=${profile} page=${page} seq=${seq} origin=${originId}`),
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

  /**
   * Ages pending entries. Past the TTL an entry is marked expired (warn: the switch was not
   * confirmed) but kept as an echo tag; past the grace period it is dropped. Never consulted
   * to classify an appear.
   */
  private expire(dev: DeviceState): void {
    if (!dev.pending.length) return;
    const now = this.deps.clock.now();
    const keep: Pending[] = [];
    for (const p of dev.pending) {
      const age = now - p.issuedAt;
      if (age > this.grace) {
        this.log.debug(`GC dev=${dev.id} page=${p.page} seq=${p.seq} reason=grace-elapsed (${this.grace}ms without an appear)`);
        continue;
      }
      if (!p.expired && age > this.ttl) {
        p.expired = true;
        this.log.warn(`SWITCH unconfirmed dev=${dev.id} profile=${p.profile} page=${p.page} seq=${p.seq} origin=${p.originId} — no appear within ${this.ttl}ms: the device may already have been on that page, the page may have no Page Anchor, or "${p.profile}" may not be bundled`);
      }
      keep.push(p);
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
      dev = { id, armed: false, disconnected: false, lastKnownPage: null, pending: [], lastHumanSeq: 0, lastHumanPage: null, sendTimes: [] };
      this.devices.set(id, dev);
    }
    return dev;
  }
}

const toIssued = ({ deviceId, profile, page, seq }: Plan): IssuedSwitch => ({ deviceId, profile, page, seq });
