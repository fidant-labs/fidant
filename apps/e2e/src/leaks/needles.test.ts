import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  canaryFile,
  canaryKey,
  defaultChunkSize,
  SeededRandom,
  writeLargeCanary,
} from "./canary.ts";
import {
  type ByteSecret,
  buildNeedles,
  fileSecrets,
  keySecrets,
  minWindow,
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

const dir = await mkdtemp(join(tmpdir(), "needles-test-"));
after(() => rm(dir, { recursive: true, force: true }));
const rule = { piece: 4096, every: 100_000 };

test("derives the secrets of a large canary file from its samples and digest", async () => {
  const file = await writeLargeCanary(random.fork("large"), dir, { size: 300_001, rule });
  const secrets = fileSecrets("file#1", file);
  assert.deepEqual(
    secrets.map((s) => `${s.class} ${s.label}`),
    [
      "C file#1 at 0",
      "C file#1 at 100000",
      "C file#1 at 200000",
      "C file#1 at 295905",
      "C file#1 sha256",
      "M file#1 name",
      "M file#1 type",
      "M file#1 name sha256",
      "M file#1 name sha256",
      "M file#1 size",
    ],
  );
  const bytes = await readFile(file.path);
  const found = (at: number, length = 16) =>
    matches(secrets, Buffer.concat([junk, bytes.subarray(at, at + length), junk])).map(
      (match) => match.secret.label,
    );
  assert.deepEqual(found(100_050), ["file#1 at 100000"]);
  assert.deepEqual(found(295_905 + 4080), ["file#1 at 295905"]);
  assert.deepEqual(found(50_000), []);
  assert.deepEqual(
    matches(secrets, Buffer.concat([junk, sha256(bytes), junk])).map((m) => m.secret.label),
    ["file#1 sha256"],
  );
});

test("leaves out what an empty or tiny large canary cannot check", async () => {
  const empty = fileSecrets(
    "empty",
    await writeLargeCanary(random.fork("empty"), dir, { size: 0 }),
  );
  assert.deepEqual(
    empty.map((s) => s.label),
    ["empty name", "empty type", "empty name sha256", "empty name sha256"],
  );
  const tiny = await writeLargeCanary(random.fork("tiny"), dir, { size: minWindow - 1 });
  const secrets = fileSecrets("tiny", tiny);
  assert.deepEqual(
    secrets.map((s) => s.label),
    ["tiny sha256", "tiny name", "tiny type", "tiny name sha256", "tiny name sha256"],
  );
  assert.doesNotThrow(() => buildNeedles(secrets));
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
  const hashes = ["base64url", "base64", "hex"].flatMap((form) => [
    `K fragment ${form} sha256`,
    `K fragment #${form} sha256`,
  ]);
  assert.deepEqual(
    keySecrets("fragment", key.bytes).map((s) => `${s.class} ${s.label}`),
    ["K fragment", "K fragment sha256", ...hashes],
  );
  const fromText = keySecrets("fragment", key.text, "S");
  assert.deepEqual(
    fromText.map((s) => `${s.class} ${s.label}`),
    [
      "S fragment text",
      "S fragment",
      "S fragment sha256",
      "S fragment text sha256",
      "S fragment #text sha256",
      ...hashes.slice(2).map((h) => h.replace("K", "S")),
    ],
  );
  assert.equal(fromText[0] && "window" in fromText[0] && fromText[0].window, 20);
  const notBase64 = keySecrets("password", "correct horse battery");
  assert.deepEqual(
    notBase64.map((s) => s.label),
    ["password text", "password text sha256", "password #text sha256"],
  );
});

test("normalises a key in any encoding to its bytes and the hashes of its text forms", () => {
  const key = canaryKey(random.fork("encodings"));
  const forms = [
    key.bytes.toString("base64url"),
    key.bytes.toString("base64"),
    key.bytes.toString("hex"),
  ];
  const expected = [key.bytes, ...forms.flatMap((text) => [text, `#${text}`])].map((data) =>
    sha256(data).toString("hex"),
  );
  const given = {
    bytes: key.bytes,
    base64url: key.text,
    "base64 padded": key.bytes.toString("base64"),
    "base64 unpadded": key.bytes.toString("base64").replaceAll("=", ""),
    "hex lowercase": key.bytes.toString("hex"),
    "hex uppercase": key.bytes.toString("hex").toUpperCase(),
  };
  for (const [name, value] of Object.entries(given)) {
    const secrets = keySecrets("k", value).filter((s): s is ByteSecret => "bytes" in s);
    assert.ok(
      secrets.some((s) => s.label === "k" && key.bytes.equals(s.bytes)),
      `${name}: the bytes`,
    );
    const hashes = new Set(
      secrets
        .filter((s) => s.label.endsWith(" sha256"))
        .map((s) => Buffer.from(s.bytes).toString("hex")),
    );
    assert.deepEqual(
      expected.filter((h) => !hashes.has(h)),
      [],
      `${name}: the hashes`,
    );
    if (typeof value === "string") {
      assert.ok(hashes.has(sha256(`#${value}`).toString("hex")), `${name}: # and the given text`);
    }
  }
});

test("matches the SHA-256 of # and a fragment string", () => {
  const key = canaryKey(random);
  const found = matches(
    keySecrets("fragment", key.text),
    Buffer.concat([Buffer.from("/lookup/"), sha256(`#${key.text}`)]),
  );
  assert.deepEqual(
    found.map((f) => f.secret.label),
    ["fragment #text sha256"],
  );
});

test("matches the SHA-256 of a fragment string, not only of the bytes it encodes", () => {
  const key = canaryKey(random);
  const needles = keySecrets("fragment", key.text);
  const hash = sha256(Buffer.from(key.text));
  assert.deepEqual(
    matches(needles, Buffer.concat([Buffer.from("/lookup/"), hash])).map((f) => f.secret.label),
    ["fragment text sha256"],
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

test("finds 12 characters of an uppercased name token in base64 at every alignment", () => {
  const file = canaryFile(random.fork("b64 upper token"), { size: 1000 });
  const secrets = fileSecrets("file#1", file);
  const token = file.token.toUpperCase();
  for (const encoding of ["base64", "base64url"] as const) {
    for (let start = 0; start + 12 <= token.length; start++) {
      for (let shift = 0; shift < 3; shift++) {
        const bytes = Buffer.concat([
          random.bytes(shift),
          Buffer.from(token.slice(start, start + 12)),
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

test("gives only case-insensitive secrets uppercase base64 forms", () => {
  const text = "abcdefghijklmnop";
  const upper = Buffer.from(text.toUpperCase()).toString("base64");
  const exact: ByteSecret = { class: "M", label: "exact", bytes: Buffer.from(text) };
  assert.equal(matches([exact], Buffer.from(upper)).length, 0);
  assert.equal(matches([{ ...exact, caseInsensitive: true }], Buffer.from(upper)).length, 1);
});
