/**
 * Bundled profile names (manifest `Profiles[].Name`) by Stream Deck device type.
 * The runtime does not expose the manifest to plugin code, so the table lives
 * here; keep it in step with docs/PROFILES.md and manifest.json.
 */

/** `DeviceType` values from `@elgato/schemas`. */
export const DEFAULT_PROFILE_BY_DEVICE_TYPE: Readonly<Record<number, string>> = {
  0: "profiles/original", // Stream Deck (Original / MK.2)
  1: "profiles/mini", // Stream Deck Mini
  2: "profiles/xl", // Stream Deck XL
  9: "profiles/neo", // Stream Deck Neo
};

/**
 * The profile to switch a scope member to: its explicit `profile` setting,
 * else the default for its device type, else `undefined` (unresolvable).
 */
export function resolveProfile(explicit: string | undefined, deviceType: number | undefined): string | undefined {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  return deviceType === undefined ? undefined : DEFAULT_PROFILE_BY_DEVICE_TYPE[deviceType];
}
