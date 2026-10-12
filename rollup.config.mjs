import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const isWatching = !!process.env.ROLLUP_WATCH;

/**
 * The bundle is ESM. Once the .sdPlugin folder is copied into the Stream Deck plugins
 * directory there is no ancestor package.json with "type": "module", so emit one next
 * to the bundle (as the official @elgato/cli template does) rather than relying on
 * Node's syntax detection.
 */
const emitModulePackageFile = {
  name: "emit-module-package-file",
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "package.json", source: `{ "type": "module" }` });
  },
};

export default {
  input: "src/plugin.ts",
  output: {
    file: "com.johnmschoonover.decksync.sdPlugin/bin/plugin.js",
    format: "es",
    sourcemap: isWatching,
  },
  plugins: [
    nodeResolve({ exportConditions: ["node"] }),
    commonjs(),
    typescript(),
    emitModulePackageFile,
  ],
};
