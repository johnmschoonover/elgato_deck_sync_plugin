/**
 * CLAUDE.md "Engine purity": these modules may only import types from @elgato/*, so every
 * rule stays unit-testable without the SDK. A runtime import would pass typecheck and build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PURE = ["syncEngine.ts", "settings.ts", "mapping.ts", "profiles.ts", "log.ts", "ids.ts", "piProtocol.ts"];

test.each(PURE)("%s imports nothing from @elgato/* at runtime", (file) => {
  const src = readFileSync(join(__dirname, "..", file), "utf8");
  const runtimeImports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(@elgato\/[^"]+)"/gm)].filter((m) => !m[1]).map((m) => m[2]);
  expect(runtimeImports).toEqual([]);
  expect(src).not.toMatch(/\b(require|import)\(\s*["']@elgato\//);
});
