import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, request } from "node:http";
import { get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseServerMessage } from "@sigill/protocol";
import { WebSocket as WsClient } from "ws";
import { ensureCert, serveStatic, startServer } from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "sigill-server-"));
const root = join(dir, "dist");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Sigill</title>");
writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
writeFileSync(join(root, "robots.txt"), "User-agent: *");
writeFileSync(join(dir, "secret.txt"), "outside the web root");

const plain = createServer(serveStatic(root));
let base = "";
before(async () => {
  await new Promise<void>((done) => plain.listen(0, done));
  base = `http://localhost:${(plain.address() as AddressInfo).port}`;
});
after(() => plain.close());

function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    httpGet({ host: "localhost", port: (plain.address() as AddressInfo).port, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => done({ status: res.statusCode ?? 0, body }));
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

test("falls back to index.html for app routes", async () => {
  const res = await fetch(`${base}/r/abc123`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Sigill<\/title>/);
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
  const server = await startServer({ port: 0, root, certDir, hosts: ["localhost", "127.0.0.1"] });
  try {
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((done, fail) => {
      httpsGet({ host: "localhost", port, path: "/", rejectUnauthorized: false }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      }).on("error", fail);
    });
    assert.equal(status, 200);
    const cert = new X509Certificate(ensureCert(certDir, []).cert);
    assert.match(cert.subjectAltName ?? "", /DNS:localhost/);
    assert.match(cert.subjectAltName ?? "", /IP Address:127\.0\.0\.1/);
  } finally {
    server.close();
  }
});

/** Opens a /signal socket on a TLS server and returns its raw text frames after the hello. */
async function rawSocket(port: number): Promise<{ socket: WsClient; next(): Promise<string> }> {
  const socket = new WsClient(`wss://localhost:${port}/signal`, { rejectUnauthorized: false });
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
    const server = await startServer({
      port: 0,
      root,
      certDir: join(dir, "certs"),
      hosts: ["localhost"],
      ice: turn ? { urls, secret } : undefined,
      log: (event, fields) => logs.push(JSON.stringify({ event, fields })),
    });
    const { port } = server.address() as AddressInfo;
    const host = await rawSocket(port);
    const guest = await rawSocket(port);
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
