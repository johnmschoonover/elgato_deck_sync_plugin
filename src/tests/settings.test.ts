/**
 * PRD §7.2 AC [agent]: the global-settings shape validates and round-trips;
 * scope/role validation rejects two parents, a device in two scopes, etc.
 */
import {
  GLOBAL_SETTINGS_VERSION,
  createDefaultGlobalSettings,
  findScopeForDevice,
  normalizeAnchorSettings,
  validateGlobalSettings,
  type GlobalSettings,
  type Scope,
} from "../settings";

const desk: Scope = {
  id: "desk",
  name: "Desk",
  parentDeviceId: "P",
  members: [
    { deviceId: "P", role: "parent", profile: "profiles/original" },
    { deviceId: "C1", role: "child" },
  ],
  mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 4 } }] },
};

const valid: GlobalSettings = { version: GLOBAL_SETTINGS_VERSION, scopes: [desk] };

/** A deep copy with one scope field replaced. */
const withScope = (patch: Record<string, unknown>) => ({
  version: GLOBAL_SETTINGS_VERSION,
  scopes: [{ ...JSON.parse(JSON.stringify(desk)), ...patch }],
});

describe("validateGlobalSettings", () => {
  test("fresh install (undefined / {}) yields defaults without issues", () => {
    for (const input of [undefined, null, {}]) {
      expect(validateGlobalSettings(input)).toEqual({ settings: createDefaultGlobalSettings(), issues: [] });
    }
  });

  test("valid settings round-trip unchanged through JSON", () => {
    const result = validateGlobalSettings(JSON.parse(JSON.stringify(valid)));
    expect(result.issues).toEqual([]);
    expect(result.settings).toEqual(valid);
  });

  test("fills in defaults: name from id, mapping positional with no overrides", () => {
    const { settings, issues } = validateGlobalSettings({
      version: 2,
      scopes: [{ id: "s", parentDeviceId: "P", members: [{ deviceId: "P", role: "parent" }, { deviceId: "C", role: "child" }] }],
    });
    expect(issues).toEqual([]);
    expect(settings.scopes[0]).toEqual({
      id: "s",
      name: "s",
      parentDeviceId: "P",
      members: [{ deviceId: "P", role: "parent" }, { deviceId: "C", role: "child" }],
      mapping: { mode: "positional", overrides: [] },
    });
  });

  test("a blank parentDeviceId is derived from the parent member", () => {
    const result = validateGlobalSettings(withScope({ parentDeviceId: "" }));
    expect(result.issues).toEqual([]);
    expect(result.settings.scopes[0].parentDeviceId).toBe("P");
  });

  test("a demoted parent reports the missing parent, not the stale parentDeviceId", () => {
    const result = validateGlobalSettings(withScope({ parentDeviceId: "", members: [{ deviceId: "P", role: "child" }, { deviceId: "C1", role: "child" }] }));
    expect(result.issues[0].message).toBe("Scope 'desk' ignored: a scope needs exactly one parent; found 0.");
  });

  test("strips unknown fields and blank profiles", () => {
    const { settings } = validateGlobalSettings({
      version: 2,
      extra: true,
      scopes: [{ ...desk, junk: 1, members: [{ deviceId: "P", role: "parent", profile: "  " }, { deviceId: "C1", role: "child", foo: "bar" }] }],
    });
    expect(settings).toEqual({ version: 2, scopes: [{ ...desk, members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "child" }] }] });
  });

  test.each([
    ["not an object", "nope"],
    ["wrong version", { version: 1, scopes: [] }],
    ["legacy v1 shape", { version: "1.0.0", scopes: [{ id: "all", name: "All", deviceIds: [] }], roles: [], mappings: [] }],
    ["scopes not an array", { version: 2, scopes: {} }],
  ])("%s → defaults plus an issue, never a throw", (_, input) => {
    const result = validateGlobalSettings(input);
    expect(result.settings).toEqual(createDefaultGlobalSettings());
    expect(result.issues).toHaveLength(1);
  });

  test.each([
    ["two parents", withScope({ members: [{ deviceId: "P", role: "parent" }, { deviceId: "C1", role: "parent" }] })],
    ["no parent", withScope({ members: [{ deviceId: "P", role: "child" }, { deviceId: "C1", role: "child" }] })],
    ["no child", withScope({ members: [{ deviceId: "P", role: "parent" }] })],
    ["parentDeviceId is not the parent member", withScope({ parentDeviceId: "C1" })],
    ["unknown role", withScope({ members: [{ deviceId: "P", role: "boss" }, { deviceId: "C1", role: "child" }] })],
    ["device listed twice", withScope({ members: [{ deviceId: "P", role: "parent" }, { deviceId: "P", role: "child" }] })],
    ["members not an array", withScope({ members: "P,C1" })],
    ["unknown mapping mode", withScope({ mapping: { mode: "fancy", overrides: [] } })],
    ["override endpoint not a member", withScope({ mapping: { overrides: [{ a: { deviceId: "P", page: 0 }, b: { deviceId: "X", page: 0 } }] } })],
    ["override negative page", withScope({ mapping: { overrides: [{ a: { deviceId: "P", page: -1 }, b: { deviceId: "C1", page: 0 } }] } })],
    ["override fractional page", withScope({ mapping: { overrides: [{ a: { deviceId: "P", page: 1.5 }, b: { deviceId: "C1", page: 0 } }] } })],
    ["override pairs a device with itself", withScope({ mapping: { overrides: [{ a: { deviceId: "P", page: 0 }, b: { deviceId: "P", page: 1 } }] } })],
    ["same endpoint in two overrides", withScope({ mapping: { overrides: [
      { a: { deviceId: "P", page: 0 }, b: { deviceId: "C1", page: 1 } },
      { a: { deviceId: "P", page: 0 }, b: { deviceId: "C1", page: 2 } },
    ] } })],
  ])("drops a scope with %s and reports it", (_, input) => {
    const result = validateGlobalSettings(input);
    expect(result.settings.scopes).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toMatch(/^Scope 'desk' ignored:/);
    expect(result.issues[0].scopeId).toBe("desk");
  });

  test("a scope without an id is reported by index", () => {
    const result = validateGlobalSettings(withScope({ id: "" }));
    expect(result.settings.scopes).toEqual([]);
    expect(result.issues).toEqual([{ scopeId: undefined, message: "Scope at index 0 ignored: missing 'id'." }]);
  });

  test("a device may belong to one scope only: the later scope is dropped, the first kept", () => {
    const second: Scope = { ...desk, id: "other", name: "Other", parentDeviceId: "P2", members: [{ deviceId: "P2", role: "parent" }, { deviceId: "C1", role: "child" }], mapping: { mode: "positional", overrides: [] } };
    const result = validateGlobalSettings({ version: 2, scopes: [desk, second] });
    expect(result.settings.scopes.map((s) => s.id)).toEqual(["desk"]);
    expect(result.issues).toEqual([{ scopeId: "other", message: expect.stringContaining("device C1 already belongs to scope 'desk'") }]);
  });

  test("duplicate scope ids: later definition ignored", () => {
    const result = validateGlobalSettings({ version: 2, scopes: [desk, { ...desk, members: [{ deviceId: "P3", role: "parent" }, { deviceId: "C3", role: "child" }], parentDeviceId: "P3", mapping: undefined }] });
    expect(result.settings.scopes).toHaveLength(1);
    expect(result.issues[0].message).toContain("defined more than once");
  });

  test("keeps valid scopes when another is invalid", () => {
    const bad = { id: "bad", parentDeviceId: "Q", members: [{ deviceId: "Q", role: "child" }] };
    const result = validateGlobalSettings({ version: 2, scopes: [bad, desk] });
    expect(result.settings.scopes.map((s) => s.id)).toEqual(["desk"]);
    expect(result.issues.map((i) => i.scopeId)).toEqual(["bad"]);
  });
});

describe("findScopeForDevice", () => {
  test("finds the scope containing a member, or undefined", () => {
    expect(findScopeForDevice(valid, "C1")?.id).toBe("desk");
    expect(findScopeForDevice(valid, "nobody")).toBeUndefined();
  });
});

describe("normalizeAnchorSettings", () => {
  test.each([
    [{}, { pageIndex: undefined, enabled: true }],
    [undefined, { pageIndex: undefined, enabled: true }],
    [{ pageIndex: 3 }, { pageIndex: 3, enabled: true }],
    [{ pageIndex: "4", enabled: true }, { pageIndex: 4, enabled: true }],
    [{ pageIndex: "" }, { pageIndex: undefined, enabled: true }],
    [{ pageIndex: -1 }, { pageIndex: undefined, enabled: true }],
    [{ pageIndex: 1.5 }, { pageIndex: undefined, enabled: true }],
    [{ pageIndex: 0, enabled: false }, { pageIndex: 0, enabled: false }],
    [{ enabled: "no" }, { pageIndex: undefined, enabled: true }],
    [{ targetDeviceId: "legacy", targetProfile: "Default" }, { pageIndex: undefined, enabled: true }],
  ])("%j → %j", (input, expected) => {
    expect(normalizeAnchorSettings(input)).toEqual(expected);
  });
});
