/**
 * Settings schema (PRD §6.5) and validation.
 *
 * Sync configuration — scopes, roles, mappings — lives in the plugin's global
 * settings. A Page Anchor stores only its page identity and an enabled flag.
 *
 * Validation never throws: bad config yields issues the caller logs at warn,
 * and only the scopes that pass are kept (PRD §7.6).
 */
import type { JsonObject } from "@elgato/utils";

export const GLOBAL_SETTINGS_VERSION = 2;

export type DeviceRole = "parent" | "child";

/** Top-level pages in a bundled profile when a member does not say (PRD §10 OQ-2). */
export const DEFAULT_PAGE_COUNT = 5;

export type ScopeMember = {
  deviceId: string;
  role: DeviceRole;
  /** Bundled profile name (manifest `Profiles[].Name`). Blank → default for the device type. */
  profile?: string;
  /** Top-level pages in that profile; positional mapping stops at this bound. Default 5. */
  pageCount?: number;
};

export type PageRef = { deviceId: string; page: number };

/**
 * A pinned page pair, bidirectional: it holds whichever side initiates (PRD §6.4).
 * Overrides always pair a parent page with a child page — the parent's page index is
 * the scope's canonical coordinate, so child↔child mapping goes through it. After
 * validation `a` is the parent endpoint and `b` the child endpoint.
 */
export type MappingOverride = { a: PageRef; b: PageRef };

export type Scope = {
  id: string;
  name: string;
  parentDeviceId: string;
  members: ScopeMember[];
  mapping: { mode: "positional"; overrides: MappingOverride[] };
};

export type GlobalSettings = { version: number; scopes: Scope[] };

/** Per Page Anchor instance settings. `enabled` defaults to true. */
export type AnchorSettings = { pageIndex?: number; enabled?: boolean };

// The SDK persists settings as JSON; these shapes must stay JsonObject-compatible.
type AssertJson<T extends JsonObject> = T;
export type _GlobalSettingsIsJson = AssertJson<GlobalSettings>;
export type _AnchorSettingsIsJson = AssertJson<AnchorSettings>;

export function createDefaultGlobalSettings(): GlobalSettings {
  return { version: GLOBAL_SETTINGS_VERSION, scopes: [] };
}

export type SettingsIssue = {
  /** The scope the issue belongs to, when it is scope-specific. */
  scopeId?: string;
  message: string;
};

export type ValidatedSettings = {
  /** Settings containing only the scopes that passed validation. */
  settings: GlobalSettings;
  /** Everything wrong with the input; empty when the input was fully valid. */
  issues: SettingsIssue[];
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

const isPageIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Validates and normalizes global settings from any JSON value.
 *
 * - `undefined`, `null` or `{}` (fresh install) → defaults, no issues.
 * - Invalid scopes are dropped and reported; valid ones are kept.
 * - A device may belong to one scope only; the first scope listing it wins.
 * - Unknown fields are stripped so they are not persisted.
 */
export function validateGlobalSettings(input: unknown): ValidatedSettings {
  const issues: SettingsIssue[] = [];
  const settings = createDefaultGlobalSettings();

  if (input === undefined || input === null || (isObject(input) && Object.keys(input).length === 0)) {
    return { settings, issues };
  }
  if (!isObject(input)) {
    issues.push({ message: `Global settings must be an object; got ${typeof input}. Using defaults.` });
    return { settings, issues };
  }
  if (input.version !== GLOBAL_SETTINGS_VERSION) {
    issues.push({
      message: `Unsupported global settings version ${JSON.stringify(input.version)}; expected ${GLOBAL_SETTINGS_VERSION}. Reconfigure Deck Sync in the Page Anchor settings.`,
    });
    return { settings, issues };
  }
  if (!Array.isArray(input.scopes)) {
    issues.push({ message: "Global settings: 'scopes' must be an array. Using no scopes." });
    return { settings, issues };
  }

  const seenScopeIds = new Set<string>();
  const deviceToScope = new Map<string, string>();

  input.scopes.forEach((raw, index) => {
    const result = validateScope(raw, index);
    if (!result.scope) {
      issues.push(...result.issues);
      return;
    }
    const scope = result.scope;
    if (seenScopeIds.has(scope.id)) {
      issues.push({ scopeId: scope.id, message: `Scope '${scope.id}' is defined more than once; later definition ignored.` });
      return;
    }
    const clash = scope.members.find((m) => deviceToScope.has(m.deviceId));
    if (clash) {
      issues.push({
        scopeId: scope.id,
        message: `Scope '${scope.id}' ignored: device ${clash.deviceId} already belongs to scope '${deviceToScope.get(clash.deviceId)}'. A device may belong to one scope only.`,
      });
      return;
    }
    seenScopeIds.add(scope.id);
    for (const m of scope.members) deviceToScope.set(m.deviceId, scope.id);
    settings.scopes.push(scope);
    issues.push(...result.issues);
  });

  return { settings, issues };
}

function validateScope(raw: unknown, index: number): { scope?: Scope; issues: SettingsIssue[] } {
  const issues: SettingsIssue[] = [];
  const label = isObject(raw) && isNonEmptyString(raw.id) ? `'${raw.id}'` : `at index ${index}`;
  const fail = (message: string) => ({ issues: [{ scopeId: isObject(raw) && isNonEmptyString(raw.id) ? raw.id : undefined, message: `Scope ${label} ignored: ${message}` }] });

  if (!isObject(raw)) return fail("not an object.");
  if (!isNonEmptyString(raw.id)) return fail("missing 'id'.");
  const id = raw.id;
  const name = isNonEmptyString(raw.name) ? raw.name : id;
  if (!Array.isArray(raw.members)) return fail("'members' must be an array.");

  const members: ScopeMember[] = [];
  for (const [i, m] of raw.members.entries()) {
    if (!isObject(m) || !isNonEmptyString(m.deviceId)) return fail(`member ${i} has no 'deviceId'.`);
    if (m.role !== "parent" && m.role !== "child") return fail(`member ${m.deviceId} has role ${JSON.stringify(m.role)}; expected 'parent' or 'child'.`);
    if (m.profile !== undefined && typeof m.profile !== "string") return fail(`member ${m.deviceId} has a non-string 'profile'.`);
    if (m.pageCount !== undefined && !(typeof m.pageCount === "number" && Number.isInteger(m.pageCount) && m.pageCount >= 1)) {
      return fail(`member ${m.deviceId} has an invalid 'pageCount' (${JSON.stringify(m.pageCount)}); expected an integer ≥ 1.`);
    }
    if (members.some((x) => x.deviceId === m.deviceId)) return fail(`device ${m.deviceId} is listed twice.`);
    const member: ScopeMember = { deviceId: m.deviceId, role: m.role };
    if (isNonEmptyString(m.profile)) member.profile = m.profile.trim();
    if (m.pageCount !== undefined) member.pageCount = m.pageCount;
    members.push(member);
  }

  const parents = members.filter((m) => m.role === "parent");
  if (parents.length !== 1) return fail(`a scope needs exactly one parent; found ${parents.length}.`);
  // parentDeviceId is derived from the parent member; when present it must agree.
  const parentDeviceId = parents[0].deviceId;
  if (isNonEmptyString(raw.parentDeviceId) && raw.parentDeviceId !== parentDeviceId) {
    return fail(`'parentDeviceId' (${raw.parentDeviceId}) is not the parent member (${parentDeviceId}).`);
  }
  if (!members.some((m) => m.role === "child")) return fail("a scope needs at least one child.");

  const overrides: MappingOverride[] = [];
  if (raw.mapping !== undefined) {
    if (!isObject(raw.mapping)) return fail("'mapping' must be an object.");
    if (raw.mapping.mode !== undefined && raw.mapping.mode !== "positional") return fail(`unknown mapping mode ${JSON.stringify(raw.mapping.mode)}.`);
    if (raw.mapping.overrides !== undefined) {
      if (!Array.isArray(raw.mapping.overrides)) return fail("'mapping.overrides' must be an array.");
      // Per child, each parent page and each child page may be pinned once.
      const pinned = new Set<string>();
      for (const [i, o] of raw.mapping.overrides.entries()) {
        if (!isObject(o)) return fail(`override ${i} is not an object.`);
        const refs: PageRef[] = [];
        for (const side of ["a", "b"] as const) {
          const ref = o[side];
          if (!isObject(ref) || !isNonEmptyString(ref.deviceId) || !isPageIndex(ref.page)) {
            return fail(`override ${i}.${side} needs a 'deviceId' and a non-negative integer 'page'.`);
          }
          if (!members.some((m) => m.deviceId === ref.deviceId)) return fail(`override ${i}.${side} refers to ${ref.deviceId}, which is not a member.`);
          refs.push({ deviceId: ref.deviceId, page: ref.page });
        }
        const [first, second] = refs;
        if (first.deviceId === second.deviceId) return fail(`override ${i} pairs device ${first.deviceId} with itself.`);
        const parentRef = first.deviceId === parentDeviceId ? first : second.deviceId === parentDeviceId ? second : undefined;
        if (!parentRef) return fail(`override ${i} must pair a page of the parent (${parentDeviceId}) with a page of a child.`);
        const childRef = parentRef === first ? second : first;
        for (const [ref, label] of [[parentRef, "parent"], [childRef, "child"]] as const) {
          const count = members.find((m) => m.deviceId === ref.deviceId)!.pageCount ?? DEFAULT_PAGE_COUNT;
          if (ref.page >= count) return fail(`override ${i}: page ${ref.page} of ${ref.deviceId} is beyond its ${count} pages.`);
          const key = `${childRef.deviceId}:${label}:${ref.page}`;
          if (pinned.has(key)) return fail(`override ${i}: ${label} page ${ref.page} is already pinned for child ${childRef.deviceId}.`);
          pinned.add(key);
        }
        overrides.push({ a: parentRef, b: childRef });
      }
    }
  }

  return { scope: { id, name, parentDeviceId, members, mapping: { mode: "positional", overrides } }, issues };
}

/** The scope a device belongs to, if any. Validated settings list each device at most once. */
export function findScopeForDevice(settings: GlobalSettings, deviceId: string): Scope | undefined {
  return settings.scopes.find((s) => s.members.some((m) => m.deviceId === deviceId));
}

export type NormalizedAnchorSettings = { pageIndex: number | undefined; enabled: boolean };

/**
 * Reads a Page Anchor's settings leniently: `pageIndex` must be a non-negative
 * integer (numeric strings from form inputs are accepted); only an explicit
 * `enabled: false` disables the marker.
 */
export function normalizeAnchorSettings(input: unknown): NormalizedAnchorSettings {
  const raw = isObject(input) ? input : {};
  const n = typeof raw.pageIndex === "string" && raw.pageIndex.trim() !== "" ? Number(raw.pageIndex) : raw.pageIndex;
  return { pageIndex: isPageIndex(n) ? n : undefined, enabled: raw.enabled !== false };
}
