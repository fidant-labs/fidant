import { createHmac } from "node:crypto";
import type { IceServer } from "@sigill/protocol";

export type IceConfig = { urls: string[]; secret: string };

// Credentials go only to paired sockets, minted per pairing. The expiry only
// limits starting a relay: coturn 4.19 kept a relayed connection alive, and
// accepted its refreshes, 11 minutes after the username had expired (tested
// with a 20 s credential). So a few minutes to allocate is enough, and a
// leaked credential is useless soon after.
const ttlSeconds = 5 * 60;

// The coturn --use-auth-secret scheme: the username is the expiry, the credential its HMAC-SHA1.
export function turnCredentials(
  secret: string,
  nowMs: number,
  label?: string,
): { username: string; credential: string } {
  const expiry = String(Math.floor(nowMs / 1000) + ttlSeconds);
  const username = label === undefined ? expiry : `${expiry}:${label}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential };
}

/**
 * The ICE servers for one pairing: none without TURN, TURN with fresh credentials if the sender
 * allows it, else only the STUN URLs, with no credential minted.
 */
export function iceServersFor(
  ice: IceConfig | undefined,
  nowMs: number,
  turn: boolean,
): IceServer[] {
  if (!ice) {
    return [];
  }
  if (turn) {
    return [{ urls: ice.urls, ...turnCredentials(ice.secret, nowMs) }];
  }
  const stun = ice.urls.filter((url) => url.startsWith("stun:"));
  return stun.length > 0 ? [{ urls: stun }] : [];
}
