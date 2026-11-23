// Base64url without padding (RFC 4648 section 5), as used in link IDs, link
// secrets and relayed signaling blobs. Decoding is strict: it rejects padding,
// characters outside the alphabet, impossible lengths and non-zero trailing
// bits, so every byte string has exactly one accepted encoding.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) {
  LOOKUP[ALPHABET.charCodeAt(i)] = i;
}

export function encodeBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      ALPHABET.charAt(n >>> 18) +
      ALPHABET.charAt((n >>> 12) & 63) +
      ALPHABET.charAt((n >>> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET.charAt(n >>> 18) + ALPHABET.charAt((n >>> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out +=
      ALPHABET.charAt(n >>> 18) +
      ALPHABET.charAt((n >>> 12) & 63) +
      ALPHABET.charAt((n >>> 6) & 63);
  }
  return out;
}

/** Decodes unpadded base64url. Returns undefined for anything malformed. */
export function decodeBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (text.length % 4 === 1) {
    return undefined;
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const value = code < 128 ? (LOOKUP[code] as number) : -1;
    if (value < 0) {
      return undefined;
    }
    bits = ((bits << 6) | value) & 0xffffff;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[o++] = (bits >>> bitCount) & 0xff;
    }
  }
  // Leftover bits must be zero, or two strings would decode to the same bytes.
  if ((bits & ((1 << bitCount) - 1)) !== 0) {
    return undefined;
  }
  return out;
}
