import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brotliCompressSync,
  constants,
  deflateRawSync,
  deflateSync,
  gzipSync,
  inflateRawSync,
  zstdCompressSync,
} from "node:zlib";
import { SeededRandom } from "./canary.ts";
import { decodePercent, decodeQuotedPrintable, decodeViews, unescapeJson } from "./decode.ts";

// Secrets are generated at run time, so no random-looking literal reaches the repository.
const random = SeededRandom.fromLabel("decode test");
const secret = random.bytes(32);
const junk = random.bytes(4096);

/** The paths of the views that contain `needle`. */
function pathsWith(blob: Uint8Array | string, needle: Uint8Array | string, hints = {}): string[] {
  const bytes = typeof blob === "string" ? Buffer.from(blob, "latin1") : blob;
  return decodeViews(bytes, hints)
    .views.filter((view) =>
      view.bytes.includes(typeof needle === "string" ? needle : Buffer.from(needle)),
    )
    .map((view) => view.path);
}

test("keeps text without encodings as the raw view only", () => {
  const { views, truncated } = decodeViews(Buffer.from("GET /index.html HTTP/1.1\r\n"));
  assert.deepEqual(
    views.map((view) => view.path),
    ["raw"],
  );
  assert.equal(truncated, false);
});

test("finds raw bytes in the raw view", () => {
  assert.deepEqual(pathsWith(Buffer.concat([junk, secret, junk]), secret), ["raw"]);
});

test("decodes base64 and base64url at every character offset", () => {
  for (const encoding of ["base64", "base64url"] as const) {
    for (const prefix of [0, 1, 2]) {
      const encoded = Buffer.concat([random.bytes(prefix), secret]).toString(encoding);
      for (const cut of [0, 1, 2, 3]) {
        const text = `{"x":"${encoded.slice(cut)}"}`;
        const window = secret.subarray(3, 19);
        assert.ok(
          pathsWith(text, window).some((path) => /^base64@[0-3]$/.test(path)),
          text,
        );
      }
    }
  }
});

test("decodes a 16-byte value in unpadded base64url, 22 characters", () => {
  const value = secret.subarray(0, 16);
  assert.deepEqual(pathsWith(`?k=${value.toString("base64url")}&x=1`, value), ["base64@0"]);
});

test("decodes base64 wrapped across lines", () => {
  const wrapped = Buffer.concat([random.bytes(100), secret])
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  assert.ok(wrapped.includes("\r\n"));
  assert.deepEqual(pathsWith(wrapped, secret), ["base64@0"]);
});

test("decodes hex in either case at both nibble offsets", () => {
  const lower = secret.toString("hex");
  assert.ok(pathsWith(`id=${lower}`, secret).includes("hex@0"));
  assert.ok(pathsWith(`id=${lower.toUpperCase()}`, secret).includes("hex@0"));
  assert.ok(pathsWith(`id=f${lower}`, secret).includes("hex@1"));
});

test("decodes \\x-prefixed and separated hex", () => {
  assert.ok(
    pathsWith(`INSERT INTO t VALUES ('\\x${secret.toString("hex")}')`, secret).includes("hex@0"),
  );
  const fingerprint = (secret.toString("hex").match(/../g) ?? []).join(":").toUpperCase();
  assert.deepEqual(pathsWith(`a=fingerprint:sha-256 ${fingerprint}`, secret), ["hex-separated"]);
});

test("undoes JSON string escapes", () => {
  const token = "abcdefghijklmnop";
  const escaped = [...token].map(
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  assert.deepEqual(pathsWith(`{"name":"${escaped.join("")}"}`, token), ["json"]);
  assert.equal(
    unescapeJson('a\\"b\\\\c\\/d\\n\\u00e4\\ud83d\\ude00\\q').toString(),
    'a"b\\c/d\nä😀\\q',
  );
  assert.equal(unescapeJson("\\ud800x").toString(), "�x");
});

test("decodes a binary string sent as JSON", () => {
  const binary = JSON.stringify({ data: String.fromCharCode(...secret) });
  assert.ok(pathsWith(Buffer.from(binary), secret).some((path) => /latin1$/.test(path)));
});

test("decodes percent and form encoding", () => {
  const token = "abcdefghijklmnop";
  const encoded = [...Buffer.from(token)].map((byte) => `%${byte.toString(16)}`).join("");
  assert.deepEqual(pathsWith(`/files/${encoded}`, token), ["percent"]);
  assert.deepEqual(pathsWith(`q=${encoded}+and+more`, `${token} and`), ["form"]);
  assert.equal(decodePercent("a+%2B%zz%2", false).toString(), "a++%zz%2");
  assert.equal(decodePercent("a+b", true).toString(), "a b");
});

test("decodes quoted-printable and RFC 2047 words", () => {
  assert.equal(decodeQuotedPrintable("caf=C3=A9 =\r\nau lait").toString(), "café au lait");
  const subject = `Subject: =?UTF-8?B?${Buffer.from("räksmö").toString("base64")}?=\r\n =?utf-8?Q?rg=C3=A5s_X?=`;
  assert.deepEqual(pathsWith(subject, Buffer.from("räksmörgås X")), ["rfc2047"]);
  assert.deepEqual(pathsWith("a =?x-unknown?B?YWJj?= b", "abc"), []);
  const body = `Content-Transfer-Encoding: quoted-printable\r\n\r\nr=C3=A4ksm=\r\n=C3=B6rg=C3=A5s`;
  assert.deepEqual(pathsWith(body, Buffer.from("räksmörgås")), ["qp"]);
});

test("decodes UTF-16 runs in either byte order", () => {
  const text = "fidant-abcdefghijklmnop-räksmörgås";
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.from(le).swap16();
  assert.ok(pathsWith(Buffer.concat([junk, le, junk]), Buffer.from(text)).includes("utf16le"));
  assert.ok(pathsWith(Buffer.concat([junk, be, junk]), Buffer.from(text)).includes("utf16be"));
});

// Compressible padding, so the secret is not stored as it is inside the compressed stream.
const padding = Buffer.alloc(4096, "a");

test("decompresses gzip, zstd and zlib by their magic bytes", () => {
  const data = Buffer.concat([padding, secret]);
  assert.deepEqual(pathsWith(Buffer.concat([junk, gzipSync(data), junk]), secret), ["gzip"]);
  // zstd stores incompressible literals as they are, so the raw view holds the secret too.
  const zstd = Buffer.concat([junk, zstdCompressSync(data), junk]);
  assert.ok(pathsWith(zstd, secret).includes("zstd"));
  assert.deepEqual(pathsWith(deflateSync(data), secret), ["deflate"]);
});

test("decompresses what arrived of a stream cut short", () => {
  const data = Buffer.concat([padding, secret, random.bytes(100_000)]);
  const gzipped = gzipSync(data);
  assert.deepEqual(pathsWith(gzipped.subarray(0, gzipped.length / 2), secret), ["gzip"]);
});

test("decompresses the complete blocks of a zstd stream cut short", () => {
  // zstd decodes whole 128 KiB blocks, so the secret sits in the first of several.
  const data = Buffer.concat([padding, secret, Buffer.alloc(400_000, "b"), random.bytes(1000)]);
  const zstd = zstdCompressSync(data);
  assert.ok(pathsWith(zstd.subarray(0, zstd.length - 100), secret).includes("zstd"));
});

test("decompresses a corrupt stream up to the damage", () => {
  const gzipHeader = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
  const first = deflateRawSync(Buffer.concat([padding, secret]), {
    finishFlush: constants.Z_SYNC_FLUSH,
  });
  const next = deflateRawSync(padding);
  next[0] = (next[0] ?? 0) | 0b110; // Block type 11, which RFC 1951 reserves as an error.
  const body = Buffer.concat([first, next]);
  assert.throws(() => inflateRawSync(body, { finishFlush: constants.Z_SYNC_FLUSH }));
  const decoded = decodeViews(Buffer.concat([gzipHeader, body]));
  assert.deepEqual(
    decoded.views.filter((view) => view.bytes.includes(secret)).map((view) => view.path),
    ["gzip"],
  );
  assert.equal(decoded.truncated, false);
});

test("reports no cap for random bytes behind a false gzip magic", () => {
  for (let i = 0; i < 20; i++) {
    const blob = Buffer.concat([Buffer.from([0x1f, 0x8b, 8]), random.bytes(64 * 1024)]);
    assert.equal(decodeViews(blob).truncated, false);
  }
});

test("decompresses brotli and raw deflate when the content-encoding says so", () => {
  const data = Buffer.concat([padding, secret]);
  assert.deepEqual(pathsWith(brotliCompressSync(data), secret, { contentEncoding: "br" }), ["br"]);
  assert.deepEqual(pathsWith(deflateRawSync(data), secret, { contentEncoding: "deflate" }), [
    "deflate-raw",
  ]);
  assert.deepEqual(pathsWith(brotliCompressSync(data), secret), []);
});

test("decodes nested JSON in base64 in JSON", () => {
  const inner = JSON.stringify({ key: secret.toString("base64") });
  const outer = JSON.stringify({ data: Buffer.from(inner).toString("base64") });
  assert.deepEqual(pathsWith(outer, secret), ["base64@0>base64@0"]);
  const gzipped = gzipSync(Buffer.from(`{"a":"x\\/y","b":"${secret.toString("hex")}"}`));
  assert.deepEqual(pathsWith(gzipped, secret), ["gzip>hex@0"]);
});

test("stops at the depth limit", () => {
  let encoded = secret.toString("base64");
  for (let i = 0; i < 3; i++) {
    encoded = Buffer.from(encoded).toString("base64");
  }
  assert.deepEqual(pathsWith(encoded, secret), []);
  const views = decodeViews(Buffer.from(encoded), {}, { maxDepth: 4 }).views;
  assert.ok(views.some((view) => view.bytes.includes(secret) && view.depth === 4));
});

test("keeps each distinct view once", () => {
  const run = secret.toString("base64");
  const { views } = decodeViews(Buffer.from(`${run} ${run} ${run}`));
  assert.equal(views.filter((view) => view.path === "base64@0").length, 1);
});

test("reports when the byte budget stops decoding", () => {
  const big = random.bytes(3000).toString("base64");
  const decoded = decodeViews(Buffer.from(big), {}, { maxBytes: big.length + 3000 });
  assert.equal(decoded.truncated, true);
  assert.ok(decoded.views.reduce((sum, view) => sum + view.bytes.length, 0) <= big.length + 3000);
  assert.equal(decodeViews(Buffer.from(big)).truncated, false);
});

test("finds no encoded runs in random bytes", () => {
  const { views, truncated } = decodeViews(random.bytes(1024 * 1024));
  assert.equal(truncated, false);
  assert.ok(views.length < 5, String(views.length));
});
