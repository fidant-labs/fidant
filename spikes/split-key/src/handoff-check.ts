// Fragment handoff check for the SIG-7 spike: does a link fragment carrying
// the 43-character F survive email clients, link scanners and chat apps?
//
// The probe link is
//
//   <origin>/handoff.html?probe=1#k=<43 chars of F>.<8 chars of check>
//
// where check = base64url(first 6 bytes of SHA-256(F)). The landing page has
// no copy of F, so the check is what lets it tell an intact fragment from a
// mangled one. F here is a dummy made for the probe, never a real key: the
// check would leak 48 bits of a hash of a real F. The `probe=1` query marks
// the landing page even when the fragment is lost, and shows whether a channel
// rewrote the query.
//
// Verdicts, in the order they are tested:
// - missing:   no fragment, or one without `k=` anywhere
// - altered:   wrong prefix, separator or characters, or the check fails
// - truncated: shorter than expected, and what arrived is a clean prefix
// - trailing:  F and the check verify, but extra characters follow (chat
//              autolinkers that swallow a trailing `)` or `.`)
// - intact:    exactly what was sent
//
// A percent-encoded fragment (some clients encode `.` or `=`) is decoded once
// with decodeURIComponent before parsing. That is safe because F and the
// check use only base64url characters, so the decoded form is unambiguous;
// `percentDecoded` records that it happened.

import { encodeBase64url } from "../../../apps/web/src/lib/base64url.ts";
import { decodeFragmentHalf, FRAGMENT_HALF_CHARS } from "./keys.ts";

export const HANDOFF_PATH = "/handoff.html";
export const HANDOFF_QUERY = "?probe=1";
export const FRAGMENT_PREFIX = "k=";
export const CHECK_SEPARATOR = ".";
export const CHECK_BYTES = 6;
/** 6 bytes encode to 8 base64url characters with no leftover bits. */
export const CHECK_CHARS = 8;
/** Length of the fragment after `#`: `k=`, F, `.`, check. */
export const HANDOFF_FRAGMENT_CHARS =
  FRAGMENT_PREFIX.length + FRAGMENT_HALF_CHARS + CHECK_SEPARATOR.length + CHECK_CHARS;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

const characters = (count: number) => `${count} character${count === 1 ? "" : "s"}`;

export type HandoffVerdict = "intact" | "trailing" | "truncated" | "altered" | "missing";

export type HandoffCheck = {
  verdict: HandoffVerdict;
  /** Length of the fragment as it arrived, before any percent-decoding. */
  receivedLength: number;
  expectedLength: number;
  percentDecoded: boolean;
  /** Characters after the check, for the trailing verdict. */
  extraLength: number;
  /** Which parts passed. A part that never arrived counts as failed. */
  parts: { prefix: boolean; length: boolean; charset: boolean; check: boolean };
  /** One line for the page, naming the first part that failed. */
  reason: string;
};

async function checkFor(fragmentHalf: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", fragmentHalf));
  return encodeBase64url(digest.subarray(0, CHECK_BYTES));
}

/** The fragment for a probe link, without the leading `#`. */
export async function makeHandoffFragment(fragmentHalf: Uint8Array<ArrayBuffer>): Promise<string> {
  const encoded = encodeBase64url(fragmentHalf);
  if (encoded.length !== FRAGMENT_HALF_CHARS) {
    throw new Error(`fragment half must encode to ${FRAGMENT_HALF_CHARS} characters`);
  }
  return `${FRAGMENT_PREFIX}${encoded}${CHECK_SEPARATOR}${await checkFor(fragmentHalf)}`;
}

/** The full probe link for a base origin such as `https://192.168.1.5:8451`. */
export async function makeHandoffLink(
  origin: string,
  fragmentHalf: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return `${origin}${HANDOFF_PATH}${HANDOFF_QUERY}#${await makeHandoffFragment(fragmentHalf)}`;
}

/** Checks a received fragment, with or without its leading `#`. */
export async function checkHandoffFragment(hash: string): Promise<HandoffCheck> {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const result: HandoffCheck = {
    verdict: "missing",
    receivedLength: raw.length,
    expectedLength: HANDOFF_FRAGMENT_CHARS,
    percentDecoded: false,
    extraLength: 0,
    parts: { prefix: false, length: false, charset: false, check: false },
    reason: "",
  };
  const finish = (verdict: HandoffVerdict, reason: string): HandoffCheck => {
    result.verdict = verdict;
    result.reason = reason;
    return result;
  };

  let text = raw;
  if (raw.includes("%")) {
    try {
      text = decodeURIComponent(raw);
    } catch {
      return finish("altered", "the fragment has a broken percent-encoding");
    }
    result.percentDecoded = text !== raw;
  }
  if (text === "") {
    return finish("missing", "no fragment arrived");
  }
  if (!text.startsWith(FRAGMENT_PREFIX)) {
    return text.includes(FRAGMENT_PREFIX)
      ? finish("altered", "characters were added before `k=`")
      : finish("missing", "the fragment has no `k=`");
  }
  result.parts.prefix = true;

  const body = text.slice(FRAGMENT_PREFIX.length);
  const key = body.slice(0, FRAGMENT_HALF_CHARS);
  const separator = body.slice(FRAGMENT_HALF_CHARS, FRAGMENT_HALF_CHARS + 1);
  const check = body.slice(FRAGMENT_HALF_CHARS + 1, FRAGMENT_HALF_CHARS + 1 + CHECK_CHARS);
  const extra = body.slice(FRAGMENT_HALF_CHARS + 1 + CHECK_CHARS);
  const cleanPrefix =
    BASE64URL.test(key) &&
    (separator === "" || separator === CHECK_SEPARATOR) &&
    BASE64URL.test(check);

  if (text.length < HANDOFF_FRAGMENT_CHARS) {
    return cleanPrefix
      ? finish("truncated", `${characters(HANDOFF_FRAGMENT_CHARS - text.length)} missing`)
      : finish("altered", "the fragment is short and has characters outside base64url");
  }
  result.parts.length = true;
  if (!cleanPrefix) {
    return finish("altered", "F, the separator or the check has characters outside base64url");
  }
  const fragmentHalf = decodeFragmentHalf(key);
  if (!fragmentHalf) {
    // 43 base64url characters carry 258 bits; non-zero spare bits mean a changed last character.
    return finish("altered", "F does not decode to 32 bytes");
  }
  result.parts.charset = true;
  if ((await checkFor(fragmentHalf)) !== check) {
    return finish("altered", "the check does not match F");
  }
  result.parts.check = true;
  if (extra !== "") {
    result.extraLength = extra.length;
    return finish("trailing", `F is intact, but ${characters(extra.length)} more follow the check`);
  }
  return finish("intact", "F and the check arrived unchanged");
}

export type LocationReport = {
  pathChanged: boolean;
  queryChanged: boolean;
  /** The probe fragment shows up in the query string, raw or percent-encoded. */
  fragmentInQuery: boolean;
};

/** Compares the landing URL's path and query with what the probe link sent. */
export function inspectLocation(location: { pathname: string; search: string }): LocationReport {
  let search = location.search;
  try {
    search = decodeURIComponent(search);
  } catch {
    // Keep the raw query; the pattern below still finds an unencoded fragment.
  }
  return {
    pathChanged: location.pathname !== HANDOFF_PATH,
    queryChanged: location.search !== HANDOFF_QUERY,
    fragmentInQuery: /(^|[?&#=])k=[A-Za-z0-9_-]{8,}/.test(search),
  };
}
