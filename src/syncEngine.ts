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
 *   device, in issue order (`pending`). The app applies switches in order,
 *   so an appear whose page matches the EARLIEST entry for that page on that
 *   device is a RECEIVE: terminal, never rebroadcast. What was issued before
 *   that match and is still in flight was processed without an appear (the
 *   device was already there, the page has no anchor, or the app coalesced
 *   it), and switches to the same page issued right after it with no other
 *   page between can never produce another appear: both become echo tags for
 *   one TTL (superseded). Everything issued after stays in flight, since the
 *   app may still have it queued.
 * - Any other appear on an armed device is human navigation → SEND to the
 *   rest of its scope, mapped through the parent's page (src/mapping.ts).
 * - Devices start un-armed; the first appear after plugin start or device
 *   (re)connect arms the device and never syncs (PRD §4.4). No settle window.
 *   Human navigation that arrives before `start()` is queued and replayed in
 *   order once the settings are known. Nothing was in flight then, so a
 *   replayed fan-out skips any device whose own later navigation is still to
 *   be replayed, and a page the device had left before start is forgotten
 *   again after its replay.
 * - Parent precedence: a child's human navigation while a parent-issued
 *   switch to it is still expected is SUPPRESSED (even on a disabled page);
 *   a parent's never is. A switch still in flight (expected, or detached by
 *   a settings change) that lands on a device after that device's own later
 *   human navigation is stale: swallowed, and the device restored to the
 *   human's page — unless a later switch is already heading there.
 * - Time never decides between SEND and RECEIVE. After `pendingTtlMs` an
 *   unconfirmed entry is marked expired: it no longer suppresses a child,
 *   counts as where the device will be, or triggers a restore, but it remains
 *   an echo tag, so a late landing is still a RECEIVE. Expired entries are
 *   dropped after `pendingGraceMs` (a superseded tag after one TTL), replaced
 *   by a newer tag for the same page, or when the device disconnects; past
 *   `maxPendingPerDevice` still-expected entries become tags too, so memory is
 *   bounded without ever forgetting that a switch was issued.
 * - A conflicting-anchor breaker: a page that reports two page indices in one
 *   visit (two anchors appearing without a disappear between them, or two
 *   indices disappearing together) carries a copied anchor with the wrong
 *   index, which can make two decks drive each other forever. Each such
 *   conflict adds to a per-device run; once the run exceeds `drivenSendMax`
 *   the device's sends are ignored with a warning, however slow the cycle,
 *   until a real page change (a disappear group with a single index) resets
 *   it. An app that reports a new page before the old page's disappear
 *   therefore never accumulates anything.
 * - Leaving a page while a switch to it is still in flight: if nothing the
 *   plugin issued explains the departure (no earlier switch queued ahead of
 *   it, no RECEIVE that just moved the device off the page), the device was
 *   on that page without the switch ever showing, and the entry becomes a
 *   tag (`left`) for the grace period — never in flight again, so the
 *   person's return is swallowed at most once and never fought.
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
  /** An expired entry stays an echo tag this long after it was issued (a left-page tag: after the disappear; a superseded tag lives one TTL instead) (default 30000 ms). */
  pendingGraceMs?: number;
  /** Past this many still-expected switches to one device the oldest become echo tags only (default 50). */
  maxPendingPerDevice?: number;
  /** More than this many conflicts in a row (pages reporting two indices) on one device trips the breaker (default 12). */
  drivenSendMax?: number;
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
export type IgnoreReason = "multi-action" | "no-page-index" | "duplicate" | "not-started" | "no-scope" | "disabled" | "conflicting-anchors" | "overturned-switches" | "error";
export type SkipReason = "no-counterpart" | "disconnected" | "no-profile" | "already-there" | "queued-later" | "error";

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

/**
 * Why an entry is no longer expected: past the TTL, detached by a settings change (still in
 * flight, so it can still be stale), pushed out by the cap, or superseded by a later landing.
 */
type Expiry = false | "ttl" | "detached" | "cap" | "superseded" | "left";
const TAG_WORD: Record<Exclude<Expiry, false>, string> = { ttl: "late", detached: "detached", cap: "capped", superseded: "superseded", left: "left" };
/** Still heading for the device: expected, or detached by a settings change. */
const inFlight = (p: Pending): boolean => !p.expired || p.expired === "detached";
const NONE: ReadonlySet<string> = new Set();

type Pending = {
  seq: number;
  page: number;
  profile: string;
  originId: string;
  originRole: Origin;
  issuedAt: number;
  /** Once set, the entry is an echo tag only. */
  expired: Expiry;
  /** For a superseded entry: the switch whose landing wrote it off — revived as a tag if this entry shows after all. */
  supersededBy?: { seq: number; page: number; profile: string; originId: string; originRole: Origin };
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
  /** The page of the RECEIVE that was this device's most recent appear (null once anything else happens on it). */
  lastReceivePage: number | null;
  /** The current page was recorded by a disabled anchor only; an enabled anchor on it may still send once. */
  disabledOnly: boolean;
  /** Page indices reported by appears and not yet left: more than one means two anchors disagree on the page. */
  visit: Set<number>;
  /** Page indices that disappeared since the last appear (the current disappear group). */
  leaving: Set<number>;
  /** Conflicts in a row (a second index appearing on a visit, or two indices leaving together); a real page change resets it. */
  drivenRun: number;
  /** Sends in a row made while a switch from another deck to a different page of this device had not shown (the overturned-switch breaker). */
  overturnRun: number;
  /** The page a disappear just took the device off; an appear for it with nothing between is a re-emit, not a landing. */
  leftPage: number | null;
};

type Plan = IssuedSwitch & { settled: Promise<void> };

export type EngineSnapshot = {
  seq: number;
  started: boolean;
  devices: Array<Omit<DeviceState, "pending" | "visit" | "leaving"> & { pending: Array<Omit<Pending, "issuedAt">> }>;
};

const ignored = (reason: IgnoreReason): Outcome => ({ classification: "IGNORED", reason, issued: [], skipped: [] });
const fresh = (dev: DeviceState): Pending[] => dev.pending.filter((p) => !p.expired);

export class SyncEngine {
  private settings: GlobalSettings = createDefaultGlobalSettings();
  private readonly devices = new Map<string, DeviceState>();
  private seq = 0;
  private started = false;
  /** Human navigation before start(); `left` once a disappear for that page arrived before start. */
  private queued: Array<{ ev: AppearInput; left: boolean }> = [];
  private readonly warnedNoPage = new Set<string>();
  private readonly notedNoScope = new Set<string>();
  private readonly warnedBeyond = new Set<string>();
  private readonly ttl: number;
  private readonly grace: number;
  private readonly cap: number;
  private readonly drivenMax: number;
  private readonly queueCap: number;
  private readonly log: Log;

  constructor(private readonly deps: EngineDeps, options: EngineOptions = {}) {
    this.ttl = options.pendingTtlMs ?? 3000;
    this.grace = Math.max(options.pendingGraceMs ?? 30000, this.ttl);
    this.cap = options.maxPendingPerDevice ?? 50;
    this.drivenMax = options.drivenSendMax ?? 12;
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
    this.log.info(`START devices=[${[...this.devices.keys()].join(",")}] scopes=${this.settings.scopes.length} ttlMs=${this.ttl} graceMs=${this.grace} queued=${this.queued.length}`);
    // Nothing was in flight before start, so queued navigations never conflicted. They are
    // replayed in order through the normal rules, except that a fan-out skips any device whose
    // own later navigation is still to be replayed (it is where its own flip left it), and a
    // page the device had left before start is forgotten again after its replay so the next
    // appear there is not read as a duplicate. Classification is synchronous (only the app's
    // acknowledgements are awaited), so a batch is replayed without a live appear slipping in
    // between; navigation that arrives while the acknowledgements are awaited is queued and
    // replayed next, and the engine counts as started only once nothing is queued.
    let batch = this.queued;
    this.queued = [];
    while (batch.length) {
      const settled = batch.map(({ ev, left }, i) => {
        const later = new Set(batch.slice(i + 1).map((q) => q.ev.deviceId));
        const outcome = this.handle(ev, later, true);
        if (left) {
          // Every outcome a queued appear can have records its page as the device's, so forgetting it is unconditional.
          const dev = this.device(ev.deviceId);
          dev.lastKnownPage = null;
          dev.visit.delete(ev.pageIndex as number);
          this.log.debug(`LEAVE dev=${ev.deviceId} page=${ev.pageIndex} (left before the settings loaded)`);
        }
        return outcome;
      });
      await Promise.all(settled);
      batch = this.queued;
      this.queued = [];
    }
    this.started = true;
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
    // A switch in flight whose origin no longer stands in the same relation to its target (the
    // target left every scope, the origin left the target's scope, or a parent-issued switch's
    // origin is no longer that scope's parent) is detached: its origin means nothing under the new
    // topology (no suppression), but it still predicts where the device will be and remains an
    // echo tag, so its landing can never be mistaken for human navigation. A change that keeps the
    // relation (a rename, another scope, a mapping change) keeps the switch expected: the
    // parent's precedence survives a save made while its switch is landing.
    let detached = 0;
    for (const dev of this.devices.values()) {
      const scope = findScopeForDevice(settings, dev.id);
      for (const p of dev.pending) {
        if (p.expired || p.originRole === "self") continue;
        const related = scope !== undefined && scope.members.some((m) => m.deviceId === p.originId) && (p.originRole !== "parent" || scope.parentDeviceId === p.originId);
        if (related) continue;
        p.expired = "detached";
        detached++;
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
    dev.visit.clear();
    dev.leaving.clear();
    dev.drivenRun = 0;
    dev.overturnRun = 0;
    dev.lastReceivePage = null;
    dev.leftPage = null;
    // Navigation queued before start belongs to the connection that just ended: replaying it
    // would arm the absent device and turn its reconnect burst into sends.
    const queuedBefore = this.queued.length;
    this.queued = this.queued.filter((q) => q.ev.deviceId !== deviceId);
    const droppedQueued = queuedBefore - this.queued.length;
    this.log.info(`DEVICE disconnected dev=${deviceId} droppedPending=${dropped}${droppedQueued ? ` droppedQueued=${droppedQueued}` : ""}; it is skipped by its scope until it reconnects`);
  }

  /** JSON-safe view for tests and diagnostics. */
  snapshot(): EngineSnapshot {
    return {
      seq: this.seq,
      started: this.started,
      devices: [...this.devices.values()].map(({ visit: _visit, leaving: _leaving, ...d }) => ({
        ...d,
        pending: d.pending.map(({ seq, page, profile, originId, originRole, expired }) => ({ seq, page, profile, originId, originRole, expired })),
      })),
    };
  }

  /* ---------------- page events ---------------- */

  /** A Page Anchor stopped being visible: the device left that page. Never throws. */
  onDisappear(ev: DisappearInput): void {
    try {
      this.disappear(ev);
    } catch (err) {
      this.log.error(`UNEXPECTED handler=onDisappear dev=${ev.deviceId} page=${ev.pageIndex} error="${describeError(err)}"`);
    }
  }

  private disappear(ev: DisappearInput): void {
    if (ev.isInMultiAction || ev.pageIndex === undefined) return;
    // Before start the page may sit in the queue: remember that the device left it again.
    for (const q of this.queued) if (q.ev.deviceId === ev.deviceId && q.ev.pageIndex === ev.pageIndex) q.left = true;
    const dev = this.devices.get(ev.deviceId);
    if (!dev) return;
    const page = ev.pageIndex;
    this.expire(dev); // ageing is lazy: a disappear touches the device too
    dev.visit.delete(page);
    dev.leaving.add(page);
    if (dev.leaving.size === 2) {
      // Two page indices left one page together: a copied anchor with the wrong index, whatever
      // order the app reports appears in.
      dev.drivenRun++;
      this.log.debug(`CONFLICT dev=${dev.id} pages=[${[...dev.leaving].join(",")}] (two page indices left one page together; ${dev.drivenRun}/${this.drivenMax})`);
    }
    // A switch to this page still in flight has been overtaken — the device was on the page (it is
    // leaving it) without the switch ever showing — unless the plugin itself explains the departure:
    // a switch to another page queued ahead of it (the app is working through the backlog), or a
    // RECEIVE that just moved the device off this page (the app reports appears before disappears).
    // An overtaken entry stays an echo tag for the grace period, never in flight, so the person's
    // return to the page is swallowed at most once and never read as a stale landing and fought.
    const explained = dev.lastReceivePage !== null && dev.lastReceivePage !== page;
    let left = 0;
    dev.pending.forEach((p, i) => {
      if (p.page !== page || !inFlight(p)) return;
      if (explained || dev.pending.slice(0, i).some((f) => inFlight(f) && f.page !== page)) return;
      p.expired = "left";
      p.issuedAt = this.deps.clock.now();
      left++;
      this.log.debug(`GC dev=${dev.id} page=${p.page} seq=${p.seq} reason=left-page (the device left the page before the switch showed; kept as an echo tag for ${this.grace}ms)`);
    });
    if (left) this.dedupeTags(dev);
    // Only when the engine still believes the device is there, so appear(new)/disappear(old) order does not matter.
    if (dev.lastKnownPage === page) {
      dev.lastKnownPage = null;
      dev.leftPage = page;
      this.log.debug(`LEAVE dev=${dev.id} page=${page}`);
    }
  }

  /** A Page Anchor became visible. Resolves once any switches it issued have been acknowledged or rejected. */
  onAppear(ev: AppearInput): Promise<Outcome> {
    return this.handle(ev, NONE);
  }

  /**
   * A visible Page Anchor's settings changed (its page index or enabled flag edited in the
   * Property Inspector). The device is showing that page: record it, arm the device, and take
   * a switch to that index as landed. Editing is not navigation, so nothing is sent.
   */
  onAnchorUpdated(ev: AppearInput): void {
    try {
      this.anchorUpdated(ev);
    } catch (err) {
      this.log.error(`UNEXPECTED handler=onAnchorUpdated dev=${ev.deviceId} page=${ev.pageIndex} error="${describeError(err)}"`);
    }
  }

  private anchorUpdated(ev: AppearInput): void {
    if (ev.isInMultiAction) return;
    const dev = this.device(ev.deviceId);
    const before = dev.lastKnownPage ?? "none";
    dev.visit.clear();
    dev.lastReceivePage = null;
    dev.disabledOnly = false;
    dev.overturnRun = 0;
    dev.leftPage = null;
    this.warnedNoPage.delete(ev.actionId); // an index cleared (or set) later is worth a fresh warning
    if (ev.pageIndex === undefined) {
      dev.lastKnownPage = null;
      this.log.info(`ANCHOR updated dev=${dev.id} action=${ev.actionId} page=${before}→none (page index cleared; the page is unknown until its next appear)`);
      return;
    }
    this.expire(dev);
    // The device shows this page: a switch to it is satisfied only if it is the next the app would apply.
    const consumed = this.nextInLine(dev, ev.pageIndex) ? this.consume(dev, ev.pageIndex) : undefined;
    this.arm(dev, ev.pageIndex);
    dev.visit.add(ev.pageIndex);
    this.log.info(`ANCHOR updated dev=${dev.id} action=${ev.actionId} page=${before}→${ev.pageIndex} enabled=${ev.enabled}${consumed ? ` (consumed seq=${consumed.seq})` : ""} (no sync)`);
  }

  /**
   * `excluded`: devices a fan-out must leave alone (their own queued navigation is replayed
   * next); `replay`: a queued navigation being replayed by start(), which must not be queued again.
   */
  private async handle(ev: AppearInput, excluded: ReadonlySet<string>, replay = false): Promise<Outcome> {
    try {
      return await this.classify(ev, excluded, replay);
    } catch (err) {
      this.log.error(`UNEXPECTED handler=onAppear dev=${ev.deviceId} page=${ev.pageIndex} error="${describeError(err)}"`);
      return ignored("error");
    }
  }

  private async classify(ev: AppearInput, excluded: ReadonlySet<string>, replay: boolean): Promise<Outcome> {
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
    // Visit bookkeeping (the conflicting-anchor breaker, rule 10): a second index reported before
    // the first one disappeared is a conflict; a disappear group with a single index was a real
    // page change and ends any run of conflicts.
    const conflict = [...dev.visit].some((p) => p !== page);
    if (dev.leaving.size === 1) dev.drivenRun = 0;
    dev.leaving.clear();
    dev.visit.add(page);
    // The page a disappear just took the device off, reported again with nothing between: the app
    // re-emitting the anchors of a page a device already shows on a switch to it (hardware risk 2),
    // or a return from a page without an anchor. Either way the device never changed page, so this
    // is not the landing of a switch queued behind another.
    const reemit = dev.leftPage === page;
    dev.leftPage = null;

    // 3. The device is already known to be on this page: a second anchor on the page or a re-emit.
    //    (A page recorded by a disabled anchor only may still be sent once by an enabled one. A
    //    replayed navigation was de-duplicated when it was queued; the page may have become known
    //    since — through an anchor edit — and the navigation is still owed its fan-out.)
    //    A switch to this page is satisfied by the re-emit only if it is the next the app would apply:
    //    behind a switch to another page it is still to show, and the device will come back here.
    if (!replay && (dev.lastKnownPage === page || reemit) && !(ev.enabled && dev.disabledOnly)) {
      dev.lastKnownPage = page; // (after a re-emit's disappear the engine had forgotten it)
      const consumed = this.nextInLine(dev, page) ? this.consume(dev, page) : undefined;
      const queued = !consumed && dev.pending.some((p) => p.page === page && inFlight(p));
      this.log.debug(`IGNORED dev=${dev.id} page=${page} action=${ev.actionId} reason=duplicate${consumed ? ` (consumed seq=${consumed.seq})` : ""}${queued ? " (a switch to this page waits behind an older one; kept)" : ""}`);
      return ignored("duplicate");
    }

    // 4. Echo of a switch the engine issued → RECEIVE, terminal. Checked before the startup guard so a
    //    switch issued to a device before its first appear is still recognized.
    const entry = this.consume(dev, page);
    if (entry) {
      this.arm(dev, page);
      dev.lastReceivePage = page;
      dev.overturnRun = 0; // a switch showed: whatever overturned the earlier ones, this device still lands them
      return this.receive(dev, page, entry);
    }
    dev.lastReceivePage = null;

    // 5. Startup / reconnect guard (PRD §4.4): record the page, arm, never sync.
    if (!dev.armed) {
      this.arm(dev, page);
      this.log.info(`STARTUP dev=${dev.id} page=${page} (armed; no sync)`);
      return { classification: "STARTUP", issued: [], skipped: [] };
    }

    // 6. Human navigation before the settings are known (or while start() is still replaying):
    //    replayed by start(). The queue keeps the newest navigations.
    if (!this.started && !replay) {
      // A second anchor on the page the device's own latest queued navigation reached (other
      // devices' navigations may sit between) takes no slot; an enabled anchor reported after a
      // disabled one on that page is the navigation to replay (rule 3 lets it send after start).
      const own = [...this.queued].reverse().find((q) => q.ev.deviceId === dev.id);
      if (own && own.ev.pageIndex === page && !own.left) {
        if (ev.enabled && !own.ev.enabled) {
          own.ev = ev;
          this.log.debug(`QUEUED dev=${dev.id} page=${page} action=${ev.actionId} reason=not-started (replaces the disabled anchor's appear queued for this page)`);
          return ignored("not-started");
        }
        this.log.debug(`IGNORED dev=${dev.id} page=${page} action=${ev.actionId} reason=duplicate (already queued)`);
        return ignored("duplicate");
      }
      if (this.queued.length >= this.queueCap) {
        const oldest = this.queued.shift()!.ev;
        this.log.warn(`QUEUE full dev=${dev.id} page=${page} reason=not-started — more than ${this.queueCap} navigations before the settings loaded; dropped the oldest (dev=${oldest.deviceId} page=${oldest.pageIndex})`);
      }
      this.queued.push({ ev, left: false });
      this.log.debug(`QUEUED dev=${dev.id} page=${page} action=${ev.actionId} reason=not-started (replayed once the settings are loaded; ${this.queued.length}/${this.queueCap})`);
      return ignored("not-started");
    }

    // From here on this is human navigation. Record the physical fact first.
    dev.lastKnownPage = page;
    dev.disabledOnly = false;

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
      dev.disabledOnly = true;
      this.recordHuman(dev, page);
      this.log.info(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} reason=disabled`);
      return ignored("disabled");
    }

    // 10. Conflicting-anchor breaker. A second page index reported on one visit means the page
    //     carries a copied anchor with the wrong page index. Two such pages on two devices drive
    //     each other forever; a run of such sends is cut off. (An app that reports the new page
    //     before the old page's disappear makes every flip look like this for a moment, but the
    //     single-index disappear that follows resets the run before the next one.)
    if (conflict) {
      dev.drivenRun++;
      this.log.debug(`CONFLICT dev=${dev.id} page=${page} also=[${[...dev.visit].filter((p) => p !== page).join(",")}] action=${ev.actionId} (a second page index on one page visit; ${dev.drivenRun}/${this.drivenMax})`);
    }
    // The run also grows when two indices leave a page together, so every send checks it: a device
    // caught in a cycle of such pages stops sending until it passes a page with a single anchor.
    if (dev.drivenRun > this.drivenMax) {
      this.recordHuman(dev, page); // still the human's page: a stale switch landing later restores it
      this.log.warn(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} action=${ev.actionId} reason=conflicting-anchors — ${dev.drivenRun} conflicts in a row (pages reporting two page indices); a Page Anchor on this device's pages carries the wrong page index (fix the anchor's page index). Sends resume after a page with a single anchor`);
      return ignored("conflicting-anchors");
    }
    // 10b. Overturned-switch breaker: the other face of a wrong page index. A send made while a
    //      switch from another deck to a *different* page of this device has not shown (in flight,
    //      or expired without an appear) overturns that switch. People do that — a flip while a
    //      slow switch is landing — but the switch then lands, and the landing ends the run. A page
    //      whose only anchor reports the wrong index overturns every switch to it and never lands
    //      anything; two such pages on two decks drive each other forever when the app re-emits the
    //      anchors of a page a device already shows (hardware risk 2), every page reporting a
    //      single index, out of the conflict breaker's sight. A run of overturning sends with no
    //      landing between is cut off the same way; a send with nothing outstanding ends the run.
    //      Children only: every such cycle has at least one child sending in turn, and cutting that
    //      child off breaks it, whereas a parent's change is never suppressed (PRD §6.3.3) — not even
    //      after a child's coalesced burst left tags on the parent that no landing will ever clear.
    if (member.role === "child") {
      const overturned = dev.pending.find((p) => p.originId !== dev.id && p.page !== page && (inFlight(p) || p.expired === "ttl"));
      if (overturned) {
        dev.overturnRun++;
        this.log.debug(`OVERTURN dev=${dev.id} page=${page} outstanding=[page=${overturned.page} seq=${overturned.seq} origin=${overturned.originId}] action=${ev.actionId} (a send while another deck's switch to this device has not shown; ${dev.overturnRun}/${this.drivenMax})`);
      } else {
        dev.overturnRun = 0;
      }
      if (dev.overturnRun > this.drivenMax) {
        this.recordHuman(dev, page);
        this.log.warn(`IGNORED dev=${dev.id} page=${page} scope=${scope.id} action=${ev.actionId} reason=overturned-switches — ${dev.overturnRun} sends in a row while a switch from another deck to this device never showed; a page on this device reports the wrong page index, or has no Page Anchor (fix the anchor). Sends resume once a switch lands here, or after a flip made with nothing outstanding`);
        return ignored("overturned-switches");
      }
    }

    // 11. SEND.
    return this.send(dev, scope, member, page, excluded);
  }

  private arm(dev: DeviceState, page: number): void {
    dev.armed = true;
    dev.lastKnownPage = page;
    dev.disabledOnly = false;
  }

  private recordHuman(dev: DeviceState, page: number): void {
    dev.lastHumanSeq = ++this.seq;
    dev.lastHumanPage = page;
  }

  private async receive(dev: DeviceState, page: number, entry: Pending): Promise<Outcome> {
    const late = entry.expired === "ttl";
    const scope = findScopeForDevice(this.settings, dev.id)?.id ?? "none";
    // Stale: a switch still in flight (expected, or detached by a settings change) issued before
    // this device's own later human navigation has landed on it, and nothing in flight issued
    // after that navigation is heading for the device (a later switch wins). A late, capped or
    // superseded match never restores: it may be the human flipping to a page the engine once
    // sent the device to, and fighting that would be worse than one missed sync. (An entry for
    // the human's own last page cannot predate that navigation: the appear would have consumed it.)
    const stale =
      inFlight(entry) &&
      entry.seq < dev.lastHumanSeq &&
      dev.lastHumanPage !== null &&
      !dev.pending.some((p) => inFlight(p) && p.seq > dev.lastHumanSeq);
    const tag = entry.expired ? ` ${TAG_WORD[entry.expired]}=true` : "";
    if (entry.expired === "superseded" && entry.supersededBy && entry.supersededBy.page !== page) {
      // A switch the engine had written off showed after all: the landing that superseded it was the
      // person's own flip, and the app is still working through its queue. Its siblings get a fresh
      // TTL, and the switch that superseded them — consumed by that flip — is still to show: revived
      // as a tag, in its place in the order, so its landing is an echo too.
      const by = entry.supersededBy;
      const now = this.deps.clock.now();
      for (const p of dev.pending) if (p.expired === "superseded" && (p.supersededBy?.seq === by.seq || p.seq === by.seq)) p.issuedAt = now;
      if (!dev.pending.some((p) => p.seq === by.seq)) {
        const at = dev.pending.findIndex((p) => p.seq > by.seq);
        dev.pending.splice(at < 0 ? dev.pending.length : at, 0, { ...by, issuedAt: now, expired: "superseded" });
        this.dedupeTags(dev);
        this.log.debug(`GC dev=${dev.id} page=${by.page} seq=${by.seq} reason=revived (a switch it had superseded showed after all, so it is still queued in the app; kept as an echo tag for ${this.ttl}ms)`);
      }
    }
    if (!stale) {
      this.log.info(`RECEIVE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId} scope=${scope}${tag} (echo consumed; no rebroadcast)`);
      return { classification: "RECEIVE", seq: entry.seq, late, issued: [], skipped: [] };
    }
    const restorePage = dev.lastHumanPage as number;
    const seq = ++this.seq;
    this.log.info(`RECEIVE_STALE dev=${dev.id} page=${page} seq=${entry.seq} origin=${entry.originId} scope=${scope}${tag} landed after this device's own navigation seq=${dev.lastHumanSeq}; restoring page=${restorePage} seq=${seq}`);
    // The device is in the profile the stale switch put it in; the restore stays there.
    const plan = this.issue(dev, entry.profile, restorePage, dev.id, "self", seq);
    await plan.settled;
    return { classification: "RECEIVE_STALE", seq: entry.seq, late, issued: [toIssued(plan)], skipped: [] };
  }

  private async send(dev: DeviceState, scope: Scope, member: ScopeMember, page: number, excluded: ReadonlySet<string>): Promise<Outcome> {
    const seq = ++this.seq;
    const plans: Plan[] = [];
    const skipped: SkippedTarget[] = [];
    const from = { deviceId: dev.id, page };

    for (const { member: target, page: targetPage } of resolveTargets(scope, from)) {
      try {
        if (excluded.has(target.deviceId)) {
          skipped.push({ deviceId: target.deviceId, reason: "queued-later" });
          continue;
        }
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
        // Where the device will be: the tail of the switches still in flight (expected, or detached
        // by a settings change), but only if the stale rule will honour them — entries that all predate
        // the device's own navigation would be undone when they land, so they predict nothing. An
        // aligned target gets no switch.
        const expected = state.pending.filter(inFlight);
        const honoured = expected.some((p) => p.seq > state.lastHumanSeq) ? expected : [];
        const willShow = honoured.length ? honoured[honoured.length - 1].page : state.lastKnownPage;
        if (willShow === targetPage) {
          // A parent relying on a child-issued switch still asserts its precedence over the target.
          const carrier = honoured[honoured.length - 1];
          if (member.role === "parent" && carrier && carrier.originRole !== "parent") {
            carrier.originRole = "parent";
            carrier.originId = dev.id;
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
      case "queued-later":
        this.log.debug(`SKIP target=${s.deviceId} seq=${seq} reason=queued-later (its own navigation before start is replayed next)`);
        break;
      case "error":
        break; // logged where it happened
    }
  }

  /** Records the switch, then issues it. The entry exists before the call so an echo can never beat it. */
  private issue(target: DeviceState, profile: string, page: number, originId: string, originRole: Origin, seq: number): Plan {
    const entry: Pending = { seq, page, profile, originId, originRole, issuedAt: this.deps.clock.now(), expired: false };
    target.pending.push(entry);
    // Bounded memory without forgetting: past the cap the oldest still-expected entries become
    // echo tags only (one per page is kept), so a landing can never read as navigation. More
    // than the cap within the TTL is beyond what a person can produce, hence the warning.
    let expected = target.pending.filter((p) => !p.expired).length;
    for (const p of target.pending) {
      if (expected <= this.cap) break;
      if (p.expired) continue;
      p.expired = "cap";
      expected--;
      this.log.warn(`GC dev=${target.id} page=${p.page} seq=${p.seq} reason=cap — more than ${this.cap} switches to this device still awaiting a landing; kept as an echo tag only`);
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
   * Whether an appear for the page the device already shows (a re-emit, or an anchor edit) can
   * stand for the landing of a switch to that page: only when that switch is the oldest the engine
   * still remembers for the device — the app applies switches in order, so an older switch to
   * another page, however stale, would show first, and the device would come back to this page
   * later, with an appear that must still find its entry. Otherwise the switch stays expected.
   */
  private nextInLine(dev: DeviceState, page: number): boolean {
    return dev.pending.length > 0 && dev.pending[0].page === page;
  }

  /**
   * The entry a landing on `page` satisfies. The app applies switches in order, so it is the
   * EARLIEST entry for that page, whatever its state (a tag for the page always precedes a later
   * switch to it) — together with the switches to the same page issued right after it with no
   * other page between, which can never produce another appear: the newest of that run is the
   * match (its seq decides staleness: a later switch wins), the rest become superseded tags.
   * Everything still in flight that was issued BEFORE the match was processed without an appear
   * (the device was already on that page, the page has no anchor, or the app coalesced it) and is
   * superseded too. Everything issued after it stays in flight: the app may still have it queued.
   */
  private consume(dev: DeviceState, page: number): Pending | undefined {
    const first = dev.pending.findIndex((p) => p.page === page);
    if (first < 0) return undefined;
    let last = first;
    while (last + 1 < dev.pending.length && dev.pending[last + 1].page === page) last++;
    const [entry] = dev.pending.splice(last, 1);
    const now = this.deps.clock.now();
    for (const s of dev.pending.slice(0, last)) {
      if (!inFlight(s)) continue;
      this.log.debug(`GC dev=${dev.id} page=${s.page} seq=${s.seq} reason=superseded by seq=${entry.seq} (kept as an echo tag for ${this.ttl}ms)`);
      s.expired = "superseded";
      s.issuedAt = now;
      s.supersededBy = { seq: entry.seq, page: entry.page, profile: entry.profile, originId: entry.originId, originRole: entry.originRole };
    }
    this.dedupeTags(dev);
    return entry;
  }

  /**
   * Ages pending entries. Past the TTL an entry still in flight is marked expired (warn: the
   * switch was not confirmed) but kept as an echo tag; past the grace period it is dropped, a
   * superseded tag after one TTL. Never consulted to classify an appear.
   */
  private expire(dev: DeviceState): void {
    if (!dev.pending.length) return;
    const now = this.deps.clock.now();
    const keep: Pending[] = [];
    for (const p of dev.pending) {
      const age = now - p.issuedAt;
      const lifetime = p.expired === "superseded" ? this.ttl : this.grace;
      if (age > lifetime) {
        this.log.debug(`GC dev=${dev.id} page=${p.page} seq=${p.seq} reason=grace-elapsed (${lifetime}ms without an appear)`);
        continue;
      }
      if (inFlight(p) && age > this.ttl) {
        p.expired = "ttl";
        this.log.warn(`SWITCH unconfirmed dev=${dev.id} profile=${p.profile} page=${p.page} seq=${p.seq} origin=${p.originId} — no appear within ${this.ttl}ms: the device may already have been on that page, the page may have no Page Anchor, or "${p.profile}" may not be bundled`);
      }
      keep.push(p);
    }
    dev.pending = keep;
    this.dedupeTags(dev);
  }

  /**
   * Expired entries are echo tags only, so one per page suffices: keep the newest. Dropping an
   * older tag never changes what a landing matches (a page's tag precedes every switch to it still
   * in flight, and the one kept stands for the same page).
   */
  private dedupeTags(dev: DeviceState): void {
    const seen = new Set<number>();
    for (let i = dev.pending.length - 1; i >= 0; i--) {
      const p = dev.pending[i];
      if (inFlight(p)) continue; // a detached entry is still in flight, not a tag: it keeps its place
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
      dev = { id, armed: false, lastKnownPage: null, pending: [], lastHumanSeq: 0, lastHumanPage: null, lastReceivePage: null, disabledOnly: false, visit: new Set(), leaving: new Set(), drivenRun: 0, overturnRun: 0, leftPage: null };
      this.devices.set(id, dev);
    }
    return dev;
  }
}

const toIssued = ({ deviceId, profile, page, seq }: Plan): IssuedSwitch => ({ deviceId, profile, page, seq });
