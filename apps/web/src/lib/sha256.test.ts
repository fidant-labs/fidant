import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { test } from "node:test";
import { Sha256 } from "./sha256.ts";

const hex = (u8: Uint8Array) => Buffer.from(u8).toString("hex");
const reference = (u8: Uint8Array) => createHash("sha256").update(u8).digest("hex");

test("matches the NIST vector for 'abc'", () => {
  const hash = new Sha256().update(new TextEncoder().encode("abc")).digest();
  assert.equal(hex(hash), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("matches node:crypto around block and padding boundaries", () => {
  for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128]) {
    const data = randomBytes(size);
    assert.equal(hex(new Sha256().update(data).digest()), reference(data), `size ${size}`);
  }
});

test("matches node:crypto on 1 MiB + 7 bytes fed in random splits", () => {
  const data = randomBytes(1024 * 1024 + 7);
  const expected = reference(data);
  assert.equal(hex(new Sha256().update(data).digest()), expected);

  for (let round = 0; round < 5; round++) {
    const hash = new Sha256();
    let offset = 0;
    while (offset < data.length) {
      // Mix tiny pieces (inside one block) with large ones (many blocks).
      const n = randomInt(2) === 0 ? randomInt(0, 70) : randomInt(1, 200_000);
      hash.update(data.subarray(offset, offset + n));
      offset += n;
    }
    assert.equal(hex(hash.digest()), expected, `round ${round}`);
  }
});

test("hashes a subarray view, not its whole buffer", () => {
  const data = randomBytes(300);
  const view = data.subarray(17, 250);
  assert.equal(hex(new Sha256().update(view).digest()), reference(view));
});

test("refuses use after digest", () => {
  const hash = new Sha256();
  hash.digest();
  assert.throws(() => hash.digest());
  assert.throws(() => hash.update(new Uint8Array(1)));
});
