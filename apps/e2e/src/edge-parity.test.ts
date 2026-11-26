import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
// ponytail: relative import, not a workspace dependency on the server, for one function.
import { serveRelays, serveStatic } from "../../server/src/server.ts";
import { type EdgeAnswer, edgeAnswer, edgePages, viewerRequest } from "./edge.ts";

const root = mkdtempSync(join(tmpdir(), "sigill-edge-"));
const files: Record<string, string> = {
  "index.html": "shell",
  "index.receive.en.html": "receive en",
  "index.receive.sv.html": "receive sv",
  "pages/404.html": "404 en",
  "pages/sv/404.html": "404 sv",
  "assets/app.js": "console.log(1)",
  "favicon.svg": "<svg></svg>",
  "robots.txt": "User-agent: *",
  "assets/app.css": "a{}",
  "data.json": "{}",
  "preview.png": "png",
  "favicon.ico": "ico",
  "assets/font.woff2": "woff2",
  "sitemap.xml": "<urlset/>",
  ...Object.fromEntries(
    edgePages.map((page) => [page === "/" ? "pages/index.html" : `pages${page}/index.html`, page]),
  ),
};
for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

const server = createServer(serveStatic(root));
before(() => new Promise<void>((done) => server.listen(0, done)));
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

function fromServer(target: string, headers: Record<string, string>): Promise<EdgeAnswer> {
  const port = (server.address() as AddressInfo).port;
  return new Promise((done, fail) => {
    get({ host: "localhost", port, path: target, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const kept = Object.entries(res.headers).filter(([name]) => !transport.has(name));
        done({
          status: res.statusCode ?? 0,
          headers: Object.fromEntries(kept.map(([name, value]) => [name, String(value)])),
          body: Buffer.concat(chunks),
        });
      });
    }).on("error", fail);
  });
}

const transport = new Set([
  "date",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
]);
const signals = JSON.parse(
  readFileSync(new URL("../../web/signals.json", import.meta.url), "utf8"),
) as { url: string }[];
const signalOrigin = new URL(signals[0]?.url ?? "").origin;

const cases: [string, Record<string, string>?][] = [
  ["/"],
  ["/send"],
  ["/send/"],
  ["/Send"],
  ["/send.html"],
  ["/SEND.HTML"],
  ["/index.html"],
  ["/index.HTML"],
  ["/index.receive.en.html"],
  ["/pages/about/index.html"],
  ["/pages/404.HTML"],
  ["/technical"],
  ["/technical/?a=1&b=x%2Fy"],
  ["/send?"],
  ["/sv"],
  ["/sv/"],
  ["/sv/skicka"],
  ["/sv/nope"],
  ["/sv//om/"],
  ["/nope"],
  ["/relay-status"],
  ["/signal"],
  ["/r/abc", { "accept-language": "en-US" }],
  ["/r/abc", { "accept-language": "sv-SE,sv;q=0.9" }],
  ["/r/abc"],
  ["/r/"],
  ["/r/a.b"],
  ["/assets/app.js"],
  ["/assets//app.js"],
  ["/assets/missing.js"],
  ["/assets/nope"],
  ["/assets/"],
  ["/assets/..%2findex.html"],
  ["/favicon.svg"],
  ["/favicon.svg/"],
  ["/FAVICON.SVG"],
  ["/a/..%2ffavicon.svg"],
  ["/robots.txt"],
  ["/assets/app.css"],
  ["/data.json"],
  ["/preview.png"],
  ["/favicon.ico"],
  ["/assets/font.woff2"],
  ["/sitemap.xml"],
  ["/%E0"],
  ["/%E0%A4%A"],
  ["/a%20b"],
  ["/se%6Ed"],
  ["/send/."],
  ["/a/../about"],
  ["/x/..%2fabout"],
  ["//about/"],
  ["//evil.example/"],
  ["/%2f%2fevil.example/"],
  ["//x/about"],
  ["/..%2fsecret.txt"],
  ["/%2e%2e/secret.txt"],
  ["/%2e%2e/favicon.svg"],
  ["/a/%2E%2e/favicon.svg"],
  ["/..%2ffavicon.svg"],
  ["/a\\..\\favicon.svg"],
  ["/.env"],
  ...edgePages.map((page): [string] => [page]),
];

test("the edge function answers every case as serveStatic does, but for its one CSP source", async () => {
  for (const [target, headers = {}] of cases) {
    const expected = await fromServer(target, headers);
    for (const sees of ["rewritten", "viewer"] as const) {
      const what = `${target} ${JSON.stringify(headers)} (${sees})`;
      const got = await edgeAnswer(
        root,
        { method: "GET", host: "fidant.se", target, headers },
        sees,
      );
      if (Object.keys(got.headers).length === 0) {
        // A missing file is S3's own 404, without the headers (decision 0023).
        assert.equal(got.status, 404, what);
        assert.equal(expected.status, 404, what);
        assert.equal(expected.body.length, 0, what);
        continue;
      }
      const { "strict-transport-security": hsts, ...shared } = got.headers;
      assert.ok(hsts, what);
      assert.deepEqual(
        { ...shared, "content-security-policy": undefined },
        { ...expected.headers, "content-security-policy": undefined },
        what,
      );
      assert.equal(
        shared["content-security-policy"],
        `${expected.headers["content-security-policy"]}; connect-src 'self' ${signalOrigin}`,
        what,
      );
      assert.equal(got.status, expected.status, what);
      assert.equal(got.body.toString(), expected.body.toString(), what);
    }
  }
});

test("other methods get CloudFront's 403, where the server answers 405", async () => {
  const got = await edgeAnswer(root, { method: "POST", host: "fidant.se", target: "/" });
  assert.equal(got.status, 403);
});

test("the function passes /relay-secret/ exactly when the server hands out a secret", async () => {
  const relays = { handOut: (id: string) => `sealed-${id}`, status: () => [] };
  const listener = serveRelays(relays as never, (_req, res) => res.writeHead(418).end());
  const server = createServer(listener);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const status = (path: string) =>
    new Promise<string>((done, fail) =>
      get({ host: "127.0.0.1", port, path }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => done(`${res.statusCode} ${body}`));
      }).on("error", fail),
    );
  const normalised = [
    "//relay-secret/sto",
    "/./relay-secret/sto",
    "/a/../relay-secret/sto",
    "/%72elay-secret/sto",
  ];
  try {
    for (const target of [
      "/relay-secret/sto",
      `/relay-secret/${"a".repeat(16)}`,
      "/relay-secret/a",
      `/relay-secret/${"a".repeat(17)}`,
      "/relay-secret/STO",
      "/relay-secret/1sto",
      "/relay-secret/-sto",
      "/relay-secret/sto/x",
      "/relay-secret/%2e%2e/relay-status",
      "/relay-secret/",
      "//relay-secret/sto",
      "/./relay-secret/sto",
      "/a/../relay-secret/sto",
      "/a/../relay-secret/x.js",
      "/%72elay-secret/sto",
    ]) {
      const got = viewerRequest({ method: "GET", host: "fidant.se", target });
      const passed = !("statusCode" in got);
      if (!passed) {
        assert.equal(got.statusCode, 404, target);
        assert.equal(Object.keys(got.headers).length, 4, target);
        for (const name of [
          "content-security-policy",
          "referrer-policy",
          "x-content-type-options",
        ]) {
          assert.ok(got.headers[name], `${target} ${name}`);
        }
      }
      const served = (await status(target)).startsWith("200 sealed-");
      assert.equal(passed, served && !normalised.includes(target), target);
    }
  } finally {
    server.close();
  }
});
