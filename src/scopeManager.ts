/**
 * Scope Manager — C-Series scope-based sync logic.
 *
 * Reads global settings, maps devices to scopes, and provides
 * fan-out profile switching with in-flight tracking and settling.
 */
import type { Scope, Role, Mapping, GlobalSettings } from "./globalSettings";
import { createDefaultGlobalSettings, validateGlobalSettings } from "./globalSettings";

/** Internal representation of a scope membership resolved at query time */
export interface ScopeMember {
  /** Device ID */
  deviceId: string;
  /** Whether the device is currently connected */
  connected: boolean;
}

/** Logging level */
export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
}

/**
 * Logger interface — implementations can write to console, file, or
 * Stream Deck plugin logs.  Default writes to console.warn/error/info.
 */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * In-flight switch tracker.  Prevents sync loops by remembering which
 * (deviceId, profile) pairs are currently being applied.
 */
export class InFlightTracker {
  private set = new Set<string>();

  get values(): Set<string> {
    return this.set;
  }

  has(deviceId: string, profile: string): boolean {
    return this.set.has(`${deviceId}:${profile}`);
  }

  add(deviceId: string, profile: string): void {
    this.set.add(`${deviceId}:${profile}`);
  }

  remove(deviceId: string, profile: string): void {
    this.set.delete(`${deviceId}:${profile}`);
  }

  clear(): void {
    this.set.clear();
  }
}

/** Settling window parameters */
export interface SettleConfig {
  /** Duration in ms to ignore incoming will-appear events after a sync */
  windowMs: number;
}

/**
 * The ScopeManager is the central engine for C-Series scope-based sync.
 *
 * Responsibilities:
 *   1. Resolve which scope(s) a device belongs to.
 *      (Empty deviceIds → all devices; otherwise lookup by id.)
 *   2. Fan-out profile switches to all scope members.
 *   3. Prevent sync loops via in-flight tracking.
 *   4. Suppress events during the settle period after a sync.
 *   5. Log all actions at configurable levels.
 */
export class ScopeManager {
  private settings: GlobalSettings;
  private tracker: InFlightTracker;
  private logger: Logger;
  private settleConfig: SettleConfig;
  private settleTimers = new Map<string, NodeJS.Timeout>();

  /**
   * @param settings       Global settings (validated).
   * @param tracker        Shared in-flight tracker (or create new).
   * @param logger         Optional logger (defaults to console).
   * @param settleWindowMs Optional settle window (default 2000 ms).
   */
  constructor(
    settings: GlobalSettings,
    tracker?: InFlightTracker,
    logger?: Logger,
    settleWindowMs = 2000
  ) {
    this.settings = settings;
    this.tracker = tracker ?? new InFlightTracker();
    this.logger = logger ?? new ConsoleLogger();
    this.settleConfig = { windowMs: settleWindowMs };
  }

  /* ---- public getters (needed by PageAnchorAction) ---- */

  /** Expose in-flight tracker for legacy single-device switching */
  getTracker(): InFlightTracker {
    return this.tracker;
  }

  /** Expose logger for diagnostic output */
  getLogger(): Logger {
    return this.logger;
  }

  /** Expose current settings */
  getSettings(): GlobalSettings {
    return this.settings;
  }

  /* ---- public API ---- */

  /**
   * Check whether the source device is in a settling period for the given profile.
   * Returns true if the event should be suppressed.
   */
  isSettling(deviceId: string, profile: string): boolean {
    const key = `${deviceId}:${profile}`;
    return this.settleTimers.has(key);
  }

  /**
   * Start the settling window for a (device, profile) pair.
   * Called after a sync switch is initiated.
   */
  startSettle(deviceId: string, profile: string): void {
    const key = `${deviceId}:${profile}`;
    // Clear any prior timer
    const existing = this.settleTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.settleTimers.delete(key);
      this.logger.debug(`Settle period ended for ${key}`);
    }, this.settleConfig.windowMs);
    this.settleTimers.set(key, timer);
    this.logger.info(`Settle period started for ${key} (${this.settleConfig.windowMs}ms)`);
  }

  /**
   * Get the scope device IDs that contain the given source device.
   * Returns empty array if no scope contains it and no "all" scope exists.
   */
  getScopeDeviceIds(sourceDeviceId: string): string[] {
    // 1. Find scopes that explicitly contain this device
    const explicitScopes = this.settings.scopes.filter((s) =>
      s.deviceIds.includes(sourceDeviceId)
    );

    if (explicitScopes.length > 0) {
      this.logger.debug(`Device ${sourceDeviceId} found in ${explicitScopes.length} scope(s)`);
      const idSet = new Set<string>();
      for (const scope of explicitScopes) {
        for (const id of scope.deviceIds) {
          idSet.add(id);
        }
      }
      return Array.from(idSet);
    }

    // 2. If no explicit scope found, check for an "all" scope (empty deviceIds)
    const allScope = this.settings.scopes.find((s) => s.deviceIds.length === 0);
    if (allScope) {
      this.logger.debug(`No explicit scope for ${sourceDeviceId}, using all-devices scope`);
      // The "all" scope has empty deviceIds, meaning "all devices".
      // We return an empty array here and the caller will use all connected
      // devices as members.
      return [];
    }

    this.logger.warn(`No scope found for ${sourceDeviceId}`);
    return [];
  }

  /**
   * Resolve scope members with live device connectivity information.
   * This is called by the action after getting the scope's device IDs.
   */
  resolveMembers(
    scopeDeviceIds: string[],
    connectedDevices: Array<{ id: string; name: string; isConnected: boolean }>
  ): ScopeMember[] {
    const members: ScopeMember[] = [];
    for (const id of scopeDeviceIds) {
      const live = connectedDevices.find((d) => d.id === id);
      if (live) {
        members.push({ deviceId: id, connected: live.isConnected });
      }
    }
    return members;
  }

  /**
   * Check whether a scope exists for the given source device.
   * Returns true if the device is in an explicit scope OR if there is an "all" scope.
   */
  hasScope(sourceDeviceId: string): boolean {
    const explicit = this.settings.scopes.some((s) => s.deviceIds.includes(sourceDeviceId));
    if (explicit) return true;
    return this.settings.scopes.some((s) => s.deviceIds.length === 0);
  }

  /**
   * Update settings and rebuild internal state.
   */
  updateSettings(settings: GlobalSettings): void {
    const validated = validateGlobalSettings(settings);
    this.settings = validated;
    this.logger.info("Settings updated, scope manager refreshed");
  }

  /**
   * Cleanup: clear all timers.
   */
  dispose(): void {
    for (const timer of this.settleTimers.values()) {
      clearTimeout(timer);
    }
    this.settleTimers.clear();
    this.tracker.clear();
  }
}

/* ---- default logger (console) ---- */

export class ConsoleLogger implements Logger {
  debug(message: string) {
    console.debug(`[DeckSync] ${message}`);
  }
  info(message: string) {
    console.info(`[DeckSync] ${message}`);
  }
  warn(message: string) {
    console.warn(`[DeckSync] ${message}`);
  }
  error(message: string) {
    console.error(`[DeckSync] ${message}`);
  }
}

/* ---- default instance factory ---- */

export function createScopeManager(
  settings?: GlobalSettings,
  settleWindowMs = 2000
): ScopeManager {
  const validated = settings ?? createDefaultGlobalSettings();
  const tracker = new InFlightTracker();
  return new ScopeManager(validated, tracker, new ConsoleLogger(), settleWindowMs);
}