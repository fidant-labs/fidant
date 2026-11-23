// Keys derived from a link secret, and sealing of relayed signaling messages.
//
// Signal key = HKDF-SHA256(secret, salt = linkId bytes,  info "sigill/v1/signal")
// File key   = HKDF-SHA256(secret, salt = transferId,    info "sigill/v1/file")
// Both are AES-GCM-256 CryptoKeys, non-extractable, used only for encrypt and
// decrypt. A fresh 16-byte transferId per attempt means a restarted transfer
// never reuses a (file key, nonce) pair.
//
// Sealed signal = base64url(iv(12 random) || AES-GCM ciphertext with 16-byte tag)
// over the UTF-8 JSON payload, AAD "sigill/v1/signal|<linkId>|<dir>". The
// direction in the AAD stops the server from reflecting a message back to the
// side that sent it.

import { isLinkId, MAX_RELAY_DATA } from "@sigill/protocol";
import { decodeBase64url, encodeBase64url } from "./base64url.ts";
import { isSecret } from "./link.ts";

/** Who sent a message or frame: "s" the sender, "r" the recipient. */
export type Direction = "s" | "r";

export const TRANSFER_ID_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Largest JSON payload (in UTF-8 bytes) whose sealed form fits MAX_RELAY_DATA. */
export const MAX_SIGNAL_PAYLOAD = Math.floor((MAX_RELAY_DATA * 3) / 4) - IV_BYTES - TAG_BYTES;

async function deriveKey(secret: string, salt: Uint8Array<ArrayBuffer>, info: string) {
  const ikm = isSecret(secret) ? decodeBase64url(secret) : undefined;
  if (!ikm) throw new Error("invalid link secret");
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Key for sealing SDP and ICE messages on one link. */
export function deriveSignalKey(secret: string, linkId: string): Promise<CryptoKey> {
  const salt = isLinkId(linkId) ? decodeBase64url(linkId) : undefined;
  if (!salt) return Promise.reject(new Error("invalid link ID"));
  return deriveKey(secret, salt, "sigill/v1/signal");
}

/** Key for the data channel frames of one transfer attempt. */
export function deriveFileKey(secret: string, transferId: Uint8Array): Promise<CryptoKey> {
  if (transferId.length !== TRANSFER_ID_BYTES) {
    return Promise.reject(new Error("transferId must be 16 bytes"));
  }
  return deriveKey(secret, new Uint8Array(transferId), "sigill/v1/file");
}

/** Makes a fresh random transferId. */
export function createTransferId(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(TRANSFER_ID_BYTES));
}

function signalAad(linkId: string, dir: Direction): Uint8Array<ArrayBuffer> {
  return encoder.encode(`sigill/v1/signal|${linkId}|${dir}`);
}

/** Encrypts a JSON-serialisable payload into a relay `data` string. */
export async function sealSignal(
  key: CryptoKey,
  linkId: string,
  dir: Direction,
  payload: unknown,
): Promise<string> {
  const json = JSON.stringify(payload);
  if (json === undefined) throw new Error("signal payload is not JSON-serialisable");
  const plaintext = encoder.encode(json);
  if (plaintext.length > MAX_SIGNAL_PAYLOAD) {
    throw new Error(
      `signal payload too large: ${plaintext.length} bytes, max ${MAX_SIGNAL_PAYLOAD}`,
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: signalAad(linkId, dir), tagLength: TAG_BYTES * 8 },
    key,
    plaintext,
  );
  const sealed = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), IV_BYTES);
  return encodeBase64url(sealed);
}

/**
 * Decrypts a relay `data` string sealed by the other side. `dir` is the side
 * that sealed it. Throws if the data is malformed, tampered with, sealed for
 * another link or direction, or sealed with another key.
 */
export async function openSignal(
  key: CryptoKey,
  linkId: string,
  dir: Direction,
  data: string,
): Promise<unknown> {
  const sealed = data.length <= MAX_RELAY_DATA ? decodeBase64url(data) : undefined;
  if (!sealed || sealed.length < IV_BYTES + TAG_BYTES) throw new Error("malformed signal");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: sealed.subarray(0, IV_BYTES),
      additionalData: signalAad(linkId, dir),
      tagLength: TAG_BYTES * 8,
    },
    key,
    sealed.subarray(IV_BYTES),
  );
  return JSON.parse(decoder.decode(plaintext));
}
