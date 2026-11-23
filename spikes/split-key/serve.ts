// Serves the built bench from dist/.
//
// - http://127.0.0.1:BENCH_PORT (default 8450): a secure context in every
//   engine without a certificate, for this machine and the Playwright runner.
// - https://<LAN address>:BENCH_HTTPS_PORT (default 8451) on all interfaces:
//   for phones and other laptops. Uses the same self-signed certificate as
//   `pnpm start` (CERT_DIR or the repository's .certs/), created on first use.
//
// The page must be cross-origin isolated (COOP + COEP) so browsers expose
// precise timers and performance.measureUserAgentSpecificMemory(). Nothing is
// logged per request; the bench sends no data to the server anyway.

import { readFile, stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server } from "node:net";
import { networkInterfaces } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { ensureCert } from "../../apps/server/src/server.ts";

const root = resolve(import.meta.dirname, "dist");
const certDir = process.env.CERT_DIR ?? resolve(import.meta.dirname, "../../.certs");
const httpPort = Number(process.env.BENCH_PORT ?? 8450);
const httpsPort = Number(process.env.BENCH_HTTPS_PORT ?? 8451);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".map": "application/json",
};

const headers = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; " +
    "img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", ...headers }).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  } catch {
    res.writeHead(400, headers).end();
    return;
  }
  if (pathname.endsWith("/")) {
    pathname += "index.html";
  }
  // resolve() collapses any ../, so the prefix check catches traversal.
  const file = resolve(root, `.${pathname}`);
  if (pathname.includes("\0") || !file.startsWith(root + sep)) {
    res.writeHead(404, headers).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) {
      throw new Error("not a file");
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      ...headers,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, headers).end();
  }
}

function listener(req: IncomingMessage, res: ServerResponse): void {
  handle(req, res).catch(() => {
    if (!res.headersSent) {
      res.writeHead(500, headers);
    }
    res.end();
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => done());
  });
}

try {
  await stat(join(root, "index.html"));
} catch {
  console.error("The bench is not built. Run `pnpm --filter @sigill/spike-split-key bench`.");
  process.exit(1);
}

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .flatMap((address) => (address?.family === "IPv4" && !address.internal ? [address.address] : []));

await listen(createHttpServer(listener), httpPort, "127.0.0.1");
await listen(
  createHttpsServer(ensureCert(certDir, ["localhost", "127.0.0.1", ...lanAddresses]), listener),
  httpsPort,
  "0.0.0.0",
);

console.log("Split-key bench is running:");
console.log(`  http://127.0.0.1:${httpPort}/  (this machine)`);
for (const host of lanAddresses) {
  console.log(`  https://${host}:${httpsPort}/  (other devices; accept the certificate warning)`);
}
