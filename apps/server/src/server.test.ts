import assert from "node:assert/strict";
import {
  constants,
  createHmac,
  generateKeyPairSync,
  privateDecrypt,
  X509Certificate,
} from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer,
  get as httpGet,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
} from "node:http";
import { get as httpsGet, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseServerMessage } from "@sigill/protocol";
import { WebSocket as WsClient } from "ws";
import { relaySecret } from "./relay-secret.ts";
import { type Relay, startRelays } from "./relays.ts";
import { ensureCert, serveRelays, serveStatic, startServer } from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "sigill-server-"));
const root = join(dir, "dist");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Sigill</title>");
for (const page of ["receive.en", "receive.sv"]) {
  writeFileSync(join(root, `index.${page}.html`), `<!doctype html><title>${page}</title>`);
}
for (const page of [
  "index",
  "about/index",
  "how/index",
  "sv/index",
  "sv/om/index",
  "sv/sa-fungerar-det/lamnas-kvar/index",
  "404",
  "sv/404",
]) {
  mkdirSync(join(root, "pages", page, ".."), { recursive: true });
  writeFileSync(join(root, "pages", `${page}.html`), `<!doctype html><title>${page}</title>`);
}
writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
writeFileSync(join(root, "assets", "x-abc.js"), "console.log(2)");
writeFileSync(join(root, "favicon.svg"), "<svg></svg>");
writeFileSync(join(root, "robots.txt"), "User-agent: *");
writeFileSync(join(dir, "secret.txt"), "outside the web root");

const plain = createServer(serveStatic(root));
let base = "";
before(async () => {
  await new Promise<void>((done) => plain.listen(0, done));
  base = `http://localhost:${(plain.address() as AddressInfo).port}`;
});
after(() => plain.close());

function rawGet(
  path: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((done, fail) => {
    httpGet({ host: "localhost", port: (plain.address() as AddressInfo).port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on("error", fail);
  });
}

test("serves the front page with security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  // data: images only for the tab's status icon, which must not ask the server for anything.
  assert.match(
    res.headers.get("content-security-policy") ?? "",
    /default-src 'self'; img-src 'self' data:;/,
  );
});

test("serves assets with their content type", async () => {
  const res = await fetch(`${base}/assets/app.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("serves .txt files as plain text", async () => {
  const res = await fetch(`${base}/robots.txt`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
});

/** A GET or HEAD that doesn't follow redirects. */
async function page(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  return {
    status: res.status,
    body: await res.text(),
    headers: Object.fromEntries(res.headers),
  };
}

test("public pages get their own file, whatever the browser's language, with no Vary", async () => {
  for (const [path, file] of [
    ["/", "index"],
    ["/about", "about/index"],
    ["/how", "how/index"],
    ["/sv", "sv/index"],
    ["/sv/om", "sv/om/index"],
    ["/sv/sa-fungerar-det/lamnas-kvar", "sv/sa-fungerar-det/lamnas-kvar/index"],
  ] as const) {
    const res = await page(path, { headers: { "accept-language": "sv-SE,sv;q=0.9" } });
    assert.equal(res.status, 200, path);
    assert.equal(res.body, `<!doctype html><title>${file}</title>`, path);
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8", path);
    assert.equal(res.headers.vary, undefined, path);
    assert.equal(res.headers["x-robots-tag"], undefined, path);
  }
});

test("receive paths get the receive copy, Vary and noindex, valid or not", async () => {
  const linkId = "AAAAAAAAAAAAAAAAAAAAAA";
  for (const [path, language, copy] of [
    [`/r/${linkId}`, "sv-SE,sv;q=0.9", "receive.sv"],
    [`/r/${linkId}/`, "en-US,sv;q=0.5", "receive.en"],
    [`/r/${linkId}`, "svx", "receive.en"],
    [`/r/${linkId}`, undefined, "receive.en"],
    ["/r/abc123", "sv", "receive.sv"],
    [`/r/${linkId}/more`, undefined, "receive.en"],
  ] as const) {
    const res = await page(path, language ? { headers: { "accept-language": language } } : {});
    assert.equal(res.status, 200, path);
    assert.equal(res.body, `<!doctype html><title>${copy}</title>`, `${path} ${language}`);
    assert.equal(res.headers.vary, "accept-language", path);
    assert.equal(res.headers["x-robots-tag"], "noindex", path);
  }
  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.headers.get("vary"), null);
});

test("unknown paths get the not-found page in the path's language", async () => {
  for (const [path, file] of [
    ["/no-such-page", "404"],
    ["/nope", "404"],
    ["/About", "404"],
    ["/how/nope", "404"],
    ["/index", "404"],
    ["/svenska", "404"],
    ["/sv/nope", "sv/404"],
    ["/sv/how/nope", "sv/404"],
  ] as const) {
    for (const method of ["GET", "HEAD"]) {
      const res = await page(path, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.headers["content-type"], "text/html; charset=utf-8", path);
      assert.equal(res.body, method === "GET" ? `<!doctype html><title>${file}</title>` : "");
    }
  }
});

test("a trailing slash and the old /technical address redirect to the page", async () => {
  for (const [path, location] of [
    ["/about/", "/about"],
    ["/sv/", "/sv"],
    ["/sv/om/?q=1", "/sv/om?q=1"],
    ["/sv/sa-fungerar-det/lamnas-kvar/", "/sv/sa-fungerar-det/lamnas-kvar"],
    ["/technical", "/how"],
    ["/technical/", "/how"],
  ] as const) {
    const res = await page(path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.location, location, path);
  }
  assert.equal((await page("/nope/")).status, 404);
});

test("never redirects off the site", async () => {
  for (const path of ["//about/", "//evil.example/", "/%2f%2fevil.example/", "/sv//om/"]) {
    const res = await rawGet(path);
    assert.notEqual(res.status, 301, path);
    assert.equal(res.headers.location, undefined, path);
  }
});

test("caches hashed assets for a year and revalidates everything else", async () => {
  const hashed = await rawGet("/assets/x-abc.js");
  assert.equal(hashed.status, 200);
  assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable");
  for (const [path, status] of [
    ["/", 200],
    ["/r/abc", 200],
    ["/favicon.svg", 200],
    ["/assets/..%2findex.html", 404],
    ["/assets/nope", 404],
  ] as const) {
    const res = await rawGet(path);
    assert.equal(res.status, status, path);
    assert.equal(res.headers["cache-control"], "no-cache", path);
  }
  const missing = await rawGet("/assets/missing.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["cache-control"], undefined);
});

test("never serves the build's own HTML files directly", async () => {
  for (const path of [
    "/index.html",
    "/index.HTML",
    "/index.receive.en.html",
    "/pages/about/index.html",
    "/pages/404.html",
    "/pages/404.HTML",
  ]) {
    const res = await rawGet(path);
    assert.equal(res.status, 404, path);
    assert.match(res.body, /<title>404<\/title>/, path);
  }
});

test("a receive link gets the receive copy even when its last segment has a dot", async () => {
  const res = await rawGet("/r/a.b");
  assert.equal(res.status, 200);
  assert.match(res.body, /receive\.en/);
  assert.equal(res.headers["x-robots-tag"], "noindex");
});

test("a target starting with // is a path, not a host", async () => {
  const res = await rawGet("//x/about");
  assert.equal(res.status, 404);
  assert.match(res.body, /<title>404<\/title>/);
  assert.equal(res.headers.location, undefined);
});

test("serves an absolute-form target by its path and refuses one that is not http(s)", async () => {
  const about = await rawGet("http://example.com/about");
  assert.equal(about.status, 200);
  const slashes = await rawGet("http://example.com//x/about");
  assert.equal(slashes.status, 404);
  assert.equal(slashes.headers.location, undefined);
  for (const target of ["ws://x/about", "file:///about", "*"]) {
    const res = await rawGet(target);
    assert.equal(res.status, 400, target);
    assert.ok(res.headers["content-security-policy"], target);
  }
});

test("refuses paths outside the web root", async () => {
  for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
    const res = await rawGet(path);
    assert.equal(res.status, 404, path);
    assert.notEqual(res.body, "outside the web root", path);
  }
});

test("rejects malformed paths and other methods", async () => {
  assert.equal((await rawGet("/%E0%A4%A")).status, 400);
  const status = await new Promise<number>((done, fail) => {
    request(`${base}/`, { method: "POST" }, (res) => done(res.statusCode ?? 0))
      .on("error", fail)
      .end();
  });
  assert.equal(status, 405);
});

test("serves over https with a generated certificate", async () => {
  const certDir = join(dir, "certs");
  const { server } = await startServer({
    port: 0,
    root,
    certDir,
    hosts: ["localhost", "127.0.0.1"],
  });
  try {
    const { port } = server.address() as AddressInfo;
    const ca = ensureCert(certDir, []).cert;
    const status = await new Promise<number>((done, fail) => {
      httpsGet({ host: "localhost", port, path: "/", ca }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).on("error", fail);
    });
    assert.equal(status, 200);
    const cert = new X509Certificate(ca);
    assert.match(cert.subjectAltName ?? "", /DNS:localhost/);
    assert.match(cert.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  } finally {
    server.close();
  }
});

/**
 * Opens a /signal socket on a TLS server and returns its raw text frames after the hello.
 * Adds the socket to `opened` before connecting, so a caller's `finally` can close it even
 * when this throws.
 */
async function rawSocket(
  port: number,
  ca: Buffer,
  opened: WsClient[],
  origin?: string,
): Promise<{ socket: WsClient; next(): Promise<string> }> {
  // Trusts only the server's own certificate, so TLS checks stay on.
  const socket = new WsClient(`wss://localhost:${port}/signal`, { ca, origin });
  opened.push(socket);
  const frames: string[] = [];
  const waiting: ((frame: string) => void)[] = [];
  socket.on("message", (data) => {
    const frame = String(data);
    const waiter = waiting.shift();
    if (waiter) {
      waiter(frame);
    } else {
      frames.push(frame);
    }
  });
  await new Promise((done, fail) => socket.once("open", done).once("error", fail));
  const next = (): Promise<string> => {
    const frame = frames.shift();
    return frame ? Promise.resolve(frame) : new Promise((done) => waiting.push(done));
  };
  assert.deepEqual(parseServerMessage(await next()), { t: "hello", mail: false });
  return { socket, next };
}

const iceCases = [
  { turn: false, allow: true, name: "no" },
  { turn: true, allow: true, name: "fresh TURN" },
  { turn: true, allow: false, name: "only STUN" },
];
for (const { turn, allow, name } of iceCases) {
  test(`hands ${name} ICE servers to both ends in joined`, async () => {
    const secret = "test-secret-do-not-leak";
    const urls = [
      "turn:127.0.0.1:3478?transport=udp",
      "turns:127.0.0.1:5349",
      "stun:127.0.0.1:3478",
    ];
    const logs: string[] = [];
    const certDir = join(dir, "certs");
    const { server } = await startServer({
      port: 0,
      root,
      certDir,
      hosts: ["localhost"],
      ice: turn ? { urls, secret } : undefined,
      log: (event, fields) => logs.push(JSON.stringify({ event, fields })),
    });
    const opened: WsClient[] = [];
    try {
      const { port } = server.address() as AddressInfo;
      const ca = ensureCert(certDir, []).cert;
      const host = await rawSocket(port, ca, opened);
      const guest = await rawSocket(port, ca, opened);
      const link = "AAAAAAAAAAAAAAAAAAAAAA";
      const attempt = "ZZZZZZZZZZZZZZZZZZZZZZ";
      host.socket.send(JSON.stringify({ t: "host", links: [link], turn: allow }));
      // A round trip on the host's socket proves the link is registered.
      host.socket.send(JSON.stringify({ t: "relay", link: attempt, data: "x" }));
      await host.next();
      guest.socket.send(JSON.stringify({ t: "join", link, attempt }));
      for (const frame of [await guest.next(), await host.next()]) {
        assert.ok(!frame.includes(secret));
        const message = parseServerMessage(frame);
        assert.ok(message?.t === "joined", frame);
        assert.equal(message.link, link);
        assert.equal(message.attempt, attempt);
        assert.equal(message.turn, allow);
        if (!turn) {
          assert.deepEqual(message.iceServers, []);
          continue;
        }
        if (!allow) {
          assert.deepEqual(message.iceServers, [{ urls: ["stun:127.0.0.1:3478"] }]);
          continue;
        }
        assert.equal(message.iceServers.length, 1);
        const [ice] = message.iceServers;
        assert.ok(ice && "username" in ice, frame);
        assert.deepEqual(ice.urls, urls);
        const expiry = Number(ice.username) - Date.now() / 1000;
        assert.ok(expiry > 5 * 60 - 60 && expiry <= 5 * 60, String(expiry));
        assert.match(ice.credential, /^[A-Za-z0-9+/]{27}=$/);
        for (const line of logs) {
          assert.ok(!line.includes(secret) && !line.includes(ice.credential), line);
        }
      }
    } finally {
      for (const socket of opened) {
        socket.terminate();
      }
      server.close();
    }
  });
}

const relayKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const relayMaster = "cd".repeat(32);
const relayAt = (id: string): Relay => ({
  id,
  urls: [`stun:${id}.test:3478`, `turn:${id}.test:3478?transport=udp`],
  publicKey: relayKey.publicKey.export({ type: "spki", format: "pem" }).toString(),
  host: `${id}.test`,
  port: 3478,
});
const relays = startRelays([relayAt("bad"), relayAt("loc")], relayMaster, {
  check: async ({ id }) => id === "loc",
});
const relaySecrets = [
  relayMaster,
  relaySecret(relayMaster, "bad"),
  relaySecret(relayMaster, "loc"),
];
const withRelays = createServer(serveRelays(relays, serveStatic(root)));
let relayPort = 0;
before(async () => {
  await new Promise<void>((done) => withRelays.listen(0, done));
  relayPort = (withRelays.address() as AddressInfo).port;
});
after(() => {
  withRelays.close();
  relays.stop();
});

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function call(
  port: number,
  path: string,
  { method = "GET", ca }: { method?: string; ca?: Buffer } = {},
): Promise<Reply> {
  return new Promise((done, fail) => {
    const options = { host: "localhost", port, path, method, ca };
    const onResponse = (res: IncomingMessage) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    };
    const req = ca ? httpsRequest(options, onResponse) : request(options, onResponse);
    req.on("error", fail).end();
  });
}

function assertRelayHeaders(res: Reply, path: string): void {
  assert.equal(res.headers["cache-control"], "no-store", path);
  assert.equal(res.headers["x-content-type-options"], "nosniff", path);
  assert.equal(res.headers["referrer-policy"], "no-referrer", path);
  assert.match(String(res.headers["content-security-policy"]), /default-src 'self'/, path);
}

test("hands out a relay's sealed secret and a newline at /relay-secret/<id>", async () => {
  const sealed = relays.handOut("loc");
  for (const path of ["/relay-secret/loc", "/relay-secret/loc?id=bad"]) {
    const res = await call(relayPort, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["content-type"], "text/plain; charset=utf-8", path);
    assertRelayHeaders(res, path);
    assert.equal(res.body, `${sealed}\n`, path);
  }
  const opened = privateDecrypt(
    { key: relayKey.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(sealed ?? "", "base64"),
  );
  assert.equal(opened.toString(), relaySecret(relayMaster, "loc"));
  const head = await call(relayPort, "/relay-secret/loc", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "text/plain; charset=utf-8");
  assertRelayHeaders(head, "HEAD");
  assert.equal(head.body, "");
});

test("reports each relay's state at /relay-status in list order", async () => {
  for (const path of ["/relay-status", "/relay-status?id=loc"]) {
    const res = await call(relayPort, path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["content-type"], "application/json", path);
    assertRelayHeaders(res, path);
    assert.equal(res.body, '[{"id":"bad","up":false},{"id":"loc","up":true}]', path);
  }
  const head = await call(relayPort, "/relay-status", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-type"], "application/json");
  assert.equal(head.body, "");
});

test("answers 404 to any other path under /relay-secret/ or /relay-status/", async () => {
  for (const path of [
    "/relay-secret",
    "/relay-secret/",
    "/relay-secret/sto",
    "/relay-secret/loc/",
    "/relay-secret/loc/x",
    "/relay-secret/LOC",
    "/relay-secret/%6Coc",
    "/relay-secret/loc%2F",
    "/relay-secret/constructor",
    "/relay-secret/__proto__",
    "/relay-status/",
    "/relay-status/loc",
  ]) {
    const res = await call(relayPort, path);
    assert.equal(res.status, 404, path);
    assertRelayHeaders(res, path);
    assert.equal(res.body, "", path);
  }
});

test("answers 405 to the relay routes for methods other than GET and HEAD", async () => {
  for (const [method, path] of [
    ["POST", "/relay-secret/loc"],
    ["PUT", "/relay-status"],
    ["DELETE", "/relay-secret/sto"],
    ["OPTIONS", "/relay-status/"],
  ] as const) {
    const res = await call(relayPort, path, { method });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.allow, "GET, HEAD", `${method} ${path}`);
    assertRelayHeaders(res, `${method} ${path}`);
    assert.equal(res.body, "", `${method} ${path}`);
  }
});

test("paths that only start like a relay route go to the static files", async () => {
  for (const path of ["/relay-statuses", "/relay-secrets/loc"]) {
    const res = await call(relayPort, path);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, "<!doctype html><title>404</title>", path);
  }
});

test("no relay status, 404 or 405 holds the master or a derived secret", async () => {
  const replies = [
    await call(relayPort, "/relay-status"),
    await call(relayPort, "/relay-secret/sto"),
    await call(relayPort, "/relay-secret/loc", { method: "POST" }),
    await call(relayPort, "/relay-secret/loc"),
  ];
  const text = JSON.stringify(replies);
  assert.equal(
    relaySecrets.some((secret) => text.includes(secret)),
    false,
  );
});

test("without a relay list, /relay-status is empty and no secret is handed out", async () => {
  const { server } = await startServer({
    port: 0,
    root,
    certDir: join(dir, "certs"),
    hosts: ["localhost"],
  });
  try {
    const { port } = server.address() as AddressInfo;
    const ca = ensureCert(join(dir, "certs"), []).cert;
    const status = await call(port, "/relay-status", { ca });
    assert.equal(status.status, 200);
    assert.equal(status.headers["content-type"], "application/json");
    assert.equal(status.body, "[]");
    assert.equal((await call(port, "/relay-secret/loc", { ca })).status, 404);
  } finally {
    server.close();
  }
});

test("hands the first relay up's ICE servers, with its own credentials, in joined", async () => {
  const logs: string[] = [];
  const { server } = await startServer({
    port: 0,
    root,
    certDir: join(dir, "certs"),
    hosts: ["localhost"],
    relays,
    log: (event, fields) => logs.push(JSON.stringify({ event, fields })),
  });
  const opened: WsClient[] = [];
  try {
    const { port } = server.address() as AddressInfo;
    const ca = ensureCert(join(dir, "certs"), []).cert;
    const host = await rawSocket(port, ca, opened);
    const guest = await rawSocket(port, ca, opened);
    const link = "AAAAAAAAAAAAAAAAAAAAAA";
    const attempt = "ZZZZZZZZZZZZZZZZZZZZZZ";
    host.socket.send(JSON.stringify({ t: "host", links: [link], turn: true }));
    host.socket.send(JSON.stringify({ t: "relay", link: attempt, data: "x" }));
    await host.next();
    guest.socket.send(JSON.stringify({ t: "join", link, attempt }));
    for (const frame of [await guest.next(), await host.next()]) {
      const message = parseServerMessage(frame);
      assert.ok(message?.t === "joined", frame);
      const [ice, ...rest] = message.iceServers;
      assert.deepEqual(rest, []);
      assert.ok(ice && "username" in ice, frame);
      assert.deepEqual(ice.urls, relayAt("loc").urls);
      const secret = relaySecret(relayMaster, "loc");
      assert.equal(
        ice.credential,
        createHmac("sha1", secret).update(ice.username).digest("base64"),
      );
      assert.equal(
        relaySecrets.some((secret) => frame.includes(secret) || logs.join().includes(secret)),
        false,
      );
    }
  } finally {
    for (const socket of opened) {
      socket.terminate();
    }
    server.close();
  }
});

test("without a web root, serves the relay routes and 404 for every other path", async (t) => {
  const { server: bare } = await startServer({
    port: 0,
    root: undefined,
    certDir: join(dir, "bare-certs"),
    hosts: ["localhost"],
  });
  t.after(() => bare.close());
  const { port } = bare.address() as AddressInfo;
  const ca = ensureCert(join(dir, "bare-certs"), []).cert;
  const ask = (method: string, path: string) => call(port, path, { method, ca });
  const status = await ask("GET", "/relay-status");
  assert.equal(status.status, 200);
  assert.equal(status.body, "[]");
  const home = await ask("GET", "/");
  assert.equal(home.status, 404);
  assert.equal(home.body, "");
  assert.ok(home.headers["content-security-policy"]);
  for (const [method, path] of [
    ["GET", "/index.html"],
    ["GET", "/assets/app.js"],
    ["GET", "/r/anything"],
    ["HEAD", "/"],
    ["POST", "/"],
  ] as const) {
    assert.equal((await ask(method, path)).status, 404, `${method} ${path}`);
  }
  assert.equal((await ask("POST", "/relay-status")).status, 405);
  const opened: WsClient[] = [];
  t.after(() => {
    for (const socket of opened) {
      socket.terminate();
    }
  });
  await rawSocket(port, ca, opened);
});

test("startServer keeps Node's idle timeouts unless keepAliveMs is set", async (t) => {
  for (const [keepAliveMs, keepAlive, headers] of [
    [undefined, 5000, 60_000],
    [125_000, 125_000, 126_000],
  ] as const) {
    const { server } = await startServer({
      port: 0,
      root: undefined,
      certDir: join(dir, "certs"),
      hosts: ["localhost"],
      keepAliveMs,
    });
    t.after(() => server.close());
    assert.equal(server.keepAliveTimeout, keepAlive);
    assert.equal(server.headersTimeout, headers);
  }
});

test("startServer hands siteOrigin to signaling", async (t) => {
  const { server: site } = await startServer({
    port: 0,
    root: undefined,
    certDir: join(dir, "origin-certs"),
    hosts: ["localhost"],
    siteOrigin: "https://fidant.se",
  });
  t.after(() => site.close());
  const { port } = site.address() as AddressInfo;
  const ca = ensureCert(join(dir, "origin-certs"), []).cert;
  const opened: WsClient[] = [];
  t.after(() => {
    for (const socket of opened) {
      socket.terminate();
    }
  });
  await rawSocket(port, ca, opened, "https://fidant.se");
  await assert.rejects(
    rawSocket(port, ca, opened, "https://other.example"),
    /Unexpected server response: 403/,
  );
});
