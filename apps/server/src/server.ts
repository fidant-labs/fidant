import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { type BlockList, isIP } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { isLinkId } from "@sigill/protocol";
import type { Mailer } from "./mail.ts";
import type { Relays } from "./relays.ts";
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
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const receivePath = /^\/r\/([^/]+)\/?$/;

/** The build's copy of index.html whose link preview fits the path and the fetcher's language. */
function pageFor(pathname: string, acceptLanguage = ""): string {
  const kind = isLinkId(receivePath.exec(pathname)?.[1]) ? "receive" : "home";
  const lang = /^sv\b/i.test(acceptLanguage) ? "sv" : "en";
  return `index.${kind}.${lang}.html`;
}

export function serveStatic(root: string) {
  const base = resolve(root);
  const assets = join(base, "assets") + sep;
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
    const page = !extname(file);
    if (page) {
      file = join(base, pageFor(pathname, req.headers["accept-language"]));
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
        "cache-control": file.startsWith(assets)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        ...(page && { vary: "accept-language" }),
        ...securityHeaders,
      });
      res.end(body);
    } catch {
      res.writeHead(404, securityHeaders).end();
    }
  };
}

const notFound: RequestListener = (_req, res) => {
  res.writeHead(404, securityHeaders).end();
};

const relayRoute = /^\/relay-(status|secret)(\/.*)?$/;
const relayId = /^\/([a-z][a-z0-9]{1,15})$/;

/** Answers /relay-status, /relay-secret/<id> and 404 below either, and passes the rest to `next`. */
export function serveRelays(relays: Relays | undefined, next: RequestListener): RequestListener {
  return (req, res) => {
    const pathname = URL.parse(req.url ?? "/", "https://localhost")?.pathname ?? "";
    const [, route, rest] = relayRoute.exec(pathname) ?? [];
    if (route === undefined) {
      next(req, res);
      return;
    }
    const headers = { "cache-control": "no-store", ...securityHeaders };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", ...headers }).end();
      return;
    }
    if (route === "status" && rest === undefined) {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(relays?.status() ?? []));
      return;
    }
    const id = route === "secret" ? relayId.exec(rest ?? "")?.[1] : undefined;
    const sealed = id === undefined ? undefined : relays?.handOut(id);
    if (sealed === undefined) {
      res.writeHead(404, headers).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(`${sealed}\n`);
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
  root?: string | undefined;
  certDir: string;
  hosts: string[];
  ice?: IceConfig | undefined;
  relays?: Relays | undefined;
  log?: Logger;
  mail?: { send: Mailer; origin: string } | undefined;
  siteOrigin?: string | undefined;
  proxies?: BlockList | undefined;
  startingMs?: number | undefined;
}): Promise<{ server: Server; signaling: { close(): void } }> {
  const server = createServer(
    ensureCert(options.certDir, options.hosts),
    serveRelays(options.relays, options.root === undefined ? notFound : serveStatic(options.root)),
  );
  const signaling = attachSignaling(server, {
    log: options.log ?? (() => {}),
    iceServers: (turn) =>
      options.relays ? options.relays.ice(turn) : iceServersFor(options.ice, Date.now(), turn),
    mail: options.mail,
    siteOrigin: options.siteOrigin,
    proxies: options.proxies,
    startingMs: options.startingMs,
  });
  server.on("close", () => signaling.close());
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(options.port, () => done({ server, signaling }));
  });
}
