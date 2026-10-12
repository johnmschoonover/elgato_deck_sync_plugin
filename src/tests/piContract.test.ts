/**
 * The Property Inspector page and the plugin's bridge are tested against their own fakes; this
 * pins the two sides to one protocol so a renamed event or field cannot leave both suites green.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(process.cwd(), "com.johnmschoonover.decksync.sdPlugin", "ui", "anchor.html"), "utf8");
const protocol = readFileSync(join(process.cwd(), "src", "piProtocol.ts"), "utf8");
const names = (src: string) => [...src.matchAll(/event: "(\w+)"/g)].map((m) => m[1]);
const [toPluginSide, toPiSide] = protocol.split("export type PluginToPi");
const piToPlugin = names(toPluginSide);
const pluginToPi = names(toPiSide);

test("the protocol declares both directions", () => {
  expect(piToPlugin).toEqual(["getDevices", "getGlobalSettings", "setGlobalSettings"]);
  expect(pluginToPi).toEqual(["devices", "globalSettings", "globalSettingsRejected"]);
});

test("every event the panel sends to the plugin is one the protocol declares, and every reply the protocol declares is one the panel handles", () => {
  const sent = [...html.matchAll(/toPlugin\(\{ event: "(\w+)"/g)].map((m) => m[1]);
  expect(new Set(sent)).toEqual(new Set(piToPlugin));
  for (const event of pluginToPi) expect(html).toContain(`case "${event}":`);
});

test("the fields the panel reads from replies, and sends with a save, are the protocol's", () => {
  for (const field of ["payload.settings", "payload.issues", "payload.id", "payload.devices"]) expect(html).toContain(field);
  expect(html).toMatch(/toPlugin\(\{ event: "setGlobalSettings", settings: \{ version: 2, scopes \}, id \}\)/);
  expect(protocol).toMatch(/event: "setGlobalSettings"; settings: unknown; id\?: number/);
  expect(protocol).toMatch(/event: "globalSettings"; settings: GlobalSettings; issues: SettingsIssue\[\]; id\?: number/);
});
