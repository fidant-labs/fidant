// Builds the bench into dist/, which serve.ts serves. Pages are listed in
// `pages`; the worker is bundled from its `new Worker(new URL(...))` call.
// The service worker needs a fixed URL for its scope, so it is an entry of
// its own and entryFileNames maps it to /sw.js without a hash. It imports
// types only, so its bundle is one classic script with no shared chunks.

import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const pages = {
  index: resolve(root, "index.html"),
  handoff: resolve(root, "handoff.html"),
};

export default defineConfig({
  root,
  // The bench is not shipped, so no public/ folder and no dev server use.
  publicDir: false,
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    target: "es2022",
    // Every browser the bench targets supports modulepreload natively.
    modulePreload: { polyfill: false },
    rolldownOptions: {
      input: { ...pages, sw: resolve(root, "src/bench/sw.ts") },
      output: {
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  worker: { format: "es" },
});
