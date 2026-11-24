import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { previewPage } from "./src/i18n/preview.ts";

const latinGeist = /^assets\/geist-latin-wght-normal-[\w-]+\.woff2$/;

export default defineConfig({
  plugins: [
    tailwindcss(),
    {
      name: "link-previews",
      apply: "build",
      enforce: "post",
      generateBundle(_options, bundle) {
        const index = bundle["index.html"];
        if (index?.type !== "asset" || typeof index.source !== "string") {
          throw new Error("link-previews: expected index.html in the bundle");
        }
        for (const lang of ["en", "sv"] as const) {
          for (const kind of ["home", "receive"] as const) {
            this.emitFile({
              type: "asset",
              fileName: `index.${kind}.${lang}.html`,
              source: previewPage(index.source, lang, kind),
            });
          }
        }
      },
    },
    {
      name: "preload-geist",
      apply: "build",
      transformIndexHtml(_html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {}).filter((key) => latinGeist.test(key));
        if (fonts.length !== 1) {
          throw new Error(
            `preload-geist: expected one bundle file matching ${latinGeist}, found ${fonts.length}`,
          );
        }
        return [
          {
            tag: "link",
            attrs: {
              rel: "preload",
              as: "font",
              type: "font/woff2",
              // Without crossorigin the preload misses the CSS font fetch and downloads twice.
              crossorigin: true,
              href: `/${fonts[0]}`,
            },
            injectTo: "head-prepend",
          },
        ];
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^react$/, replacement: "preact/compat" },
      { find: /^react-dom$/, replacement: "preact/compat" },
      { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
    ],
  },
});
