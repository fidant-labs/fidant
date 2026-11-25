import { readFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { createServer, defineConfig } from "vite";
import { LANGUAGE_NAMES, localizedPath, MESSAGES } from "./src/i18n/language.ts";
import { pageHtml } from "./src/i18n/preview.ts";
import { signalingUrlFrom } from "./src/lib/signaling-list.ts";
import { llmsTxt, ORIGIN, sitemap } from "./src/site-files.ts";

const signalsFile = process.env.SIGNALS_FILE;

function readSignals(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error("The signaling list could not be read.");
  }
}

const signalingUrl = signalsFile ? signalingUrlFrom(readSignals(signalsFile)) : "";

const latinGeist = /^assets\/geist-latin-wght-normal-[\w-]+\.woff2$/;
const LANGS = ["en", "sv"] as const;

let root = "";

export default defineConfig({
  define: { __SIGNALING_URL__: JSON.stringify(signalingUrl) },
  plugins: [
    tailwindcss(),
    {
      name: "pages",
      apply: "build",
      enforce: "post",
      configResolved(config) {
        root = config.root;
      },
      async generateBundle(_options, bundle) {
        const index = bundle["index.html"];
        if (index?.type !== "asset" || typeof index.source !== "string") {
          throw new Error("pages: expected index.html in the bundle");
        }
        const shell = index.source;
        const emit = (fileName: string, source: string) =>
          this.emitFile({ type: "asset", fileName, source });
        const prepaint = this.emitFile({
          type: "asset",
          name: "prepaint.js",
          source: readFileSync(join(root, "src/prepaint.js"), "utf8"),
        });
        const src = `/${this.getFileName(prepaint)}`;
        // A short-lived dev server loads the app's .tsx modules with this config, aliases included.
        const server = await createServer({
          root,
          server: { middlewareMode: true, hmr: false, ws: false },
          appType: "custom",
          logLevel: "warn",
        });
        try {
          const { NOT_FOUND, PAGES, renderPage } = (await server.ssrLoadModule(
            "/src/prerender.tsx",
          )) as typeof import("./src/prerender.tsx");
          const sections = [];
          for (const lang of LANGS) {
            const pages = [];
            for (const path of PAGES) {
              const page = renderPage(path, lang);
              const local = localizedPath(path, lang);
              const sv = lang === "en" ? localizedPath(path, "sv") : undefined;
              emit(
                `pages${local === "/" ? "" : local}/index.html`,
                pageHtml(shell, { lang, ...page, image: "preview.png", path, script: { src, sv } }),
              );
              pages.push({ title: page.title, description: page.description, url: ORIGIN + local });
            }
            sections.push({ heading: LANGUAGE_NAMES[lang], pages });
            const missing = renderPage(NOT_FOUND, lang);
            emit(
              lang === "en" ? "pages/404.html" : "pages/sv/404.html",
              pageHtml(shell, { lang, ...missing, image: "preview.png", script: { src } }),
            );
            const t = MESSAGES[lang];
            emit(
              `index.receive.${lang}.html`,
              pageHtml(shell, {
                lang,
                title: t.tabTitles.receive,
                description: t.preview.receiveDescription,
                ogTitle: t.preview.receiveTitle,
                image: "preview-receive.png",
              }),
            );
          }
          emit("sitemap.xml", sitemap(sections.flatMap((s) => s.pages.map((p) => p.url))));
          emit("llms.txt", llmsTxt(MESSAGES.en.footer.tagline, sections));
        } finally {
          await server.close();
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
