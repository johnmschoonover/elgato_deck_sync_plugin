/** PRD §7.2 AC [agent]: mapping resolution (positional + override). */
import { resolveTargetPage, resolveTargets } from "../mapping";
import type { Scope } from "../settings";

const scope: Scope = {
  id: "desk",
  name: "Desk",
  parentDeviceId: "P",
  members: [
    { deviceId: "P", role: "parent" },
    { deviceId: "C1", role: "child" },
    { deviceId: "C2", role: "child" },
  ],
  mapping: {
    mode: "positional",
    overrides: [
      { a: { deviceId: "P", page: 2 }, b: { deviceId: "C1", page: 4 } },
      { a: { deviceId: "C2", page: 0 }, b: { deviceId: "C1", page: 3 } },
    ],
  },
};

describe("resolveTargetPage", () => {
  test("positional by default", () => {
    expect(resolveTargetPage(scope, { deviceId: "P", page: 1 }, "C1")).toBe(1);
    expect(resolveTargetPage(scope, { deviceId: "C1", page: 0 }, "P")).toBe(0);
  });

  test("override wins in the a→b direction", () => {
    expect(resolveTargetPage(scope, { deviceId: "P", page: 2 }, "C1")).toBe(4);
  });

  test("override is bidirectional (b→a)", () => {
    expect(resolveTargetPage(scope, { deviceId: "C1", page: 4 }, "P")).toBe(2);
    expect(resolveTargetPage(scope, { deviceId: "C1", page: 3 }, "C2")).toBe(0);
  });

  test("an override for another target does not affect positional mapping", () => {
    expect(resolveTargetPage(scope, { deviceId: "P", page: 2 }, "C2")).toBe(2);
  });

  test("pages without an override stay positional even when the device has overrides", () => {
    expect(resolveTargetPage(scope, { deviceId: "P", page: 4 }, "C1")).toBe(4);
  });
});

describe("resolveTargets", () => {
  test("every other member with its mapped page", () => {
    expect(resolveTargets(scope, { deviceId: "P", page: 2 })).toEqual([
      { member: { deviceId: "C1", role: "child" }, page: 4 },
      { member: { deviceId: "C2", role: "child" }, page: 2 },
    ]);
  });

  test("a child send targets the parent and the other children", () => {
    expect(resolveTargets(scope, { deviceId: "C2", page: 0 }).map((t) => [t.member.deviceId, t.page])).toEqual([
      ["P", 0],
      ["C1", 3],
    ]);
  });
});
