import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { canaryFile, canaryKey, SeededRandom } from "./canary.ts";
import { buildNeedles, fileSecrets, keySecrets } from "./needles.ts";
import { context, type Finding, findSize, formatFinding, scan } from "./scan.ts";

// Every canary comes from a fixed seed at run time; no random-looking literal is committed.
const random = SeededRandom.fromLabel("scan test");
const file = canaryFile(random.fork("file"), { size: 150_001 });
const key = canaryKey(random.fork("key"));
const needles = buildNeedles([...fileSecrets("file#1", file), ...keySecrets("fragment", key.text)]);
const junk = random.bytes(2048);

function findings(blob: Buffer | string, hints = {}): Finding[] {
  const bytes = typeof blob === "string" ? Buffer.from(blob) : blob;
  return scan([{ point: "test.jsonl#1 body", bytes, hints }], needles);
}

/** The `class label @ view` of each finding, for compact assertions. */
function found(blob: Buffer | string, hints = {}): string[] {
  return findings(blob, hints).map((f) => `${f.class} ${f.label} @ ${f.view}`);
}

const percentAll = (bytes: Buffer) => [...bytes].map((byte) => `%${byte.toString(16)}`).join("");
const unicodeEscapes = (text: string) =>
  [...text].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

test("finds content in raw bytes", () => {
  const part = file.bytes.subarray(1000, 5000);
  assert.deepEqual(found(Buffer.concat([junk, part, junk])), ["C file#1 @ raw"]);
});

test("finds a key in hex of either case", () => {
  assert.deepEqual(found(`id=${key.bytes.toString("hex")}`), ["K fragment @ hex@0"]);
  assert.deepEqual(found(`ID=${key.bytes.toString("hex").toUpperCase()}`), ["K fragment @ hex@0"]);
});

test("finds a key in base64 and base64url, padded or not, at every alignment", () => {
  for (const encoding of ["base64", "base64url"] as const) {
    for (const prefix of [0, 1, 2]) {
      for (const pad of [true, false]) {
        let text = Buffer.concat([random.bytes(prefix), key.bytes]).toString(encoding);
        text = pad ? text.padEnd(Math.ceil(text.length / 4) * 4, "=") : text.replace(/=+$/, "");
        const result = found(`{"v":"${text}"}`);
        assert.ok(
          result.some((line) => line.startsWith("K fragment @")),
          `${encoding} ${prefix} ${pad}`,
        );
      }
    }
  }
});

test("finds the literal fragment secret", () => {
  assert.deepEqual(found(`GET /r/abc?k=${key.text}`), [
    "K fragment text @ raw",
    "K fragment @ base64@0",
  ]);
  assert.deepEqual(found(`GET /r/abc?k=${key.text.slice(3, 23)}`), ["K fragment text @ raw"]);
});

test("finds content in JSON in base64 in JSON", () => {
  const inner = JSON.stringify({ chunk: file.bytes.subarray(0, 64).toString("base64") });
  const outer = JSON.stringify({ data: Buffer.from(inner).toString("base64url") });
  assert.deepEqual(found(outer), ["C file#1 @ base64@0"]);
});

test("finds content in a gzip body", () => {
  const body = gzipSync(JSON.stringify({ hex: file.bytes.subarray(0, 100).toString("hex") }));
  assert.deepEqual(found(body, { contentEncoding: "gzip" }), ["C file#1 @ gzip>hex@0"]);
});

test("finds content as Postgres bytea", () => {
  const statement = `INSERT INTO blobs VALUES ('\\x${file.bytes.subarray(0, 32).toString("hex")}')`;
  assert.deepEqual(found(statement), ["C file#1 @ hex@0"]);
});

test("finds the SHA-256 of the content, the name and a key", () => {
  assert.deepEqual(found(`/check/${sha256(file.bytes).toString("hex")}`), [
    "C file#1 sha256 @ hex@0",
  ]);
  assert.deepEqual(found(`{"h":"${sha256(file.bytes).toString("base64")}"}`), [
    "C file#1 sha256 @ raw",
  ]);
  assert.deepEqual(found(`n=${sha256(file.name.normalize("NFD")).toString("hex")}`), [
    "M file#1 name sha256 @ hex@0",
  ]);
  assert.deepEqual(found(`k=${sha256(key.bytes).toString("base64url")}`), [
    "K fragment sha256 @ raw",
  ]);
});

test("finds the name in NFC, NFD and any case", () => {
  assert.deepEqual(found(`name: ${file.name}`), ["M file#1 name @ raw"]);
  assert.deepEqual(found(Buffer.from(`name: ${file.name.normalize("NFD")}`)), [
    "M file#1 name @ raw",
  ]);
  assert.deepEqual(found(`NAME: ${file.name.toUpperCase()}`), ["M file#1 name @ raw"]);
  assert.deepEqual(found(`x-${file.token.slice(2, 14)}-y`), ["M file#1 name @ raw"]);
  assert.deepEqual(found(`x-${file.token.slice(2, 13)}-y`), []);
});

test("finds the name percent-encoded in NFD", () => {
  const path = percentAll(Buffer.from(file.name.normalize("NFD")));
  assert.deepEqual(found(`GET /files/${path} HTTP/1.1`), ["M file#1 name @ percent"]);
});

test("finds the name in JSON \\u escapes", () => {
  assert.deepEqual(found(`{"name":"${unicodeEscapes(file.name)}"}`), ["M file#1 name @ json"]);
});

test("finds the name and type in UTF-16 of either byte order", () => {
  const le = Buffer.from(file.name, "utf16le");
  assert.deepEqual(found(Buffer.concat([junk, le, junk])), ["M file#1 name @ utf16le"]);
  const be = Buffer.from(file.mime, "utf16le").swap16();
  // A big-endian run also reads as little-endian from the byte before it; either view counts.
  const [beFinding] = found(Buffer.concat([junk, be, junk]));
  assert.match(beFinding ?? "", /^M file#1 type @ utf16(le|be)$/);
});

test("finds a 16-byte partial window of a key, but not 15", () => {
  const window = key.bytes.subarray(9, 25);
  assert.deepEqual(found(Buffer.concat([junk, window, junk])), ["K fragment @ raw"]);
  assert.deepEqual(found(Buffer.concat([junk, window.subarray(1), junk])), []);
  // Off the 3-byte grid, so the base64url is not also a slice of the fragment secret's text.
  const shifted = key.bytes.subarray(10, 26);
  assert.deepEqual(found(`p=${shifted.toString("base64url")}`), ["K fragment @ raw"]);
  // 13 bytes are 17 fully determined characters, fewer than the 20 of a 16-byte window.
  assert.deepEqual(found(`p=${shifted.subarray(3).toString("base64url")}`), []);
});

test("finds the size as a whole decimal or hex number", () => {
  const n = file.size;
  const hex = n.toString(16);
  for (const text of [
    `content-length: ${n}\r\n`,
    `{"size":${n}}`,
    `size=000${n}`,
    `bytes:${n}`,
    `len=0x${hex}`,
    `len=0X${hex.toUpperCase()}`,
    `len ${hex};`,
    `len=0x000${hex}`,
  ]) {
    assert.deepEqual(found(text), ["M file#1 size @ raw"], text);
  }
  for (const text of [`${n}7`, `1${n}`, `v${n - 1}`, `id=a${hex}`, `${hex}z`, `0${hex}g`]) {
    assert.deepEqual(found(text), [], text);
  }
});

test("finds the size in a decoded view", () => {
  const message = Buffer.from(`{"event":"upload","size":${file.size}}`).toString("base64");
  assert.deepEqual(found(`{"m":"${message}"}`), ["M file#1 size @ base64@0"]);
});

test("reports one finding per secret and point, from the shallowest view", () => {
  const body = `${file.name} ${file.name} ${Buffer.from(file.name).toString("base64")}`;
  const result = scan(
    [
      { point: "a.jsonl#1 url", bytes: Buffer.from(body) },
      { point: "a.jsonl#2 url", bytes: Buffer.from(file.mime) },
    ],
    needles,
  );
  assert.deepEqual(
    result.map((f) => `${f.point}: ${f.class} ${f.label} @ ${f.view}`),
    ["a.jsonl#1 url: M file#1 name @ raw", "a.jsonl#2 url: M file#1 type @ raw"],
  );
});

test("shows the match with context", () => {
  const [finding] = findings(`GET /upload?name=${file.name} HTTP/1.1`);
  assert.ok(finding);
  assert.equal(finding.offset, "GET /upload?name=sigill-".length);
  assert.equal(finding.length, 16);
  assert.equal(
    finding.context,
    `GET /upload?name=sigill-[[${file.token}]]-r\\xc3\\xa4ksm\\xc3\\xb6rg\\xc3\\xa5s.${file.name.slice(-3)} HTTP/1.1`,
  );
  assert.equal(
    formatFinding(finding),
    `M file#1 name in test.jsonl#1 body, view raw, offset 24, 16 bytes: ${finding.context}`,
  );
});

test("shows binary context as hex and cuts long matches", () => {
  const bytes = Buffer.concat([junk, file.bytes.subarray(0, 1000), junk]);
  const shown = context(bytes, junk.length, 1000);
  assert.equal(
    shown,
    `${junk.subarray(-64).toString("hex")}[[${file.bytes.subarray(0, 64).toString("hex")}…]]${junk.subarray(0, 64).toString("hex")}`,
  );
  assert.equal(context(Buffer.from("ab\\c"), 0, 2), "[[ab]]\\\\c");
});

test("reports a capture too large to decode fully", () => {
  const big = Buffer.from(random.bytes(4000).toString("base64"));
  const result = scan([{ point: "big", bytes: big }], needles, { maxBytes: big.length + 100 });
  assert.deepEqual(
    result.map((f) => f.class),
    ["limit"],
  );
});

test("finds nothing in unrelated data", () => {
  const other = SeededRandom.fromLabel("unrelated");
  const blobs = [
    other.bytes(1024 * 1024),
    Buffer.from(other.bytes(512 * 1024).toString("base64")),
    Buffer.from(other.bytes(256 * 1024).toString("hex")),
    gzipSync(other.bytes(256 * 1024)),
    Buffer.from(
      JSON.stringify(
        Array.from({ length: 2000 }, (_, i) => ({
          id: other.bytes(16).toString("base64url"),
          size: other.int(10_000_000),
          name: `file-${i}-${other.bytes(8).toString("hex")}.bin`,
        })),
      ),
    ),
  ];
  const result = scan(
    blobs.map((bytes, i) => ({ point: `blob ${i}`, bytes })),
    needles,
  );
  assert.deepEqual(result.map(formatFinding), []);
});

test("checks the size only when asked", () => {
  const size = { class: "M" as const, label: "n", size: 123_457 };
  assert.deepEqual(findSize(Buffer.from("n=123457"), size), { offset: 2, length: 6 });
  assert.equal(findSize(Buffer.from("n=1234567"), size), undefined);
});

test("finds a size in a header, JSON, a URL or glued to a word or unit", () => {
  const size = { class: "M" as const, label: "n", size: 1_234_567 };
  const texts = ['{"size":1234567}', "x-size: 1234567\r\n", "?n=1234567&x=1", "1234567"];
  for (const text of [...texts, "1234567B", "size1234567", "len:1234567b", "n1234567"]) {
    assert.ok(findSize(Buffer.from(text), size), text);
  }
});

test("ignores a size-like digit run inside a long hex or base64 token", () => {
  const size = { class: "M" as const, label: "n", size: 1_234_567 };
  const hex = random.fork("hex").bytes(32).toString("hex");
  const base64 = random.fork("b64").bytes(48).toString("base64");
  for (const body of [hex, base64]) {
    const text = `${body.slice(0, 12)}g1234567g${body.slice(12)}`;
    assert.equal(findSize(Buffer.from(text), size), undefined, text);
  }
  assert.equal(findSize(Buffer.from("deadbeefdeadbeef1234567deadbeefdeadbeef"), size), undefined);
});

test("finds a size in a path, query pair or snake_case name", () => {
  const size = { class: "M" as const, label: "n", size: 1_234_567 };
  const uuid = random.fork("uuid").bytes(16).toString("hex");
  const dashed = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
  const texts = [
    "GET /api/transfers/upload/1234567 HTTP/1.1",
    "/api/transfers/chunks/1234567",
    `/t/${dashed}/size/1234567`,
    `/t/${uuid}/1234567`,
    "?originalFileSize=1234567",
    "?original_file_size=1234567",
    "?upload_content_length=1234567",
    "x-sigill-original-size=1234567",
    "SIZE_1234567_BYTES_UPLOADED",
    // Pin rule (b): a one-case run is no base64 blob, and glue on one side is not enough.
    "/api/transfers/chunk1234567x/next",
    "/Api/Transfers/chunk1234567/next",
  ];
  for (const text of texts) assert.ok(findSize(Buffer.from(text), size), text);
});

test("ignores a size-like digit run inside a long base64url token", () => {
  const size = { class: "M" as const, label: "n", size: 1_234_567 };
  const body = random.fork("b64url").bytes(48).toString("base64url");
  const text = `${body.slice(0, 12)}g1234567g${body.slice(12)}`;
  assert.equal(findSize(Buffer.from(text), size), undefined, text);
});

test("reports a decompression bomb as a limit and still scans what came out", () => {
  const MiB = 1024 * 1024;
  const body = gzipSync(Buffer.concat([key.bytes, Buffer.alloc(65 * MiB)]));
  const result = found(body);
  assert.ok(result.includes("K fragment @ gzip"), result.join());
  const limit = findings(body).find((finding) => finding.class === "limit");
  assert.ok(limit);
});
