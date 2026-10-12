/**
 * CLAUDE.md "Engine purity": these modules may only import types from @elgato/*, so every
 * rule stays unit-testable without the SDK. A runtime import would pass typecheck and build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PURE = ["syncEngine.ts", "settings.ts", "mapping.ts", "profiles.ts", "log.ts", "ids.ts", "piProtocol.ts"];

/** Every import/export statement that names an @elgato package, with whether it is erased at compile time. */
function elgatoStatements(src: string): Array<{ text: string; typeOnly: boolean }> {
  const statements = src.match(/^(import|export)\b[^;]*?["']@elgato\/[^"']+["'][^;]*;/gm) ?? [];
  return statements.map((text) => {
    if (/^(import|export)\s+type\b/.test(text)) return { text, typeOnly: true };
    const bindings = /\{([^}]*)\}/.exec(text)?.[1];
    const every = bindings !== undefined && bindings.split(",").map((b) => b.trim()).filter(Boolean).every((b) => /^type\s/.test(b));
    return { text, typeOnly: every };
  });
}

test.each(PURE)("%s imports nothing from @elgato/* at runtime", (file) => {
  const src = readFileSync(join(__dirname, "..", file), "utf8");
  expect(elgatoStatements(src).filter((s) => !s.typeOnly).map((s) => s.text)).toEqual([]);
  expect(src).not.toMatch(/\b(require|import)\(\s*["']@elgato\//);
});

test("the scan recognises every ESM form", () => {
  const forms = [
    'import streamDeck from "@elgato/streamdeck";',
    'import "@elgato/streamdeck";',
    'export { action } from "@elgato/streamdeck";',
    'import { type A, b } from "@elgato/utils";',
    'import * as sdk from "@elgato/streamdeck";',
  ];
  for (const f of forms) expect(elgatoStatements(f).map((s) => s.typeOnly)).toEqual([false]);
  for (const f of ['import type { JsonObject } from "@elgato/utils";', 'import { type A, type B } from "@elgato/utils";', 'export type { A } from "@elgato/utils";']) {
    expect(elgatoStatements(f).map((s) => s.typeOnly)).toEqual([true]);
  }
});
