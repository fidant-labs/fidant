import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, request } from "node:http";
import { get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ensureCert, serveApp, startServer } from "./server.ts";

const dir = mkdtempSync(join(tmpdir(), "sigill-server-"));
const root = join(dir, "dist");
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Sigill</title>");
writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
writeFileSync(join(dir, "secret.txt"), "outside the web root");

const plain = createServer(serveApp(root));
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

test("serves no ICE servers when TURN is not configured", async () => {
  const res = await fetch(`${base}/ice-servers`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { iceServers: [] });
});

test("serves fresh TURN credentials without the secret", async () => {
  const secret = "test-secret-do-not-leak";
  const urls = ["turn:127.0.0.1:3478?transport=udp", "turn:127.0.0.1:3478?transport=tcp"];
  const app = createServer(serveApp(root, { urls, secret }));
  await new Promise<void>((done) => app.listen(0, done));
  try {
    const url = `http://localhost:${(app.address() as AddressInfo).port}/ice-servers`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const text = await res.text();
    assert.ok(!text.includes(secret));
    const { iceServers } = JSON.parse(text);
    assert.equal(iceServers.length, 1);
    assert.deepEqual(iceServers[0].urls, urls);
    const expiry = Number(iceServers[0].username) - Date.now() / 1000;
    assert.ok(expiry > 12 * 3600 - 60 && expiry <= 12 * 3600, String(expiry));
    assert.match(iceServers[0].credential, /^[A-Za-z0-9+/]{27}=$/);

    const post = await fetch(url, { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    assert.ok(!(await post.text()).includes(secret));
  } finally {
    app.close();
  }
});
