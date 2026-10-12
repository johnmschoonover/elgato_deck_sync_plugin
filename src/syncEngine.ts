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
 *   Human navigation that arrives before `start()` is queued; once the
 *   settings are known the newest navigation in each scope is replayed (nothing
 *   was in flight, so they never conflicted) and the others only record where
 *   their device is.
 * - Parent precedence: a child's human navigation while a parent-issued
 *   switch to it is still expected is SUPPRESSED (even on a disabled page);
 *   a parent's never is. A still-expected switch that lands on a device
 *   after that device's own later human navigation is stale: swallowed, and
 *   the device restored to the human's page — unless a later switch is
 *   already heading there.
 * - Time never decides between SEND and RECEIVE. After `pendingTtlMs` an
 *   unconfirmed entry is marked expired: it no longer suppresses a child,
 *   counts as where the device will be, or triggers a restore, but it remains
 *   an echo tag, so a late landing is still a RECEIVE. A fresh entry for the
 *   same page always matches before an expired one. Expired entries are
 *   dropped after `pendingGraceMs`, when a later switch to the device lands,
 *   or when the device disconnects; one expired tag per page is kept, and past
 *   `maxPendingPerDevice` still-expected entries become tags too, so memory is
 *   bounded without ever forgetting that a switch was issued.
 * - A conflicting-anchor breaker: a SEND that follows a RECEIVE on the same
 *   page visit is "driven" — the signature of a copied anchor with the wrong
 *   page index, which can make two decks drive each other forever. Too many
 *   driven sends from one device in a short span are ignored with a warning.
 *   A flip that only looked driven because the app reported the new page
 *   before the old page's disappear is uncounted when that disappear arrives.
 */
import { pageCountOf, resolveTargets, toCanonical } from "./mapping";
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
  /** Past this many still-expected switches to one device the oldest become echo tags only (default 50). */
  maxPendingPerDevice?: number;
  /** More than this many driven sends from one device within `drivenSendWindowMs` trips the breaker (default 12). */
  drivenSendMax?: number;
  /** Window for the conflicting-anchor breaker (default 30000 ms). */
  drivenSendWindowMs?: number;
  /** Human appears queued before start() (default 20). */
  maxQueuedBeforeStart?: number;
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
export type IgnoreReason = "multi-action" | "no-page-index" | "duplicate" | "not-started" | "no-scope" | "disabled" | "conflicting-anchors" | "error";
export type SkipReason = "no-counterpart" | "disconnected" | "no-profile" | "already-there" | "error";

export type IssuedSwitch = { deviceId: string; profile: string; page: number; seq: number };
export type SkippedTarget = { deviceId: string; reason: SkipReason };

export type Outcome = {
  classification: Classification;
  reason?: IgnoreReason | "parent-in-flight";
  /** The SEND's sequence number, or the consumed entry's for RECEIVE*. */
  seq?: number;
  /** True when a RECEIVE matched an entry that had passed the TTL (a late echo). */
  late?: boolean;
  issued: IssuedSwitch[];
  skipped: SkippedTarget[];
};

/* ---------------- runtime state ---------------- */

type Origin = DeviceRole | "self";

/** Why an entry is no longer expected: past the TTL, detached by a settings change, or pushed out by the cap. */
type Expiry = false | "ttl" | "detached" | "cap";

/** One driven send, for the conflicting-anchor breaker; an object so a late disappear can uncount exactly it. */
type Stamp = { at: number };

type Pending = {
  seq: number;
  page: number;
  profile: string;
  originId: string;
  originRole: Origin;
  issuedAt: number;
  /** Once set, the entry is an echo tag only. */
  expired: Expiry;
};

type DeviceState = {
  id: string;
  /** False until the first appear after start/connect; such an appear is STARTUP. */
  armed: boolean;
  /** The page the device is believed to show; null when unknown (left the page, reconnect). */
  lastKnownPage: number | null;
  /** Plugin-issued switches that have not landed, in issue order. */
  pending: Pending[];
  /** This device's most recent human navigation (SEND, or an ignored one it still chose). */
  lastHumanSeq: number;
  lastHumanPage: number | null;
  /** True while the current page was set by a RECEIVE and the device has not left it. */
  driven: boolean;
  /** Recent driven sends, for the conflicting-anchor breaker. */
  drivenSends: Stamp[];
  /**
   * The last driven send and the page the device was switched to before it. A disappear for
   * that page arriving afterwards means the device did leave it (the app merely reported the
   * new page first), so the send is uncounted. Cleared once anything else is issued to the device.
   */
  drivenLeave: { page: number; stamp: Stamp } | null;
};

type Plan = IssuedSwitch & { settled: Promise<void> };

export type EngineSnapshot = {
  seq: number;
  started: boolean;
  devices: Array<Omit<DeviceState, "pending" | "drivenSends" | "drivenLeave"> & { pending: Array<Omit<Pending, "issuedAt">> }>;
};

const ignored = (reason: IgnoreReason): Outcome => ({ classification: "IGNORED", reason, issued: [], skipped: [] });
const fresh = (dev: DeviceState): Pending[] => dev.pending.filter((p) => !p.expired);

export class SyncEngine {
  private settings: GlobalSettings = createDefaultGlobalSettings();
  private readonly devices = new Map<string, DeviceState>();
  private seq = 0;
  private started = false;
  private queued: AppearInput[] = [];
  private readonly warnedNoPage = new Set<string>();
  private readonly notedNoScope = new Set<string>();
  private readonly warnedBeyond = new Set<string>();
  private readonly ttl: number;
  private readonly grace: number;
  private readonly cap: number;
  private readonly drivenMax: number;
  private readonly drivenWindow: number;
  private readonly queueCap: number;
  private readonly log: Log;

  constructor(private readonly deps: EngineDeps, options: EngineOptions = {}) {
    this.ttl = options.pendingTtlMs ?? 3000;
    this.grace = Math.max(options.pendingGraceMs ?? 30000, this.ttl);
    this.cap = options.maxPendingPerDevice ?? 50;
    this.drivenMax = options.drivenSendMax ?? 12;
    this.drivenWindow = options.drivenSendWindowMs ?? 30000;
    this.queueCap = options.maxQueuedBeforeStart ?? 20;
    this.log = deps.log;
  }

  /* ---------------- lifecycle ---------------- */

  /**
   * Call once the settings are known (after the plugin connects). Never issues a switch
   * by itself; human navigation that arrived before start is replayed in order.
   */
  async start(settings: GlobalSettings): Promise<void> {
    for (const d of this.deps.devices.list()) this.device(d.id);
    this.applySettings(settings, "start");
    this.started = true;
    this.log.info(`START devices=[${[...this.devices.keys()].join(",")}] scopes=${this.settings.scopes.length} ttlMs=${this.ttl} graceMs=${this.grace} queued=${this.queued.length}`);
    // Nothing was in flight before start, so queued navigations never conflicted: within each
    // scope the newest one decides where everyone goes; the earlier ones only record where
    // their device is. Unscoped navigations are replayed as they are (they warn once).
    const replay = this.queued;
    this.queued = [];
    const leaders = new Set<AppearInput>();
    const newest = new Map<string, AppearInput>();
    for (const ev of replay) {
      const scope = findScopeForDevice(this.settings, ev.deviceId);
      if (scope) newest.set(scope.id, ev);
      else leaders.add(ev);
    }
    for (const ev of newest.values()) leaders.add(ev);
    const leading = new Set([...leaders].map((ev) => ev.deviceId));
    for (const ev of replay) {
      if (leaders.has(ev)) {
        await this.onAppear(ev);
        continue;
      }
      const dev = this.device(ev.deviceId);
      // A device that leads later records its page then; clearing it keeps that appear from reading as a duplicate.
      dev.lastKnownPage = leading.has(dev.id) ? null : (ev.pageIndex as number);
      dev.driven = false;
      this.log.debug(`REPLAY dev=${dev.id} page=${ev.pageIndex} action=${ev.actionId} reason=superseded (a later navigation in the scope decides)`);
    }
  }

  /** Validated settings from the PI or the global-settings event. */
  onSettingsChanged(settings: GlobalSettings): void {
    this.applySettings(settings, "update");
  }

  private applySettings(settings: GlobalSettings, why: "start" | "update"): void {
    // The global-settings event also fires for plain reads (e.g. when the PI opens).
    if (why === "update" && JSON.stringify(settings) === JSON.stringify(this.settings)) {
      this.log.debug("SETTINGS unchanged (update); keeping state");
      return;
    }
    this.settings = settings;
    this.notedNoScope.clear();
    this.warnedBeyond.clear();
    // Switches in flight were issued under the old topology: their origins no longer mean
    // anything (no suppression, no prediction), but they remain echo tags so their landings
    // can never be mistaken for human navigation.
    let detached = 0;
    for (const dev of this.devices.values()) {
      for (const p of dev.pending) {
        if (!p.expired) {
          p.expired = "detached";
          detached++;
        }
      }
      this.dedupeTags(dev);
    }
    const scopes = settings.scopes
      .map((s) => `${s.id}{parent=${s.parentDeviceId},children=${s.members.length - 1},overrides=${s.mapping.overrides.length}}`)
      .join(" ");
    this.log.info(`SETTINGS applied (${why}) scopes=[${scopes}] detachedPending=${detached}`);
  }

  onDeviceConnected(deviceId: string): void {
    const dev = this.device(deviceId);
    // The app may announce devices it already showed us (at launch, or after a reconnect whose
    // appears arrived first): an armed device stays armed. A new or disconnected device is not
    // armed yet, so its next appears count as startup.
    if (dev.armed) {
      this.log.debug(`DEVICE connected dev=${deviceId} (already armed; no change)`);
      return;
    }
    this.log.info(`DEVICE connected dev=${deviceId} (disarmed until its first appear)`);
  }

  onDeviceDisconnected(deviceId: string): void {
    const dev = this.device(deviceId);
    const dropped = dev.pending.length;
    dev.armed = false;
    dev.lastKnownPage = null; // it may come back on another page
    dev.pending = []; // nothing can land on an absent device
    dev.driven = false;
    dev.drivenSends = [];
    dev.drivenLeave = null;
    // Navigation queued before start belongs to the connection that just ended: replaying it
    // would arm the absent device and turn its reconnect burst into sends.
    const queuedBefore = this.queued.length;
    this.queued = this.queued.filter((q) => q.deviceId !== deviceId);
    const droppedQueued = queuedBefore - this.queued.length;
    this.log.info(`DEVICE disconnected dev=${deviceId} droppedPending=${dropped}${droppedQueued ? ` droppedQueued=${droppedQueued}` : ""}; it is skipped by its scope until it reconnects`);
  }

  /** JSON-safe view for tests and diagnostics. */
  snapshot(): EngineSnapshot {
    return {
      seq: this.seq,
      started: this.started,
      devices: [...this.devices.values()].map(({ drivenSends: _sends, drivenLeave: _leave, ...d }) => ({
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
      dev.driven = false;
      this.log.debug(`LEAVE dev=${dev.id} page=${ev.pageIndex}`);
    } else if (dev.drivenLeave && dev.drivenLeave.page === ev.pageIndex) {
      // The device did leave the page it was switched to; the app just reported the new page
      // first. The send that followed was human after all, not a conflicting anchor.
      const { stamp } = dev.drivenLeave;
      dev.drivenSends = dev.drivenSends.filter((s) => s !== stamp);
      dev.drivenLeave = null;
      this.log.debug(`LEAVE dev=${dev.id} page=${ev.pageIndex} (after the next page appeared; the send that followed was not driven)`);
    }
  }

  /** A Page Anchor became visible. Resolves once any switches it issued have been acknowledged or rejected. */
  async onAppear(ev: AppearInput): Promise<Outcome> {
    try {
      return await this.classify(ev);
    } catch (err) {
      this.log.error(`UNEXPECTED handler=onAppear dev=${ev.deviceId} page=${ev.pageIndex} error="${describeError(err)}"`);
      return ignored("error");
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
      dev.driven = true;
      dev.drivenLeave = null;
      return this.receive(dev, page, entry);
    }

    // 5. Startup / reconnect guard (PRD §4.4): record the page, arm, never sync.
    if (!dev.armed) {
      this.arm(dev, page);
      this.log.info(`STARTUP dev=${dev.id} page=${page} (armed; no sync)`);
      return { classification: "STARTUP", issued: [], skipped: [] };
    }

    // 6. Human navigation before the settings are known: replayed by start(). The queue keeps
    //    the newest navigations — the last one decides where everyone ends up.
    if (!this.started) {
      if (this.queued.length >= this.queueCap) {
        const oldest = this.queued.shift()!;
        this.log.warn(`QUEUE full dev=${dev.id} page=${page} reason=not-started — more than ${this.queueCap} navigations before the settings loaded; dropped the oldest (dev=${oldest.deviceId} page=${oldest.pageIndex})`);
      }
      this.queued.push(ev);
      this.log.debug(`QUEUED dev=${dev.id} page=${page} action=${ev.actionId} reason=not-started (replayed once the settings are loaded; ${this.queued.length}/${this.queueCap})`);
      return ignored("not-started");
    }

    // From here on this is human navigation. Record the physical fact first.
    const pageBefore = dev.lastKnownPage;
    dev.lastKnownPage = page;
    const wasDriven = dev.driven;
    dev.driven = false;

    // 7. Scope membership.
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

    // 8. Parent precedence (PRD §6.3.3): a child may not lead while the parent's switch to it is still
    //    expected — whatever page it flipped to. The navigation is discarded, not recorded.
    if (member.role === "child") {
      const parentSwitch = fresh(dev).find((p) => p.originRole === "parent");
      if (parentSwitch) {
        this.log.info(`SUPPRESSED dev=${dev.id} page=${page} scope=${scope.id} reason=parent-in-flight pending=[page=${parentSwitch.page} seq=${parentSwitch.seq}] (parent wins; its switch will land)`);
        return { classification: "SUPPRESSED", reason: "parent-in-flight", issued: [], skipped: [] };
      }
    }

    // 9. Disabled marker (PRD §7.3): the human still chose this page.
    if (!ev.enabled) {
      this.recordHuman(dev, page);
      this.log.info(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} reason=disabled`);
      return ignored("disabled");
    }

    // 10. Conflicting-anchor breaker. A SEND right after a RECEIVE, without the device leaving the
    //     page, means the page the plugin switched it to reports another index: a copied anchor
    //     with the wrong page index. Two such pages on two devices drive each other forever.
    if (wasDriven) {
      const now = this.deps.clock.now();
      dev.drivenSends = dev.drivenSends.filter((s) => now - s.at <= this.drivenWindow);
      const stamp: Stamp = { at: now };
      dev.drivenSends.push(stamp);
      // If the app reports a new page before the old page's disappear, a human flip right after a
      // RECEIVE looks driven; the disappear of the page it was switched to, arriving next, uncounts it.
      dev.drivenLeave = { page: pageBefore as number, stamp };
      if (dev.drivenSends.length > this.drivenMax) {
        this.log.warn(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} action=${ev.actionId} reason=conflicting-anchors — ${dev.drivenSends.length} sends in ${this.drivenWindow}ms each right after the plugin switched this device; a Page Anchor on its pages reports the wrong page index (fix the anchor's page index)`);
        return ignored("conflicting-anchors");
      }
      this.log.debug(`DRIVEN dev=${dev.id} page=${page} action=${ev.actionId} (send right after a receive without leaving the page; ${dev.drivenSends.length}/${this.drivenMax})`);
    }

    // 11. SEND.
    return this.send(dev, scope, member, page);
  }

  private arm(dev: DeviceState, page: number): void {
    dev.armed = true;
    dev.lastKnownPage = page;
  }

  private recordHuman(dev: DeviceState, page: number): void {
    dev.lastHumanSeq = ++this.seq;
    dev.lastHumanPage = page;
  }

  private async receive(dev: DeviceState, page: number, entry: Pending): Promise<Outcome> {
    const late = entry.expired === "ttl";
    const expected = fresh(dev);
    // Stale: a still-expected switch issued before this device's own later human navigation has
    // landed on it, and nothing issued after that navigation is heading for the device (a later
    // switch wins). An expired match never restores: a late one may be the human flipping to a
    // page the engine once sent the device to, and fighting that would be worse than one missed sync.
    const stale =
      !entry.expired &&
      entry.seq < dev.lastHumanSeq &&
      dev.lastHumanPage !== null &&
      dev.lastHumanPage !== page &&
      !expected.some((p) => p.seq > dev.lastHumanSeq);
    const tag = late ? " late=true" : entry.expired === "detached" ? " detached=true" : entry.expired === "cap" ? " capped=true" : "";
    if (!stale) {
      this.log.info(`RECEIVE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId}${tag} (echo consumed; no rebroadcast)`);
      return { classification: "RECEIVE", seq: entry.seq, late, issued: [], skipped: [] };
    }
    const restorePage = dev.lastHumanPage as number;
    const seq = ++this.seq;
    this.log.info(`RECEIVE_STALE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId} landed after this device's own navigation seq=${dev.lastHumanSeq}; restoring page=${restorePage} seq=${seq}`);
    // The device is in the profile the stale switch put it in; the restore stays there.
    const plan = this.issue(dev, entry.profile, restorePage, dev.id, "self", seq);
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
        // Where the device will be: the tail of the switches still expected to land, but only if the
        // stale rule will honour them — entries that all predate the device's own navigation would be
        // undone when they land, so they predict nothing. An aligned target gets no switch.
        const expected = fresh(state);
        const honoured = expected.some((p) => p.seq > state.lastHumanSeq) ? expected : [];
        const willShow = honoured.length ? honoured[honoured.length - 1].page : state.lastKnownPage;
        if (willShow === targetPage) {
          // A parent relying on a child-issued switch still asserts its precedence over the target.
          const carrier = honoured[honoured.length - 1];
          if (member.role === "parent" && carrier && carrier.originRole !== "parent") {
            carrier.originRole = "parent";
            carrier.originId = dev.id;
            carrier.seq = seq;
          }
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
    if (canonical === undefined && page >= pageCountOf(member) && !this.warnedBeyond.has(`${dev.id}:${page}`)) {
      // The configuration says this device has no such page, so nobody can follow: a configuration error, said once.
      this.warnedBeyond.add(`${dev.id}:${page}`);
      this.log.warn(`SEND dev=${dev.id} page=${page} scope=${scope.id} reason=beyond-page-count pageCount=${pageCountOf(member)} — no member can follow; raise Pages for this device in the Page Anchor Property Inspector`);
    }
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
    target.drivenLeave = null; // a disappear is now expected for another reason; it exonerates nothing
    // Bounded memory without forgetting: past the cap the oldest still-expected entries become
    // echo tags only (one per page is kept), so a landing can never read as navigation. More
    // than the cap within the TTL is beyond what a person can produce, hence the warning.
    let expected = target.pending.filter((p) => !p.expired).length;
    for (const p of target.pending) {
      if (expected <= this.cap) break;
      if (p.expired) continue;
      p.expired = "cap";
      expected--;
      this.log.warn(`GC dev=${target.id} page=${p.page} seq=${p.seq} reason=cap — more than ${this.cap} unconfirmed switches to this device; kept as an echo tag only`);
    }
    this.dedupeTags(target);
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

  /**
   * Consumes the earliest still-expected entry for `page`, or failing that the earliest expired
   * one; entries issued before it were superseded. Preferring the fresh entry matters when a
   * switch to the page was reissued after an earlier one never landed: matching the expired
   * tag would leave the fresh entry dangling (suppressing a child, predicting a position).
   */
  private consume(dev: DeviceState, page: number): Pending | undefined {
    let i = dev.pending.findIndex((p) => p.page === page && !p.expired);
    if (i < 0) i = dev.pending.findIndex((p) => p.page === page);
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
        p.expired = "ttl";
        this.log.warn(`SWITCH unconfirmed dev=${dev.id} profile=${p.profile} page=${p.page} seq=${p.seq} origin=${p.originId} — no appear within ${this.ttl}ms: the device may already have been on that page, the page may have no Page Anchor, or "${p.profile}" may not be bundled`);
      }
      keep.push(p);
    }
    dev.pending = keep;
    this.dedupeTags(dev);
  }

  /**
   * Expired entries are echo tags only, so one per page suffices: keep the newest. Expired
   * entries always precede still-expected ones (ageing and detaching follow issue order), so
   * this never reorders anything a landing could match.
   */
  private dedupeTags(dev: DeviceState): void {
    const seen = new Set<number>();
    for (let i = dev.pending.length - 1; i >= 0; i--) {
      const p = dev.pending[i];
      if (!p.expired) continue;
      if (seen.has(p.page)) {
        dev.pending.splice(i, 1);
        this.log.debug(`GC dev=${dev.id} page=${p.page} seq=${p.seq} reason=duplicate-tag (a newer tag for the page is kept)`);
      } else {
        seen.add(p.page);
      }
    }
  }

  private device(id: string): DeviceState {
    let dev = this.devices.get(id);
    if (!dev) {
      dev = { id, armed: false, lastKnownPage: null, pending: [], lastHumanSeq: 0, lastHumanPage: null, driven: false, drivenSends: [], drivenLeave: null };
      this.devices.set(id, dev);
    }
    return dev;
  }
}

const toIssued = ({ deviceId, profile, page, seq }: Plan): IssuedSwitch => ({ deviceId, profile, page, seq });
