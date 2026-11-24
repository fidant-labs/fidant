import { FRAME_OVERHEAD_BYTES } from "./send-file.ts";

export const TEXT_TYPE = "application/x-fidant-text";
export const TEXT_NAME = "secret.txt";
export const MAX_TEXT_LENGTH = 10_000;
export const MAX_TEXT_BYTES = 32 * 1024;

export function textFile(text: string): File | undefined {
  if (text.length === 0 || text.length > MAX_TEXT_LENGTH) {
    return undefined;
  }
  return new File([text], TEXT_NAME, { type: TEXT_TYPE });
}

/** Whether every text goes as exactly one CHUNK on a connection with this max message size; judged by MAX_TEXT_BYTES, never one text's size, so a refusal says nothing about a text. */
export function textFitsOneChunk(maxMessageSize: number): boolean {
  return maxMessageSize - FRAME_OVERHEAD_BYTES >= MAX_TEXT_BYTES;
}

/** Decodes a received text as UTF-8, keeping a leading U+FEFF (Blob.text() drops it); invalid bytes become U+FFFD. */
export async function decodeText(blob: Blob): Promise<string> {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await blob.arrayBuffer());
}

export function isTextOffer(offer: { type: string; size: number }): boolean {
  return offer.type === TEXT_TYPE && offer.size <= MAX_TEXT_BYTES;
}
