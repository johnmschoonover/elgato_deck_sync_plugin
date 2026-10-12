/**
 * PRD §7.2 AC [agent]: mapping resolution (positional + override), parent-canonical.
 * Scope: P (5 pages), C1 (5 pages, override P:2 ↔ C1:4), C2 (3 pages).
 */
import { fromCanonical, mapFromParent, mapToParent, pageCountOf, resolveTargetPage, resolveTargets, toCanonical } from "../mapping";
import type { Scope } from "../settings";

const P = { deviceId: "P", role: "parent" } as const;
const C1 = { deviceId: "C1", role: "child" } as const;
const C2 = { deviceId: "C2", role: "child", pageCount: 3 } as const;

const scope: Scope = {
  id: "desk",
  name: "Desk",
  parentDeviceId: "P",
  members: [P, C1, C2],
  mapping: { mode: "positional", overrides: [{ a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 4 } }] },
};

const map = (from: string, page: number, to: string) => resolveTargetPage(scope, { deviceId: from, page }, to);

describe("resolveTargetPage", () => {
  test("positional by default, in both directions", () => {
    expect(map("P", 1, "C1")).toBe(1);
    expect(map("C1", 0, "P")).toBe(0);
    expect(map("P", 1, "C2")).toBe(1);
  });

  test("override wins: parent → child and child → parent", () => {
    expect(map("P", 2, "C1")).toBe(4);
    expect(map("C1", 4, "P")).toBe(2);
  });

  test("a pinned page loses its positional counterpart (no two-way collisions)", () => {
    expect(map("P", 4, "C1")).toBeUndefined(); // child page 4 is reserved for parent page 2
    expect(map("C1", 2, "P")).toBeUndefined(); // parent page 2 is reserved for child page 4
  });

  test("an override for one child does not affect another", () => {
    expect(map("P", 2, "C2")).toBe(2);
  });

  test("positional mapping stops at the target's page count", () => {
    expect(map("P", 3, "C2")).toBeUndefined();
    expect(map("P", 2, "C2")).toBe(2);
    expect(map("C1", 3, "C2")).toBeUndefined();
  });

  test("a page beyond the source's own page count has no counterpart anywhere", () => {
    expect(map("P", 7, "C1")).toBeUndefined();
    expect(map("C2", 3, "P")).toBeUndefined();
  });

  test("a child page beyond the parent's page count has no counterpart (the parent is the canonical coordinate)", () => {
    const small: Scope = { ...scope, members: [{ deviceId: "P", role: "parent", pageCount: 3 }, C1, C2], mapping: { mode: "positional", overrides: [] } };
    expect(resolveTargetPage(small, { deviceId: "C1", page: 4 }, "P")).toBeUndefined();
    expect(resolveTargetPage(small, { deviceId: "C1", page: 4 }, "C2")).toBeUndefined();
    expect(resolveTargets(small, { deviceId: "C1", page: 4 }).map((t) => t.page)).toEqual([undefined, undefined]);
    expect(resolveTargetPage(small, { deviceId: "C1", page: 2 }, "P")).toBe(2);
  });

  test("child ↔ child goes through the parent's coordinate", () => {
    expect(map("C1", 4, "C2")).toBe(2); // C1:4 → P:2 → C2:2
    expect(map("C2", 2, "C1")).toBe(4); // C2:2 → P:2 → C1:4
    expect(map("C2", 1, "C1")).toBe(1);
  });

  test("same device maps to itself", () => {
    expect(map("C1", 4, "C1")).toBe(4);
  });

  test("every defined mapping is symmetric", () => {
    const ids = ["P", "C1", "C2"];
    for (const from of ids) for (const to of ids) for (let page = 0; page < 6; page++) {
      const q = map(from, page, to);
      if (q !== undefined) expect(map(to, q, from)).toBe(page);
    }
  });
});

describe("canonical helpers", () => {
  test("toCanonical / fromCanonical", () => {
    expect(toCanonical(scope, { deviceId: "P", page: 3 })).toBe(3);
    expect(toCanonical(scope, { deviceId: "C1", page: 4 })).toBe(2);
    expect(toCanonical(scope, { deviceId: "X", page: 0 })).toBeUndefined();
    expect(fromCanonical(scope, "P", 3)).toBe(3);
    expect(fromCanonical(scope, "C1", 2)).toBe(4);
    expect(fromCanonical(scope, "X", 0)).toBeUndefined();
  });

  test("mapFromParent / mapToParent / pageCountOf", () => {
    expect(mapFromParent(scope, C1, 2)).toBe(4);
    expect(mapToParent(scope, C1, P, 4)).toBe(2);
    expect(pageCountOf(P)).toBe(5);
    expect(pageCountOf(C2)).toBe(3);
  });
});

describe("resolveTargets", () => {
  test("every other member with its mapped page", () => {
    expect(resolveTargets(scope, { deviceId: "P", page: 2 })).toEqual([
      { member: C1, page: 4 },
      { member: C2, page: 2 },
    ]);
  });

  test("a child send targets the parent and the other children", () => {
    expect(resolveTargets(scope, { deviceId: "C2", page: 0 }).map((t) => [t.member.deviceId, t.page])).toEqual([
      ["P", 0],
      ["C1", 0],
    ]);
  });

  test("a page with no canonical counterpart targets nobody", () => {
    expect(resolveTargets(scope, { deviceId: "C1", page: 2 }).map((t) => t.page)).toEqual([undefined, undefined]);
  });
});
