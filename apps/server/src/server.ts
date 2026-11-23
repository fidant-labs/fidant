import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { isIP } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { attachSignaling, type Logger } from "./signaling.ts";
import { type IceConfig, iceServersFor } from "./turn.ts";

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function serveStatic(root: string) {
  const base = resolve(root);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", ...securityHeaders }).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "https://localhost").pathname);
    } catch {
      res.writeHead(400, securityHeaders).end();
      return;
    }
    let file = resolve(base, `.${pathname}`);
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(404, securityHeaders).end();
      return;
    }
    if (!extname(file)) {
      file = join(base, "index.html");
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
        ...securityHeaders,
      });
      res.end(body);
    } catch {
      res.writeHead(404, securityHeaders).end();
    }
  };
}

export function ensureCert(dir: string, hosts: string[]): { key: Buffer; cert: Buffer } {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true });
    const san = hosts.map((host) => (isIP(host) ? `IP:${host}` : `DNS:${host}`)).join(",");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "825",
        "-subj",
        "/CN=Sigill local",
        "-addext",
        `subjectAltName=${san}`,
        "-keyout",
        keyPath,
        "-out",
        certPath,
      ],
      { stdio: "ignore" },
    );
  }
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

export function startServer(options: {
  port: number;
  root: string;
  certDir: string;
  hosts: string[];
  ice?: IceConfig | undefined;
  log?: Logger;
}): Promise<Server> {
  const server = createServer(
    ensureCert(options.certDir, options.hosts),
    serveStatic(options.root),
  );
  const signaling = attachSignaling(server, {
    log: options.log ?? (() => {}),
    iceServers: () => iceServersFor(options.ice, Date.now()),
  });
  server.on("close", () => signaling.close());
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(options.port, () => done(server));
  });
}
