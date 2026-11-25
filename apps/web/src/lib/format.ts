// Display helpers shared by the sender and recipient pages.

import { type Lang, MESSAGES } from "../i18n/language.ts";

/** Lowercase hex, as `shasum -a 256` prints it. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

const UNITS = ["KB", "MB", "GB", "TB"];

/** A human-readable size in decimal units, like Finder shows: "8.4 MB", "512 bytes" ("8,4 MB", "512 byte" in Swedish). */
export function formatBytes(bytes: number, lang: Lang): string {
  if (bytes < 1000) {
    return MESSAGES[lang].format.bytes(bytes);
  }
  let value = bytes;
  let unit = "";
  for (const next of UNITS) {
    if (value < 999.5) {
      break;
    }
    value /= 1000;
    unit = next;
  }
  const digits = value < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(lang, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${unit}`;
}

/** A name typed by someone else, trimmed, or "" if it has no letter or digit to show. */
export function displayName(typed: string): string {
  return /(?!\p{Default_Ignorable_Code_Point})[\p{L}\p{N}]/u.test(typed) ? typed.trim() : "";
}

/** "45% · 1.1 MB of 2.4 MB" ("45 % · 1,1 MB av 2,4 MB"). An empty file counts as done. */
export function formatProgress(bytes: number, total: number, lang: Lang): string {
  const percent = total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : 100;
  return MESSAGES[lang].format.progress(
    new Intl.NumberFormat(lang, { style: "percent" }).format(percent / 100),
    formatBytes(bytes, lang),
    formatBytes(total, lang),
  );
}

/** How long a transfer of `total` bytes has left, from the rate over the last `windowMs`; undefined while the connection warms up. */
export function etaTracker(total: number, windowMs = 2000, warmupMs = 5000) {
  const samples: Array<readonly [number, number]> = [];
  let start: number | undefined;
  return (now: number, bytes: number): number | undefined => {
    start ??= now;
    samples.push([now, bytes]);
    while (samples.length > 2 && now - (samples[1]?.[0] ?? now) >= windowMs) {
      samples.shift();
    }
    const [since, from] = samples[0] ?? [now, bytes];
    if (now - start < warmupMs || bytes <= from) {
      return undefined;
    }
    return ((total - bytes) * (now - since)) / (bytes - from) / 1000;
  };
}

/** "About 2 minutes left" ("Ungefär 2 minuter kvar"): 5-second steps under a minute, then minutes, then hours. */
export function formatTimeLeft(seconds: number, lang: Lang): string {
  const [value, unit] =
    seconds < 55
      ? [Math.max(5, Math.round(seconds / 5) * 5), "second"]
      : seconds < 3570
        ? [Math.round(seconds / 60), "minute"]
        : [Math.round(seconds / 3600), "hour"];
  const duration = new Intl.NumberFormat(lang, { style: "unit", unit, unitDisplay: "long" }).format(
    value,
  );
  return MESSAGES[lang].format.timeLeft(duration);
}
