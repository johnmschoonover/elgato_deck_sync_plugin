/**
 * PRD §7.4 AC [agent]: manifest Profiles entries are consistent with the engine's
 * default profile table and exist on disk. Until D1 exports land the manifest has
 * no Profiles; the registration half of the AC is tracked by the todo below.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILE_BY_DEVICE_TYPE, resolveProfile } from "../profiles";

const PLUGIN_DIR = join(__dirname, "..", "..", "com.johnmschoonover.decksync.sdPlugin");
const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")) as { Profiles?: Array<{ DeviceType: number; Name: string }> };

describe("bundled profiles", () => {
  test("every manifest profile matches the default table for its device type and exists on disk", () => {
    for (const p of manifest.Profiles ?? []) {
      expect(DEFAULT_PROFILE_BY_DEVICE_TYPE[p.DeviceType]).toBe(p.Name);
      expect(existsSync(join(PLUGIN_DIR, `${p.Name}.streamDeckProfile`))).toBe(true);
    }
  });

  test.todo("D2: every default profile name is registered in manifest Profiles (waits on the D1 exports, docs/PROFILES.md)");

  test("default names follow the docs/PROFILES.md convention", () => {
    for (const name of Object.values(DEFAULT_PROFILE_BY_DEVICE_TYPE)) expect(name).toMatch(/^profiles\/[a-z]+$/);
  });
});

describe("resolveProfile", () => {
  test.each([
    ["explicit profile wins", "profiles/custom", 1, "profiles/custom"],
    ["explicit profile is trimmed", "  profiles/custom ", 1, "profiles/custom"],
    ["blank explicit falls back to the device type", "  ", 1, "profiles/mini"],
    ["undefined explicit falls back to the device type", undefined, 0, "profiles/original"],
    ["unknown device type has no default", undefined, 7, undefined],
    ["unknown device", undefined, undefined, undefined],
  ])("%s", (_, explicit, type, expected) => {
    expect(resolveProfile(explicit, type)).toBe(expected);
  });
});
