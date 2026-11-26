import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { runInNewContext } from "node:vm";

type Fields = Record<string, { value: string }>;
type Generated = { statusCode: number; headers: Fields };
type Forwarded = { uri: string; headers: Fields };

const code = readFileSync(new URL("../../infra/edge/site.js", import.meta.url), "utf8");
// CloudFront runs functions in strict mode.
const site = runInNewContext(`"use strict";\n${code}\n;({ handler, PAGES })`, Object.create(null));
const handler = site.handler as (event: unknown) => Generated | Forwarded;

export const edgePages: readonly string[] = [...(site.PAGES as string[])];

// Must match the cache rule the release's upload sets.
export function uploadCacheControl(key: string): string {
  return key.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

export interface EdgeAnswer {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

// AWS doesn't say which request the response event carries, so `responseSees` picks one.
export async function edgeAnswer(
  root: string,
  request: { method: string; host: string; target: string; headers?: Record<string, string> },
  responseSees: "rewritten" | "viewer" = "rewritten",
): Promise<EdgeAnswer> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { status: 403, headers: {}, body: Buffer.alloc(0) };
  }
  const viewer = () => {
    const cut = request.target.indexOf("?");
    const raw = cut < 0 ? undefined : request.target.slice(cut + 1);
    const headers: Fields = { host: { value: request.host } };
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      headers[name.toLowerCase()] = { value };
    }
    return {
      method: request.method,
      uri: cut < 0 ? request.target : request.target.slice(0, cut),
      querystring: {},
      headers,
      cookies: {},
      rawQueryString: () => raw,
    };
  };
  const event = (eventType: string, extra: object) => ({
    version: "1.0",
    context: { eventType },
    viewer: { ip: "192.0.2.1" },
    ...extra,
  });
  const forwarded = handler(event("viewer-request", { request: viewer() }));
  if ("statusCode" in forwarded) {
    return {
      status: forwarded.statusCode,
      headers: flat(forwarded.headers),
      body: Buffer.alloc(0),
    };
  }
  if (!forwarded.uri.startsWith("/") || forwarded.uri.endsWith("/")) {
    throw new Error(`the function sent ${forwarded.uri} to the bucket, which would list it`);
  }
  const key = decodeURIComponent(forwarded.uri.slice(1));
  const file = resolve(root, key);
  const found =
    file.startsWith(resolve(root) + sep) && (await stat(file).catch(() => null))?.isFile();
  if (!found) {
    // S3's own 404, on which CloudFront runs no response function.
    return { status: 404, headers: {}, body: Buffer.alloc(0) };
  }
  const response = {
    statusCode: 200,
    statusDescription: "OK",
    headers: { "cache-control": { value: uploadCacheControl(key) } } as Fields,
  };
  const answered = handler(
    event("viewer-response", {
      request: responseSees === "rewritten" ? forwarded : viewer(),
      response,
    }),
  ) as Generated;
  const body = request.method === "HEAD" ? Buffer.alloc(0) : await readFile(file);
  return { status: answered.statusCode, headers: flat(answered.headers), body };
}

function flat(headers: Fields): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, field]) => [name, field.value]));
}
