// Display helpers shared by the sender and recipient pages.

/** Lowercase hex, as `shasum -a 256` prints it. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const UNITS = ["KB", "MB", "GB", "TB"];

/** A human-readable size in decimal units, like Finder shows: "8.4 MB", "512 bytes". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return bytes === 1 ? "1 byte" : `${bytes} bytes`;
  let value = bytes;
  let unit = "bytes";
  for (const next of UNITS) {
    if (value < 999.5) break;
    value /= 1000;
    unit = next;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** "45% · 1.1 MB of 2.4 MB". An empty file counts as done. */
export function formatProgress(bytes: number, total: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : 100;
  return `${percent}% · ${formatBytes(bytes)} of ${formatBytes(total)}`;
}
