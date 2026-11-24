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

export function isTextOffer(offer: { type: string; size: number }): boolean {
  return offer.type === TEXT_TYPE && offer.size <= MAX_TEXT_BYTES;
}
