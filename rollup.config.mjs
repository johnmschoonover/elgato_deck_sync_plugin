import typescript from "@rollup/plugin-typescript";
import { nodeResolve } from "@rollup/plugin-node-resolve";

export default {
  input: "src/plugin.ts",
  output: {
    file: "com.johnmschoonover.decksync.sdPlugin/bin/plugin.js",
    format: "es",
    sourcemap: true,
  },
  plugins: [
    nodeResolve({ exportConditions: ["node"] }),
    typescript(),
  ],
};
