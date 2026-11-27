// Split-key derivation for the FID-7 spike.
//
// F = fragment half, 32 random bytes carried in the link fragment.
// S = server half, 32 random bytes generated in the sender's browser and held
//     by the server until the receipt is signed.
//
// Meta key    = HKDF-SHA256(F,     salt = transferId, info "fidant/v2/meta")
// Content key = HKDF-SHA256(F ‖ S, salt = transferId, info "fidant/v2/content")
//
// The meta key opens only the META frame, so the recipient can see what is
// offered before signing. Everything else needs the content key, and so both
// halves. HKDF rather than F ‖ S as the key keeps the halves independent
// inputs and gives each key its own label. Keys are AES-GCM-256 CryptoKeys,
// non-extractable, used only for encrypt and decrypt.

import { decodeBase64url, encodeBase64url } from "../../../apps/web/src/lib/base64url.ts";

export const HALF_BYTES = 32;
export const TRANSFER_ID_BYTES = 16;
export const META_INFO = "fidant/v2/meta";
export const CONTENT_INFO = "fidant/v2/content";

/** Length of F as base64url without padding. */
export const FRAGMENT_HALF_CHARS = 43;

const encoder = new TextEncoder();

export type Halves = {
  fragmentHalf: Uint8Array<ArrayBuffer>;
  serverHalf: Uint8Array<ArrayBuffer>;
};

/** Makes fresh random halves for one transfer. */
export function generateHalves(): Halves {
  return {
    fragmentHalf: crypto.getRandomValues(new Uint8Array(HALF_BYTES)),
    serverHalf: crypto.getRandomValues(new Uint8Array(HALF_BYTES)),
  };
}

/** Makes a fresh random transferId, the HKDF salt. */
export function createTransferId(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(TRANSFER_ID_BYTES));
}

/** Encodes F for the link fragment. */
export function encodeFragmentHalf(fragmentHalf: Uint8Array): string {
  checkLength(fragmentHalf, HALF_BYTES, "fragment half");
  return encodeBase64url(fragmentHalf);
}

/** Decodes F from the link fragment. Returns undefined for anything malformed. */
export function decodeFragmentHalf(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length !== FRAGMENT_HALF_CHARS) {
    return undefined;
  }
  return decodeBase64url(text);
}

function checkLength(bytes: Uint8Array, length: number, name: string): void {
  if (bytes.length !== length) {
    throw new Error(`${name} must be ${length} bytes`);
  }
}

function metaInput(fragmentHalf: Uint8Array, transferId: Uint8Array) {
  checkLength(fragmentHalf, HALF_BYTES, "fragment half");
  checkLength(transferId, TRANSFER_ID_BYTES, "transferId");
  return { ikm: new Uint8Array(fragmentHalf), salt: new Uint8Array(transferId), info: META_INFO };
}

function contentInput(fragmentHalf: Uint8Array, serverHalf: Uint8Array, transferId: Uint8Array) {
  checkLength(fragmentHalf, HALF_BYTES, "fragment half");
  checkLength(serverHalf, HALF_BYTES, "server half");
  checkLength(transferId, TRANSFER_ID_BYTES, "transferId");
  const ikm = new Uint8Array(HALF_BYTES * 2);
  ikm.set(fragmentHalf);
  ikm.set(serverHalf, HALF_BYTES);
  return { ikm, salt: new Uint8Array(transferId), info: CONTENT_INFO };
}

type HkdfInput = {
  ikm: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  info: string;
};

async function hkdfBase(input: HkdfInput) {
  const base = await crypto.subtle.importKey("raw", input.ikm, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  // The concatenated F ‖ S buffer is ours, so clear it once imported.
  input.ikm.fill(0);
  return {
    base,
    params: { name: "HKDF", hash: "SHA-256", salt: input.salt, info: encoder.encode(input.info) },
  };
}

async function deriveAesKey(input: HkdfInput): Promise<CryptoKey> {
  const { base, params } = await hkdfBase(input);
  return crypto.subtle.deriveKey(params, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function deriveRaw(input: HkdfInput): Promise<Uint8Array<ArrayBuffer>> {
  const { base, params } = await hkdfBase(input);
  return new Uint8Array(await crypto.subtle.deriveBits(params, base, 256));
}

/** Key for the META frame. Needs only F, so it opens before the receipt is signed. */
export async function deriveMetaKey(
  fragmentHalf: Uint8Array,
  transferId: Uint8Array,
): Promise<CryptoKey> {
  return deriveAesKey(metaInput(fragmentHalf, transferId));
}

/** Key for the SEALED frame and the chunks. Needs both halves. */
export async function deriveContentKey(
  fragmentHalf: Uint8Array,
  serverHalf: Uint8Array,
  transferId: Uint8Array,
): Promise<CryptoKey> {
  return deriveAesKey(contentInput(fragmentHalf, serverHalf, transferId));
}

/** Raw bytes of the meta key, for test vectors only. */
export async function deriveMetaBits(
  fragmentHalf: Uint8Array,
  transferId: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return deriveRaw(metaInput(fragmentHalf, transferId));
}

/** Raw bytes of the content key, for test vectors only. */
export async function deriveContentBits(
  fragmentHalf: Uint8Array,
  serverHalf: Uint8Array,
  transferId: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return deriveRaw(contentInput(fragmentHalf, serverHalf, transferId));
}
