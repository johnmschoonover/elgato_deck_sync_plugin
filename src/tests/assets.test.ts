/**
 * PRD §7.7 AC [agent]: every manifest icon path resolves to a PNG of the
 * expected dimensions, with an @2x variant at double size.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_DIR = join(__dirname, "..", "..", "com.johnmschoonover.decksync.sdPlugin");

interface ManifestShape {
  Icon: string;
  CategoryIcon?: string;
  Actions: Array<{ Icon: string; States: Array<{ Image: string }> }>;
}

const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")) as ManifestShape;

/** Sizes from PRD §7.7 (1x). */
const expected: Array<{ what: string; path: string; size: number }> = [
  { what: "plugin Icon", path: manifest.Icon, size: 288 },
  ...manifest.Actions.map((a, i) => ({ what: `Actions[${i}].Icon`, path: a.Icon, size: 20 })),
  ...manifest.Actions.flatMap((a, i) =>
    a.States.map((s, j) => ({ what: `Actions[${i}].States[${j}].Image`, path: s.Image, size: 72 }))
  ),
];
if (manifest.CategoryIcon) {
  expected.push({ what: "CategoryIcon", path: manifest.CategoryIcon, size: 28 });
}

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  const signature = "89504e470d0a1a0a";
  expect(buf.subarray(0, 8).toString("hex")).toBe(signature);
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("manifest image assets", () => {
  test.each(expected)("$what ($path) is $size px with an @2x variant", ({ path, size }) => {
    for (const [suffix, px] of [["", size], ["@2x", size * 2]] as const) {
      const file = join(PLUGIN_DIR, `${path}${suffix}.png`);
      expect(existsSync(file)).toBe(true);
      expect(pngSize(file)).toEqual({ width: px, height: px });
    }
  });
});
