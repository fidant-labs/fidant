import { constants, publicEncrypt } from "node:crypto";

/**
 * The body of a relay's secret hand-out: the secret sealed to the relay's RSA key with OAEP
 * (SHA-256 for OAEP and MGF1, empty label), in padded base64 without a newline.
 */
export function sealRelaySecret(publicKeyPem: string, secretHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(secretHex)) {
    throw new TypeError("A relay secret is 64 lowercase hex characters.");
  }
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(secretHex, "ascii"),
  ).toString("base64");
}
