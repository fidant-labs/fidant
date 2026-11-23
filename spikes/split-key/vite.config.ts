// Builds the bench into dist/, which serve.ts serves. Pages are listed in
// `pages`; the worker is bundled from its `new Worker(new URL(...))` call.
// A service worker needs a fixed URL for its scope, so when one is added it
// becomes an entry here and entryFileNames maps it to a name without a hash.

import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const pages = { index: resolve(root, "index.html") };

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
      input: pages,
      output: { entryFileNames: "assets/[name]-[hash].js" },
    },
  },
  worker: { format: "es" },
});
