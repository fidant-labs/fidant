import { type DecodeHints, type DecodeOptions, decodeViews, type View } from "./decode.ts";
import type { Needles, SecretClass, SizeSecret } from "./needles.ts";

/** One captured blob and where it was seen. */
export interface Capture {
  /** The observation point: a file plus record index and field, or a log file and line. */
  point: string;
  bytes: Uint8Array;
  hints?: DecodeHints;
}

/** A secret found in a capture. One finding per secret label and point. */
export interface Finding {
  /** The secret's class, or `limit` when a capture was too large to decode fully. */
  class: SecretClass | "limit";
  label: string;
  point: string;
  /** The decode path of the view it was found in, such as `raw` or `json>base64@1`. */
  view: string;
  offset: number;
  length: number;
  /**
   * The match with up to 64 bytes either side, as escaped text or hex. Findings are printed in
   * public CI logs and written to observations/, which CI uploads. That is acceptable only
   * because canaries and their keys are throwaway test values: never scan for real secrets.
   */
  context: string;
}

/**
 * Decodes every capture into views and reports each secret of `needles` found in them: byte
 * windows (with case folding where the secret asks for it) and sizes as whole numbers.
 * Never throws for a leak; the caller decides how to fail.
 */
export function scan(
  captures: Iterable<Capture>,
  needles: Needles,
  options: DecodeOptions = {},
): Finding[] {
  const findings: Finding[] = [];
  for (const capture of captures) {
    const { views, truncated } = decodeViews(capture.bytes, capture.hints, options);
    const found = new Set<string>();
    const report = (finding: Omit<Finding, "point">) => {
      const key = `${finding.class} ${finding.label}`;
      if (found.has(key)) return;
      found.add(key);
      findings.push({ ...finding, point: capture.point });
    };
    for (const view of views) {
      needles.match(view.bytes, ({ secret, offset, length }) =>
        report(finding(secret.class, secret.label, view, offset, length)),
      );
      for (const size of needles.sizes) {
        const at = findSize(view.bytes, size);
        if (at) report(finding(size.class, size.label, view, at.offset, at.length));
      }
    }
    if (truncated) {
      report({
        class: "limit",
        label: "decode budget used up; some views were not scanned",
        view: "raw",
        offset: 0,
        length: 0,
        context: "",
      });
    }
  }
  return findings;
}

/** One line per finding, for test failures and logs. */
export function formatFinding(finding: Finding): string {
  return (
    `${finding.class} ${finding.label} in ${finding.point}, view ${finding.view}, ` +
    `offset ${finding.offset}, ${finding.length} bytes: ${finding.context}`
  );
}

function finding(
  cls: SecretClass,
  label: string,
  view: View,
  offset: number,
  length: number,
): Omit<Finding, "point"> {
  return {
    class: cls,
    label,
    view: view.path,
    offset,
    length,
    context: context(view.bytes, offset, length),
  };
}

const contextBytes = 64;

/** The match between `[[` and `]]`, with up to 64 bytes either side. Long matches are cut. */
export function context(bytes: Buffer, offset: number, length: number): string {
  const shown = Math.min(length, contextBytes);
  const before = bytes.subarray(Math.max(0, offset - contextBytes), offset);
  const match = bytes.subarray(offset, offset + shown);
  const after = bytes.subarray(offset + length, offset + length + contextBytes);
  const all = Buffer.concat([before, match, after]);
  const printable = all.filter((byte) => byte >= 0x20 && byte < 0x7f).length;
  const render =
    printable >= all.length * 0.8 ? escapeText : (part: Buffer) => part.toString("hex");
  const cut = shown < length ? "…" : "";
  return `${render(before)}[[${render(match)}${cut}]]${render(after)}`;
}

function escapeText(bytes: Buffer): string {
  let text = "";
  for (const byte of bytes) {
    if (byte === 0x5c) text += "\\\\";
    else if (byte >= 0x20 && byte < 0x7f) text += String.fromCharCode(byte);
    else text += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return text;
}

const isDigit = (byte: number | undefined) => byte !== undefined && byte >= 0x30 && byte <= 0x39;
const isAlphanumeric = (byte: number | undefined) =>
  byte !== undefined && (isDigit(byte) || ((byte | 0x20) >= 0x61 && (byte | 0x20) <= 0x7a));

const isTokenByte = (byte: number | undefined) =>
  isAlphanumeric(byte) ||
  byte === 0x2b || // +
  byte === 0x2f || // /
  byte === 0x3d || // =
  byte === 0x5f || // _
  byte === 0x2d; // -

/**
 * A decimal match is taken for a digit run inside an encoded blob, not a size, when either:
 *  (a) hex-like: the run of letters and digits around it (no separators) is `blobRun`+ long. A
 *      16-byte hex id is 32 characters; real leaks (`size1234567`, `1234567B`) are about ten.
 *  (b) base64-like: the run of token bytes (`[0-9A-Za-z+/=_-]`) around it is `blobRun`+ long,
 *      mixes upper and lower case, and the match is glued to a letter or digit on BOTH sides.
 *      Random base64 or base64url puts a letter on both sides of a digit run almost always.
 * Separators (`/ = - _ +`) never join a path, query pair or snake_case name into a blob on their
 * own: `/t/<uuid>/size/N`, `?original_file_size=N` and `SIZE_N_BYTES` have no alphanumeric run
 * over 24 and no glue on both sides. Costs of this rule, accepted: a size inside one 24+ letters
 * and digits token (`uploadSession...N...`) is missed, as is a size glued on both sides to
 * letters in a long mixed-case path (`/Fooo/xN7y/...`); a random base64 digit run that sits
 * right next to `+ / - _ =` is reported. Each scan stops once the run reaches `blobRun` bytes.
 */
const blobRun = 24;

function insideBlob(bytes: Buffer, start: number, end: number): boolean {
  const alnumFrom = (from: number) => {
    while (from > 0 && end - from < blobRun && isAlphanumeric(bytes[from - 1])) from--;
    return from;
  };
  const alnumTo = (to: number) => {
    while (to < bytes.length && to - start < blobRun && isAlphanumeric(bytes[to])) to++;
    return to;
  };
  const a = alnumFrom(start);
  const b = alnumTo(end);
  if (b - a >= blobRun) return true;
  if (!isAlphanumeric(bytes[start - 1]) || !isAlphanumeric(bytes[end])) return false;
  let from = start;
  while (from > 0 && end - from < blobRun && isTokenByte(bytes[from - 1])) from--;
  let to = end;
  while (to < bytes.length && to - from < blobRun && isTokenByte(bytes[to])) to++;
  if (to - from < blobRun) return false;
  const run = bytes.subarray(from, to);
  return run.some((c) => c >= 0x41 && c <= 0x5a) && run.some((c) => c >= 0x61 && c <= 0x7a);
}

/**
 * Where N appears as a whole number: decimal bounded by non-digits, or hex (either case) bounded
 * by non-alphanumerics, hex also after `0x`. Leading zeros count as part of the number. A decimal
 * match inside a long token-like run (see `blobRun`) is ignored: digits occur by chance inside
 * hex and base64 text.
 */
export function findSize(
  bytes: Buffer,
  size: SizeSecret,
): { offset: number; length: number } | undefined {
  const decimal = String(size.size);
  const hex = size.size.toString(16);
  const forms: [string, (byte: number | undefined) => boolean][] = [
    [decimal, isDigit],
    [hex, isAlphanumeric],
    [hex.toUpperCase(), isAlphanumeric],
  ];
  for (const [text, bounds] of forms) {
    for (
      let at = bytes.indexOf(text, 0, "latin1");
      at !== -1;
      at = bytes.indexOf(text, at + 1, "latin1")
    ) {
      let start = at;
      while (bytes[start - 1] === 0x30) start--;
      const end = at + text.length;
      const before = bytes[start - 1];
      const hexPrefix =
        bounds === isAlphanumeric &&
        (before === 0x78 || before === 0x58) &&
        bytes[start - 2] === 0x30;
      if (
        (hexPrefix || !bounds(before)) &&
        !bounds(bytes[end]) &&
        !(bounds === isDigit && insideBlob(bytes, start, end))
      )
        return { offset: start, length: end - start };
    }
  }
  return undefined;
}
