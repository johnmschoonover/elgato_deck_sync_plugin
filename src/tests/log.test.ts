import { describeError } from "../log";

test("describeError reports an Error's message and stringifies anything else", () => {
  expect(describeError(new Error("boom"))).toBe("boom");
  expect(describeError("plain")).toBe("plain");
  expect(describeError(42)).toBe("42");
  expect(describeError(undefined)).toBe("undefined");
});
