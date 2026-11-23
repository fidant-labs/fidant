import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canaryFile, canaryKey, defaultChunkSize, SeededRandom } from "./canary.ts";
import {
  type ByteSecret,
  buildNeedles,
  fileSecrets,
  keySecrets,
  type Secret,
  textSecrets,
  type WindowMatch,
} from "./needles.ts";

const random = SeededRandom.fromLabel("needles test");
const secret = random.bytes(64);
const junk = random.bytes(1000);
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

function matches(secrets: Secret[], haystack: Buffer): WindowMatch[] {
  const found: WindowMatch[] = [];
  buildNeedles(secrets).match(haystack, (match) => found.push(match));
  return found;
}

const k: ByteSecret = { class: "K", label: "key", bytes: secret };

test("matches any 16-byte window and reports the whole run", () => {
  const found = matches([k], Buffer.concat([junk, secret.subarray(10, 50), junk]));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.secret, k);
  assert.equal(found[0]?.offset, junk.length);
  assert.equal(found[0]?.length, 40);
});

test("matches 16 bytes but not 15", () => {
  for (const start of [0, 7, 48]) {
    const window = secret.subarray(start, start + 16);
    assert.equal(matches([k], Buffer.concat([junk, window, junk])).length, 1, `at ${start}`);
    assert.equal(matches([k], Buffer.concat([junk, window.subarray(1), junk])).length, 0);
    assert.equal(matches([k], Buffer.concat([junk, window.subarray(0, 15), junk])).length, 0);
  }
});

test("finds every separate run, including at the edges of the view", () => {
  const found = matches([k], Buffer.concat([secret.subarray(0, 20), junk, secret.subarray(44)]));
  assert.deepEqual(
    found.map(({ offset, length }) => [offset, length]),
    [
      [0, 20],
      [20 + junk.length, 20],
    ],
  );
});

test("matches a secret shorter than the window whole", () => {
  const short: ByteSecret = { class: "K", label: "short", bytes: secret.subarray(0, 10) };
  assert.equal(matches([short], Buffer.concat([junk, secret.subarray(0, 10)])).length, 1);
  assert.equal(matches([short], Buffer.concat([junk, secret.subarray(0, 9)])).length, 0);
  assert.throws(() => buildNeedles([{ class: "K", label: "tiny", bytes: secret.subarray(0, 7) }]));
});

test("folds ASCII case only for case-insensitive secrets", () => {
  const token: ByteSecret = {
    class: "M",
    label: "token",
    bytes: Buffer.from("abcdefgh2345mnop"),
    window: 12,
    caseInsensitive: true,
  };
  for (const text of ["abcdefgh2345mnop", "ABCDEFGH2345MNOP", "aBcDeFgH2345", "xxEFgh2345MnOp"]) {
    assert.equal(matches([token], Buffer.from(`name=${text};`)).length, 1, text);
  }
  assert.equal(matches([token], Buffer.from("name=abcdefgh234;")).length, 0);
  const exact = { ...token, caseInsensitive: false };
  assert.equal(matches([exact], Buffer.from("name=ABCDEFGH2345MNOP;")).length, 0);
});

test("names the first secret when two share windows", () => {
  const twin: ByteSecret = { class: "S", label: "twin", bytes: secret };
  const found = matches([k, twin], Buffer.concat([junk, secret]));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.secret.label, "key");
});

test("indexes low-entropy secrets without slowing down", () => {
  const zeros: ByteSecret = { class: "C", label: "zeros", bytes: Buffer.alloc(1024 * 1024) };
  const started = performance.now();
  const found = matches([zeros, k], Buffer.concat([junk, Buffer.alloc(100_000), secret]));
  assert.ok(performance.now() - started < 2000);
  assert.deepEqual(
    found.map((match) => match.secret.label),
    ["zeros", "key"],
  );
});

test("derives the secrets of a canary file", () => {
  const file = canaryFile(random.fork("file"), { size: 200_001 });
  const secrets = fileSecrets("file#1", file);
  const labels = secrets.map((s) => `${s.class} ${s.label}`);
  assert.deepEqual(labels, [
    "C file#1",
    "C file#1 sha256",
    "M file#1 name",
    "M file#1 type",
    "M file#1 name sha256",
    "M file#1 name sha256",
    "M file#1 size",
  ]);
  const bytesOf = (label: string) =>
    secrets.filter((s) => "bytes" in s && s.label === label).map((s) => "bytes" in s && s.bytes);
  assert.deepEqual(bytesOf("file#1 sha256"), [sha256(file.bytes)]);
  assert.deepEqual(bytesOf("file#1 name sha256"), [
    sha256(file.name.normalize("NFC")),
    sha256(file.name.normalize("NFD")),
  ]);
  assert.deepEqual(bytesOf("file#1 name"), [Buffer.from(file.token)]);
});

test("leaves out what an empty or one-chunk file cannot check", () => {
  const empty = fileSecrets("empty", canaryFile(random, { size: 0 }));
  assert.deepEqual(
    empty.map((s) => s.label),
    ["empty name", "empty type", "empty name sha256", "empty name sha256"],
  );
  const chunk = fileSecrets("chunk", canaryFile(random, { size: defaultChunkSize }));
  assert.ok(!chunk.some((s) => "size" in s));
  const small = fileSecrets("small", canaryFile(random, { size: 1000 }), { chunkSize: 1000 });
  assert.ok(!small.some((s) => "size" in s));
});

test("derives the secrets of a key given as bytes or as text", () => {
  const key = canaryKey(random);
  assert.deepEqual(keySecrets("fragment", key.bytes), [
    { class: "K", label: "fragment", bytes: key.bytes },
    { class: "K", label: "fragment sha256", bytes: sha256(key.bytes) },
  ]);
  const fromText = keySecrets("fragment", key.text, "S");
  assert.deepEqual(
    fromText.map((s) => `${s.class} ${s.label}`),
    ["S fragment text", "S fragment", "S fragment sha256"],
  );
  assert.equal(fromText[0] && "window" in fromText[0] && fromText[0].window, 20);
  const notBase64 = keySecrets("password", "correct horse battery");
  assert.deepEqual(
    notBase64.map((s) => s.label),
    ["password text", "password sha256"],
  );
});

test("matches the literal fragment secret from 20 characters", () => {
  const key = canaryKey(random);
  const needles = keySecrets("fragment", key.text);
  assert.equal(matches(needles, Buffer.from(`k=${key.text.slice(5, 25)}&`)).length, 1);
  assert.equal(matches(needles, Buffer.from(`k=${key.text.slice(5, 24)}&`)).length, 0);
});

test("matches text in NFC and NFD", () => {
  const label = `Åsa Öberg ${random.bytes(6).toString("hex")}`;
  const secrets = textSecrets("M", "recipient label", label);
  assert.equal(secrets.length, 2);
  for (const form of ["NFC", "NFD"] as const) {
    const found = matches(secrets, Buffer.from(`{"to":"${label.normalize(form)}"}`));
    assert.equal(found.length, 1, form);
  }
  assert.equal(matches(secrets, Buffer.from(label.slice(0, -1))).length, 0);
});

test("finds any 20 to 28 character base64 or base64url fragment of a 32-byte key", () => {
  const key = random.fork("b64 key").bytes(32);
  const secrets: ByteSecret[] = [{ class: "K", label: "key", bytes: key }];
  const missed: string[] = [];
  for (const encoding of ["base64", "base64url"] as const) {
    // The key alone, and after 1 and 2 other bytes, so every alignment in a stream.
    for (const shift of [0, 1, 2]) {
      const text = Buffer.concat([random.bytes(shift), key, random.bytes(5)])
        .toString(encoding)
        .replaceAll("=", "");
      // Characters that hold bits of the key only: from the first whole one to the last.
      const first = Math.ceil((8 * shift) / 6);
      const last = Math.floor((8 * (shift + key.length)) / 6);
      for (let length = 20; length <= 28; length++) {
        for (let at = first; at + length <= last; at++) {
          const fragment = text.slice(at, at + length);
          if (matches(secrets, Buffer.from(`"${fragment}"`)).length === 0) {
            missed.push(`${encoding} shift ${shift} at ${at} length ${length}`);
          }
        }
      }
    }
    // The key's own encoding, whose last character is partial, down to its final 20 characters.
    const own = key.toString(encoding).replaceAll("=", "");
    for (let length = 20; length <= 28; length++) {
      for (let at = 0; at + length <= own.length; at++) {
        if (matches(secrets, Buffer.from(own.slice(at, at + length))).length === 0) {
          missed.push(`${encoding} own at ${at} length ${length}`);
        }
      }
    }
  }
  assert.deepEqual(missed, []);
  // 19 fully determined characters are only 114 bits: not a match.
  assert.equal(matches(secrets, Buffer.from(key.toString("base64").slice(4, 23))).length, 0);
});

test("finds 12 characters of a name token in base64 at every alignment", () => {
  const file = canaryFile(random.fork("b64 token"), { size: 1000 });
  const secrets = fileSecrets("file#1", file);
  for (const encoding of ["base64", "base64url"] as const) {
    for (let start = 0; start + 12 <= file.token.length; start++) {
      for (let shift = 0; shift < 3; shift++) {
        const bytes = Buffer.concat([
          random.bytes(shift),
          Buffer.from(file.token.slice(start, start + 12)),
        ]);
        const found = matches(secrets, Buffer.from(bytes.toString(encoding).replaceAll("=", "")));
        assert.deepEqual(
          found.map((match) => match.secret.label),
          ["file#1 name"],
          `${encoding} from ${start} shift ${shift}`,
        );
      }
    }
  }
});
