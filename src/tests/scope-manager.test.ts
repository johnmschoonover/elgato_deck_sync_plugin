// C-Series: Scope Manager tests
import {
  ScopeManager,
  InFlightTracker,
  ConsoleLogger,
  createScopeManager,
  ScopeMember,
} from "../scopeManager";
import {
  GlobalSettings,
  createDefaultGlobalSettings,
} from "../globalSettings";

describe("ScopeManager — C-Series", () => {
  let scopeMgr: ScopeManager;
  let mockLogger: { debug: jest.Mock; info: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const defaultSettings = createDefaultGlobalSettings();
    scopeMgr = new ScopeManager(
      defaultSettings,
      new InFlightTracker(),
      mockLogger,
      2000
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    scopeMgr.dispose();
  });

  describe("InFlightTracker", () => {
    test("has() returns false for unset entries", () => {
      const tracker = new InFlightTracker();
      expect(tracker.has("device1", "ProfileA")).toBe(false);
    });

    test("has() returns true after add()", () => {
      const tracker = new InFlightTracker();
      tracker.add("device1", "ProfileA");
      expect(tracker.has("device1", "ProfileA")).toBe(true);
    });

    test("has() returns false after remove()", () => {
      const tracker = new InFlightTracker();
      tracker.add("device1", "ProfileA");
      tracker.remove("device1", "ProfileA");
      expect(tracker.has("device1", "ProfileA")).toBe(false);
    });

    test("clear() removes all entries", () => {
      const tracker = new InFlightTracker();
      tracker.add("device1", "ProfileA");
      tracker.add("device2", "ProfileB");
      tracker.clear();
      expect(tracker.has("device1", "ProfileA")).toBe(false);
      expect(tracker.has("device2", "ProfileB")).toBe(false);
    });

    test("values getter returns the internal set", () => {
      const tracker = new InFlightTracker();
      tracker.add("device1", "ProfileA");
      expect(tracker.values.has("device1:ProfileA")).toBe(true);
    });
  });

  describe("Settling", () => {
    test("isSettling() returns false initially", () => {
      expect(scopeMgr.isSettling("device1", "ProfileA")).toBe(false);
    });

    test("startSettle() activates settling window", () => {
      scopeMgr.startSettle("device1", "ProfileA");
      expect(scopeMgr.isSettling("device1", "ProfileA")).toBe(true);
    });

    test("settle period expires after windowMs", () => {
      scopeMgr.startSettle("device1", "ProfileA");
      expect(scopeMgr.isSettling("device1", "ProfileA")).toBe(true);
      jest.advanceTimersByTime(2001);
      expect(scopeMgr.isSettling("device1", "ProfileA")).toBe(false);
    });

    test("startSettle() resets timer on re-entry", () => {
      scopeMgr.startSettle("device1", "ProfileA");
      jest.advanceTimersByTime(1000);
      scopeMgr.startSettle("device1", "ProfileA");
      jest.advanceTimersByTime(1000);
      // Still settling because timer was reset
      expect(scopeMgr.isSettling("device1", "ProfileA")).toBe(true);
    });

    test("different devices have independent settle windows", () => {
      scopeMgr.startSettle("device1", "ProfileA");
      expect(scopeMgr.isSettling("device1", "ProfileA")).toBe(true);
      expect(scopeMgr.isSettling("device2", "ProfileA")).toBe(false);
    });
  });

  describe("getScopeDeviceIds", () => {
    test("explicit scope returns matching device IDs", () => {
      const settings: GlobalSettings = {
        version: "1.0.0",
        scopes: [
          { id: "dev-office", name: "Office", deviceIds: ["device1", "device2"] },
        ],
        roles: [],
        mappings: [],
        defaultActionSettings: {
          targetDeviceId: "",
          targetProfile: "",
          enabled: true,
        },
      };
      const mgr = new ScopeManager(settings, new InFlightTracker(), mockLogger);
      const result = mgr.getScopeDeviceIds("device1");
      expect(result).toContain("device1");
      expect(result).toContain("device2");
      mgr.dispose();
    });

    test("returns empty for all-devices scope (empty deviceIds)", () => {
      const settings: GlobalSettings = {
        version: "1.0.0",
        scopes: [
          { id: "all", name: "All Devices", deviceIds: [] },
        ],
        roles: [],
        mappings: [],
        defaultActionSettings: {
          targetDeviceId: "",
          targetProfile: "",
          enabled: true,
        },
      };
      const mgr = new ScopeManager(settings, new InFlightTracker(), mockLogger);
      const result = mgr.getScopeDeviceIds("device1");
      expect(result).toEqual([]);
      mgr.dispose();
    });

    test("hasScope() returns true for explicit scope", () => {
      const settings: GlobalSettings = {
        version: "1.0.0",
        scopes: [
          { id: "dev-office", name: "Office", deviceIds: ["device1"] },
        ],
        roles: [],
        mappings: [],
        defaultActionSettings: {
          targetDeviceId: "",
          targetProfile: "",
          enabled: true,
        },
      };
      const mgr = new ScopeManager(settings, new InFlightTracker(), mockLogger);
      expect(mgr.hasScope("device1")).toBe(true);
      mgr.dispose();
    });

    test("hasScope() returns true for all-devices scope", () => {
      const settings: GlobalSettings = {
        version: "1.0.0",
        scopes: [
          { id: "all", name: "All Devices", deviceIds: [] },
        ],
        roles: [],
        mappings: [],
        defaultActionSettings: {
          targetDeviceId: "",
          targetProfile: "",
          enabled: true,
        },
      };
      const mgr = new ScopeManager(settings, new InFlightTracker(), mockLogger);
      expect(mgr.hasScope("device1")).toBe(true);
      mgr.dispose();
    });
  });

  describe("resolveMembers", () => {
    test("resolves members with connectivity info", () => {
      const scopeDeviceIds = ["device1", "device2", "device3"];
      const connectedDevices = [
        { id: "device1", name: "Deck 1", isConnected: true },
        { id: "device2", name: "Deck 2", isConnected: true },
        { id: "device3", name: "Deck 3", isConnected: false },
      ];
      const result = scopeMgr.resolveMembers(
        scopeDeviceIds,
        connectedDevices
      );
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ deviceId: "device1", connected: true });
      expect(result[2]).toEqual({ deviceId: "device3", connected: false });
    });
  });

  describe("updateSettings", () => {
    test("updates internal settings", () => {
      const newSettings: GlobalSettings = {
        version: "2.0.0",
        scopes: [
          { id: "dev-office", name: "Office", deviceIds: ["device1", "device2"] },
        ],
        roles: [],
        mappings: [],
        defaultActionSettings: {
          targetDeviceId: "",
          targetProfile: "",
          enabled: true,
        },
      };
      scopeMgr.updateSettings(newSettings);
      expect(scopeMgr.getSettings().version).toBe("2.0.0");
    });

    test("throws on invalid settings", () => {
      expect(() => {
        scopeMgr.updateSettings({} as GlobalSettings);
      }).toThrow("Invalid GlobalSettings");
    });
  });

  describe("dispose", () => {
    test("clears all settle timers", () => {
      scopeMgr.startSettle("device1", "ProfileA");
      scopeMgr.startSettle("device2", "ProfileB");
      scopeMgr.dispose();
      // After dispose, timers are cleared
      // The internal set should be empty too
      expect(scopeMgr.getTracker().values.size).toBe(0);
    });
  });

  describe("ConsoleLogger", () => {
    test("writes debug messages to console.debug", () => {
      const logger = new ConsoleLogger();
      const spy = jest.spyOn(console, "debug").mockImplementation();
      logger.debug("test message");
      expect(spy).toHaveBeenCalledWith("[DeckSync] test message");
      spy.mockRestore();
    });

    test("writes info messages to console.info", () => {
      const logger = new ConsoleLogger();
      const spy = jest.spyOn(console, "info").mockImplementation();
      logger.info("test message");
      expect(spy).toHaveBeenCalledWith("[DeckSync] test message");
      spy.mockRestore();
    });

    test("writes warn messages to console.warn", () => {
      const logger = new ConsoleLogger();
      const spy = jest.spyOn(console, "warn").mockImplementation();
      logger.warn("test message");
      expect(spy).toHaveBeenCalledWith("[DeckSync] test message");
      spy.mockRestore();
    });

    test("writes error messages to console.error", () => {
      const logger = new ConsoleLogger();
      const spy = jest.spyOn(console, "error").mockImplementation();
      logger.error("test message");
      expect(spy).toHaveBeenCalledWith("[DeckSync] test message");
      spy.mockRestore();
    });
  });

  describe("createScopeManager factory", () => {
    test("creates a scope manager with defaults", () => {
      const mgr = createScopeManager();
      expect(mgr.getSettings().version).toBe("1.0.0");
      expect(mgr.isSettling("device1", "ProfileA")).toBe(false);
      mgr.dispose();
    });

    test("creates a scope manager with custom settings", () => {
      const custom: GlobalSettings = {
        version: "3.0.0",
        scopes: [{ id: "custom", name: "Custom", deviceIds: ["d1"] }],
        roles: [],
        mappings: [],
        defaultActionSettings: {
          targetDeviceId: "",
          targetProfile: "",
          enabled: true,
        },
      };
      const mgr = createScopeManager(custom);
      expect(mgr.getSettings().version).toBe("3.0.0");
      mgr.dispose();
    });

    test("creates a scope manager with custom settle window", () => {
      const mgr = createScopeManager(undefined, 5000);
      mgr.startSettle("device1", "ProfileA");
      expect(mgr.isSettling("device1", "ProfileA")).toBe(true);
      jest.advanceTimersByTime(4000);
      // Still settling (4s < 5s)
      expect(mgr.isSettling("device1", "ProfileA")).toBe(true);
      jest.advanceTimersByTime(1000);
      // Now expired (5s)
      expect(mgr.isSettling("device1", "ProfileA")).toBe(false);
      mgr.dispose();
    });
  });
});