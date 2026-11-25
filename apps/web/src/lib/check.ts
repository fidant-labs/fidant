// The check number: six digits both people compare before anything about the
// file goes, derived only from the connection's two DTLS fingerprints. The
// recipient first commits to its fingerprint (commitFingerprint), so someone in
// the middle has to fix both certificates before it learns the number.

import { encodeBase64url } from "./base64url.ts";

/** Checked attempts per link that may end without both sides confirming. */
export const CHECK_ATTEMPTS = 5;

const FINGERPRINT = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/;
const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/**
 * The SDP's DTLS fingerprint, upper-case colon hex. Undefined unless every
 * fingerprint line is sha-256 and they all agree, so no second line of another
 * algorithm can name a different certificate.
 */
export function sdpFingerprint(sdp: string): string | undefined {
  const values = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=fingerprint:")) {
      continue;
    }
    const [algorithm, value, ...rest] = line.slice("a=fingerprint:".length).trim().split(/\s+/);
    if (algorithm?.toLowerCase() !== "sha-256" || value === undefined || rest.length > 0) {
      return undefined;
    }
    values.add(value.toUpperCase());
  }
  const [only] = values;
  return values.size === 1 && only !== undefined && FINGERPRINT.test(only) ? only : undefined;
}

/** The recipient's commitment to its fingerprint: base64url SHA-256, 43 characters. */
export async function commitFingerprint(fingerprint: string): Promise<string> {
  return encodeBase64url(await sha256(`fidant-commit-v1\n${fingerprint}`));
}

/** Six digits from the offer's and the answer's fingerprints, shown as "ddd ddd". */
export async function checkNumber(
  offerFingerprint: string,
  answerFingerprint: string,
): Promise<string> {
  const hash = await sha256(`fidant-check-v1\n${offerFingerprint}\n${answerFingerprint}`);
  const value = new DataView(hash.buffer, hash.byteOffset, 8).getBigUint64(0) % 1_000_000n;
  const digits = value.toString().padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** A certificate's sha-256 fingerprint, upper-case, as its SDP will show it. */
export async function certificateFingerprint(cert: RTCCertificate): Promise<string> {
  const value = cert
    .getFingerprints()
    .find((f) => f.algorithm?.toLowerCase() === "sha-256")
    ?.value?.toUpperCase();
  if (value === undefined || !FINGERPRINT.test(value)) {
    throw new Error("certificate has no sha-256 fingerprint");
  }
  return value;
}
