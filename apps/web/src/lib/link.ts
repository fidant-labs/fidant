// Recipient links: `${origin}/r/${linkId}#${secret}`.
//
// The link ID (16 random bytes) is the only part the server ever sees. The
// secret (32 random bytes) sits in the URL fragment, which browsers never send
// to a server; both keys for the link are derived from it (see keys.ts).

import { isLinkId } from "@sigill/protocol";
import { decodeBase64url, encodeBase64url } from "./base64url.ts";

export const LINK_ID_BYTES = 16;
export const SECRET_BYTES = 32;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type Link = { linkId: string; secret: string; url: string };

/** Makes a fresh link ID and secret. `origin` is like `https://192.168.1.5:8443`. */
export function createLink(origin: string): Link {
  const linkId = encodeBase64url(crypto.getRandomValues(new Uint8Array(LINK_ID_BYTES)));
  const secret = encodeBase64url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
  return { linkId, secret, url: `${origin}/r/${linkId}#${secret}` };
}

/** True if `value` is a 43-character base64url string that decodes to 32 bytes. */
export function isSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SECRET_PATTERN.test(value) &&
    decodeBase64url(value)?.length === SECRET_BYTES
  );
}

/**
 * Reads the link ID and secret from a recipient page location
 * (`/r/<linkId>` plus `#<secret>`). Returns undefined if either is malformed.
 */
export function parseRecipientLocation(location: {
  pathname: string;
  hash: string;
}): { linkId: string; secret: string } | undefined {
  const match = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
  const linkId = match?.[1];
  if (!isLinkId(linkId)) {
    return undefined;
  }
  const secret = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!isSecret(secret)) {
    return undefined;
  }
  return { linkId, secret };
}
