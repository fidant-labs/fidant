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
for (const page of ["home.en", "home.sv", "receive.en", "receive.sv"]) {
  writeFileSync(join(root, `index.${page}.html`), `<!doctype html><title>${page}</title>`);
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

test("serves index.html with security headers", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
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

test("app routes get the page copy for their link preview and language", async () => {
  const linkId = "AAAAAAAAAAAAAAAAAAAAAA";
  for (const [path, language, page] of [
    ["/", undefined, "home.en"],
    ["/about", "sv-SE,sv;q=0.9,en;q=0.8", "home.sv"],
    ["/r/abc123", "sv", "home.sv"],
    [`/r/${linkId}`, "sv-SE,sv;q=0.9", "receive.sv"],
    [`/r/${linkId}/`, "en-US,sv;q=0.5", "receive.en"],
    [`/r/${linkId}`, "svx", "receive.en"],
    [`/r/${linkId}/more`, undefined, "home.en"],
  ] as const) {
    const res = language
      ? await fetch(`${base}${path}`, { headers: { "accept-language": language } }).then(
          async (r) => ({ status: r.status, body: await r.text(), vary: r.headers.get("vary") }),
        )
      : await rawGet(path).then((r) => ({ status: r.status, body: r.body, vary: r.headers.vary }));
    assert.equal(res.status, 200, path);
    assert.equal(res.body, `<!doctype html><title>${page}</title>`, `${path} ${language}`);
    assert.equal(res.vary, "accept-language", path);
  }
  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.headers.get("vary"), null);
});

test("caches hashed assets for a year and revalidates everything else", async () => {
  const hashed = await rawGet("/assets/x-abc.js");
  assert.equal(hashed.status, 200);
  assert.equal(hashed.headers["cache-control"], "public, max-age=31536000, immutable");
  for (const path of ["/", "/r/abc", "/assets/nope", "/favicon.svg", "/assets/..%2findex.html"]) {
    const res = await rawGet(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["cache-control"], "no-cache", path);
  }
  const missing = await rawGet("/assets/missing.js");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["cache-control"], undefined);
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

/** Opens a /signal socket on a TLS server and returns its raw text frames after the hello. */
async function rawSocket(
  port: number,
  ca: Buffer,
): Promise<{ socket: WsClient; next(): Promise<string> }> {
  // Trusts only the server's own certificate, so TLS checks stay on.
  const socket = new WsClient(`wss://localhost:${port}/signal`, { ca });
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
    const { port } = server.address() as AddressInfo;
    const ca = ensureCert(certDir, []).cert;
    const host = await rawSocket(port, ca);
    const guest = await rawSocket(port, ca);
    try {
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
      host.socket.terminate();
      guest.socket.terminate();
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
    assert.equal(res.status, 200, path);
    assert.equal(res.body, "<!doctype html><title>home.en</title>", path);
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
  const { port } = server.address() as AddressInfo;
  const ca = ensureCert(join(dir, "certs"), []).cert;
  const host = await rawSocket(port, ca);
  const guest = await rawSocket(port, ca);
  try {
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
    host.socket.terminate();
    guest.socket.terminate();
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
  const ask = (method: string, path: string) =>
    new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((done, fail) => {
      httpsRequest({ host: "localhost", port, path, method, rejectUnauthorized: false }, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
        .on("error", fail)
        .end();
    });
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
  const socket = new WsClient(`wss://localhost:${port}/signal`, { rejectUnauthorized: false });
  t.after(() => socket.terminate());
  const first = await new Promise<string>((done, fail) => {
    socket.once("message", (data) => done(String(data))).once("error", fail);
  });
  assert.equal(parseServerMessage(first)?.t, "hello");
});
