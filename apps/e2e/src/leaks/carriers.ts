import { isUtf8 } from "node:buffer";
import { decodeViews } from "./decode.ts";
import { minWindow } from "./needles.ts";
import { type Capture, context, type Finding } from "./scan.ts";

/**
 * A value that may legitimately contain the file name: the receipt text, its base64, the BankID
 * signature blob ("Where the file name may appear" in 0001). The detector collects carriers from
 * their origin fields, then masks them at the allowed points before the scan looks for M.
 */
export interface Carrier {
  /** Names the carrier in findings, such as `receipt text`. */
  name: string;
  /** Text is matched in NFC and NFD, as UTF-8. */
  value: Uint8Array | string;
}

export interface MaskedCaptures {
  /** The captures with carriers masked at allowed points; the others unchanged. */
  captures: Capture[];
  /** Class M findings for carriers seen at points that are not allowed. */
  misplaced: Finding[];
}

/** Carriers shorter than this are refused: masking short values could hide real leaks. */
const minCarrierBytes = 16;

/**
 * Masks carriers at allowed points and reports them everywhere else.
 *
 * A carrier is present in a capture if any decoded view (see `decodeViews`) holds its bytes, so
 * presence covers every encoding the decoder understands, nested ones included. A capture at a
 * point that is not allowed with a carrier present gives one finding per carrier.
 *
 * At an allowed point, each occurrence of a carrier in the raw bytes is overwritten with `.` of
 * the same length, so offsets in later findings still line up. Masked encodings of the carrier:
 * its bytes; base64 and base64url, padded or not, starting on the carrier's first byte; hex in
 * either case; and for UTF-8 carriers (NFC and NFD) percent-encoding (`%20` or `+`, either hex
 * case) and the inside of a JSON string, with non-ASCII kept or as `\uXXXX`.
 *
 * Not masked: a carrier that sits inside another encoding layer (base64 of a JSON document that
 * holds it, gzip, quoted-printable, UTF-16), or base64 of it that starts mid-run, off its first
 * byte. Those stay visible, so the scan reports M there: a false alarm to handle by adding the
 * outer value as a carrier, never a missed leak.
 */
export function maskCarriers(
  captures: Capture[],
  carriers: Carrier[],
  allowedPoints: (point: string) => boolean,
): MaskedCaptures {
  const prepared = carriers.map((carrier) => {
    const values = carrierValues(carrier);
    if (values.some((value) => value.length < minCarrierBytes)) {
      throw new RangeError(`carrier ${carrier.name} is shorter than ${minCarrierBytes} bytes`);
    }
    return { name: carrier.name, values, encoded: encodings(values) };
  });
  const misplaced: Finding[] = [];
  const masked = captures.map((capture) => {
    if (allowedPoints(capture.point)) {
      const bytes = Buffer.from(capture.bytes);
      for (const carrier of prepared) {
        for (const form of carrier.encoded) fill(bytes, form);
      }
      return { ...capture, bytes };
    }
    if (prepared.length === 0) return capture;
    const { views } = decodeViews(capture.bytes, capture.hints);
    for (const carrier of prepared) {
      found: for (const view of views) {
        for (const value of carrier.values) {
          const offset = view.bytes.indexOf(value);
          if (offset === -1) continue;
          misplaced.push({
            class: "M",
            label: `carrier ${carrier.name}`,
            point: capture.point,
            view: view.path,
            offset,
            length: value.length,
            context: context(view.bytes, offset, value.length),
          });
          break found;
        }
      }
    }
    return capture;
  });
  return { captures: masked, misplaced };
}

/** The carrier's bytes: once for binary, NFC and NFD UTF-8 for text. */
function carrierValues(carrier: Carrier): Buffer[] {
  if (typeof carrier.value !== "string") return [Buffer.from(carrier.value)];
  const forms = new Set([carrier.value.normalize("NFC"), carrier.value.normalize("NFD")]);
  return [...forms].map((form) => Buffer.from(form));
}

/** Every masked encoding of the values, longest first so a padded form wins over its prefix. */
function encodings(values: Buffer[]): Buffer[] {
  const forms = new Map<string, Buffer>();
  const add = (form: Buffer | string) => {
    const bytes = typeof form === "string" ? Buffer.from(form) : form;
    if (bytes.length >= minWindow) forms.set(bytes.toString("hex"), bytes);
  };
  for (const value of values) {
    add(value);
    const base64 = value.toString("base64");
    add(base64);
    add(base64.replace(/=+$/, ""));
    add(value.toString("base64url"));
    add(value.toString("hex"));
    add(value.toString("hex").toUpperCase());
    const text = utf8(value);
    if (text === undefined) continue;
    const percent = encodeURIComponent(text);
    for (const form of [percent, percent.replaceAll("%20", "+")]) {
      add(form);
      add(form.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()));
    }
    const json = JSON.stringify(text).slice(1, -1);
    add(json);
    add(
      json.replace(
        /[\u0080-\uffff]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    );
  }
  return [...forms.values()].sort((a, b) => b.length - a.length);
}

/** The value as text, or undefined when it is not valid UTF-8. */
function utf8(value: Buffer): string | undefined {
  return isUtf8(value) ? value.toString("utf8") : undefined;
}

const filler = 0x2e; // "."

function fill(bytes: Buffer, form: Buffer): void {
  for (let at = bytes.indexOf(form); at !== -1; at = bytes.indexOf(form, at + form.length)) {
    bytes.fill(filler, at, at + form.length);
  }
}
