/**
 * Page mapping (PRD §6.4). The parent's page index is the scope's canonical
 * coordinate: a page on any member is first expressed as a parent page, then
 * each other member's page is derived from it. Positional by default
 * (page N → page N), bounded by the member's page count; an override pins a
 * parent page to a child page in both directions, and a pinned page loses its
 * positional counterpart so every pair of devices maps one-to-one.
 */
import { DEFAULT_PAGE_COUNT, type PageRef, type Scope, type ScopeMember } from "./settings";

export const pageCountOf = (member: ScopeMember): number => member.pageCount ?? DEFAULT_PAGE_COUNT;

const memberOf = (scope: Scope, deviceId: string): ScopeMember | undefined => scope.members.find((m) => m.deviceId === deviceId);

/** Child page pinned to `parentPage` for this child, if any. */
function pinnedChildPage(scope: Scope, childId: string, parentPage: number): number | undefined {
  return scope.mapping.overrides.find((o) => o.b.deviceId === childId && o.a.page === parentPage)?.b.page;
}

/** Parent page pinned to `childPage` for this child, if any. */
function pinnedParentPage(scope: Scope, childId: string, childPage: number): number | undefined {
  return scope.mapping.overrides.find((o) => o.b.deviceId === childId && o.b.page === childPage)?.a.page;
}

/** The child's page for a parent page, or undefined when there is no counterpart. */
export function mapFromParent(scope: Scope, child: ScopeMember, parentPage: number): number | undefined {
  const pinned = pinnedChildPage(scope, child.deviceId, parentPage);
  if (pinned !== undefined) return pinned;
  // Child page N is reserved for another parent page → no positional counterpart.
  if (pinnedParentPage(scope, child.deviceId, parentPage) !== undefined) return undefined;
  return parentPage < pageCountOf(child) ? parentPage : undefined;
}

/** The parent's page for a child page, or undefined when there is no counterpart. */
export function mapToParent(scope: Scope, child: ScopeMember, parent: ScopeMember, childPage: number): number | undefined {
  const pinned = pinnedParentPage(scope, child.deviceId, childPage);
  if (pinned !== undefined) return pinned;
  // Parent page N is reserved for another child page → no positional counterpart.
  if (pinnedChildPage(scope, child.deviceId, childPage) !== undefined) return undefined;
  return childPage < pageCountOf(parent) ? childPage : undefined;
}

/** A page on any member expressed as a parent page (the canonical coordinate). */
export function toCanonical(scope: Scope, from: PageRef): number | undefined {
  const parent = memberOf(scope, scope.parentDeviceId);
  const member = memberOf(scope, from.deviceId);
  if (!parent || !member) return undefined;
  if (from.page >= pageCountOf(member)) return undefined; // a page the source's profile does not have
  if (member.deviceId === parent.deviceId) return from.page;
  return mapToParent(scope, member, parent, from.page);
}

/** The page a member should show for a canonical (parent) page. */
export function fromCanonical(scope: Scope, toDeviceId: string, parentPage: number): number | undefined {
  const member = memberOf(scope, toDeviceId);
  if (!member) return undefined;
  if (member.deviceId === scope.parentDeviceId) return parentPage;
  return mapFromParent(scope, member, parentPage);
}

/** The page `toDeviceId` should show when `from` is active, or undefined when there is no counterpart. */
export function resolveTargetPage(scope: Scope, from: PageRef, toDeviceId: string): number | undefined {
  if (from.deviceId === toDeviceId) return from.page;
  const canonical = toCanonical(scope, from);
  return canonical === undefined ? undefined : fromCanonical(scope, toDeviceId, canonical);
}

export type ResolvedTarget = { member: ScopeMember; page: number | undefined };

/** Every member other than `from.deviceId`, each with its mapped page (undefined = no counterpart). */
export function resolveTargets(scope: Scope, from: PageRef): ResolvedTarget[] {
  const canonical = toCanonical(scope, from);
  return scope.members
    .filter((m) => m.deviceId !== from.deviceId)
    .map((member) => ({ member, page: canonical === undefined ? undefined : fromCanonical(scope, member.deviceId, canonical) }));
}
