/**
 * Page mapping (PRD §6.4): positional by default (page N → page N), with
 * explicit override pairs that hold in both directions.
 */
import type { PageRef, Scope, ScopeMember } from "./settings";

/** The page `toDeviceId` should show when `from` is active. */
export function resolveTargetPage(scope: Scope, from: PageRef, toDeviceId: string): number {
  for (const { a, b } of scope.mapping.overrides) {
    if (a.deviceId === from.deviceId && a.page === from.page && b.deviceId === toDeviceId) return b.page;
    if (b.deviceId === from.deviceId && b.page === from.page && a.deviceId === toDeviceId) return a.page;
  }
  return from.page;
}

/** Every member of the scope other than `deviceId`, each with its resolved target page. */
export function resolveTargets(scope: Scope, from: PageRef): Array<{ member: ScopeMember; page: number }> {
  return scope.members
    .filter((m) => m.deviceId !== from.deviceId)
    .map((member) => ({ member, page: resolveTargetPage(scope, from, member.deviceId) }));
}
