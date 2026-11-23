import { createHmac } from "node:crypto";
import type { IceServer } from "@sigill/protocol";

export type IceConfig = { urls: string[]; secret: string };

// Credentials go only to paired sockets, minted per pairing. The expiry only
// limits starting a relay: coturn 4.19 kept a relayed connection alive, and
// accepted its refreshes, 11 minutes after the username had expired (tested
// with a 20 s credential). So a few minutes to allocate is enough, and a
// leaked credential is useless soon after.
const ttlSeconds = 5 * 60;

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
