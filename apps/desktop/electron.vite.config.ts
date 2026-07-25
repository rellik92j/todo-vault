import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [
      // Third-party deps and node builtins stay external, but the workspace core
      // is bundled in. It is ESM and the main process output is CJS, so bundling
      // sidesteps the interop entirely rather than leaning on require(esm).
      externalizeDepsPlugin({ exclude: ["todo-vault"] }),
    ],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
  },
  preload: {
    // Left as CJS: a sandboxed preload cannot be an ES module.
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: { "@shared": resolve("src/shared") },
    },
  },
});
