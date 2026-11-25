import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { createServer, type Server } from "node:https";
import { type BlockList, isIP } from "node:net";
import { extname, join, resolve, sep } from "node:path";
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

/** Lowercase segments only, so a redirect built from it can never name another host. */
const pagePath = /^(?:\/[a-z]+(?:-[a-z]+)*)*\/?$/;
const moved: Record<string, string> = { "/technical": "/how" };

/** Where the build puts a page: pages/index.html for /, pages/<path>/index.html for the rest. */
function pageFile(path: string): string {
  return path === "/" ? "pages/index.html" : `pages${path}/index.html`;
}

function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (s) => s.isFile(),
    () => false,
  );
}

export function serveStatic(root: string) {
  const base = resolve(root);
  const assets = join(base, "assets") + sep;
  const send = async (
    res: ServerResponse,
    status: number,
    file: string,
    headers: Record<string, string> = {},
  ): Promise<void> => {
    try {
      const body = await readFile(file);
      res.writeHead(status, {
        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
        "cache-control": file.startsWith(assets)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        ...headers,
        ...securityHeaders,
      });
      res.end(body);
    } catch {
      res.writeHead(404, securityHeaders).end();
    }
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD", ...securityHeaders }).end();
      return;
    }
    let url: URL;
    let pathname: string;
    try {
      const target = req.url ?? "/";
      const parsed = target.startsWith("/")
        ? new URL(`https://localhost${target}`)
        : new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("not an http target");
      }
      url = parsed;
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, securityHeaders).end();
      return;
    }
    const file = resolve(base, `.${pathname}`);
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(404, securityHeaders).end();
      return;
    }
    if (pathname.startsWith("/r/")) {
      // Malformed link IDs get the receive page too, which says the link is broken.
      const lang = /^sv\b/i.test(req.headers["accept-language"] ?? "") ? "sv" : "en";
      await send(res, 200, join(base, `index.receive.${lang}.html`), {
        vary: "accept-language",
        "x-robots-tag": "noindex",
      });
      return;
    }
    const ext = extname(file).toLowerCase();
    if (ext && ext !== ".html") {
      await send(res, 200, file);
      return;
    }
    if (pagePath.test(pathname)) {
      const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
      const target = moved[path] ?? path;
      if (await isFile(join(base, pageFile(target)))) {
        if (target === pathname) {
          await send(res, 200, join(base, pageFile(target)));
        } else {
          res.writeHead(301, { location: target + url.search, ...securityHeaders }).end();
        }
        return;
      }
    }
    const sv = /^\/sv(?:\/|$)/.test(pathname);
    await send(res, 404, join(base, sv ? "pages/sv/404.html" : "pages/404.html"));
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
  root: string | undefined;
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
