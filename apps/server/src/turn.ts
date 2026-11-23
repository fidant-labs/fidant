import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IceServer } from "@sigill/protocol";

export type IceConfig = { urls: string[]; secret: string };

const ttlSeconds = 12 * 60 * 60;

// The TURN REST API scheme that coturn checks with --use-auth-secret: the
// username is the expiry time, the credential is HMAC-SHA1 of it under the
// shared secret. The secret itself never leaves this function.
export function turnCredentials(
  secret: string,
  nowMs: number,
): { username: string; credential: string } {
  const username = String(Math.floor(nowMs / 1000) + ttlSeconds);
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

/** The ICE servers for one pairing: none without TURN, else TURN with fresh credentials. */
export function iceServersFor(ice: IceConfig | undefined, nowMs: number): IceServer[] {
  return ice ? [{ urls: ice.urls, ...turnCredentials(ice.secret, nowMs) }] : [];
}

export function serveIceServers(ice: IceConfig | undefined, headers: Record<string, string>) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", ...headers }).end();
      return;
    }
    const iceServers = iceServersFor(ice, Date.now());
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    });
    res.end(JSON.stringify({ iceServers }));
  };
}
