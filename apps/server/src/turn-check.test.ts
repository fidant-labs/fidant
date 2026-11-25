import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stunMessage, turnAllocates } from "./turn-check.ts";

const rejections: unknown[] = [];
process.on("unhandledRejection", (reason) => rejections.push(reason));
after(async () => {
  await delay(500);
  assert.deepEqual(rejections, []);
});

test("stunMessage builds RFC 5769's sample request with long-term authentication", () => {
  // RFC 5769 section 2.4; its one erratum (4776) is about SOFTWARE in sections 2.1 to 2.3.
  const fromRfc = Buffer.from(
    "000100602112a44278ad3433c6ad72c029da412e00060012e3839ee38388e383aae38383e382afe382b900000015001c662f2f3439396b39353464364f4c33346f4c394653547679363473410014000b6578616d706c652e6f72670000080014f67024656dd64a3e02b8e0712e85c9a28ca89666",
    "hex",
  );
  const username = "マトリックス";
  const key = createHash("md5").update(`${username}:example.org:TheMatrIX`).digest();
  const message = stunMessage(
    0x0001,
    fromRfc.subarray(8, 20),
    [
      [0x0006, Buffer.from(username)],
      [0x0015, Buffer.from("f//499k954d6OL34oL9FSTvy64sA")],
      [0x0014, Buffer.from("example.org")],
    ],
    key,
  );
  assert.equal(message.toString("hex"), fromRfc.toString("hex"));
});

const realm = "fidant.se";
const nonce = "0123456789abcdef";

function attributes(message: Buffer): Map<number, Buffer> {
  const found = new Map<number, Buffer>();
  for (
    let at = 20;
    at < message.length;
    at += 4 + Math.ceil(message.readUInt16BE(at + 2) / 4) * 4
  ) {
    const length = message.readUInt16BE(at + 2);
    found.set(message.readUInt16BE(at), message.subarray(at + 4, at + 4 + length));
  }
  return found;
}

/** Checks MESSAGE-INTEGRITY, as the last attribute, the way coturn does with --use-auth-secret. */
function signedFor(secret: string, request: Buffer): boolean {
  const username = attributes(request).get(0x0006)?.toString() ?? "";
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  const key = createHash("md5").update(`${username}:${realm}:${credential}`).digest();
  const at = request.length - 24;
  return (
    at >= 20 &&
    request.readUInt16BE(at) === 0x0008 &&
    createHmac("sha1", key)
      .update(request.subarray(0, at))
      .digest()
      .equals(request.subarray(at + 4))
  );
}

function xorAddress(ip: string): Buffer {
  const value = Buffer.alloc(8);
  value.writeUInt8(1, 1);
  value.writeUInt16BE(50_000 ^ 0x2112, 2);
  value.writeUInt32BE(
    (Buffer.from(ip.split(".").map(Number)).readUInt32BE(0) ^ 0x2112a442) >>> 0,
    4,
  );
  return value;
}

/** A TURN server on loopback that allocates `relayedIp` to requests signed with `secret`. */
async function fakeRelay(
  secret: string,
  relayedIp: string,
  { silent = false, challenge = 401 } = {},
) {
  const server = createSocket("udp4");
  const requests: Buffer[] = [];
  server.on("message", (request, from) => {
    requests.push(request);
    const id = request.subarray(8, 20);
    const type = request.readUInt16BE(0);
    const reply = !signedFor(secret, request)
      ? stunMessage(0x0110 | type, id, [
          [0x0009, Buffer.from([0, 0, Math.floor(challenge / 100), challenge % 100])],
          [0x0014, Buffer.from(realm)],
          [0x0015, Buffer.from(nonce)],
        ])
      : type === 0x0003
        ? stunMessage(0x0103, id, [[0x0016, xorAddress(relayedIp)]])
        : stunMessage(0x0104, id, []);
    if (!silent) {
      server.send(reply, from.port, from.address);
    }
  });
  server.bind(0, "127.0.0.1");
  await once(server, "listening");
  return { port: server.address().port, requests, close: () => server.close() };
}

test("allocates on a relay with probe credentials and then releases the allocation", async (t) => {
  const relay = await fakeRelay("relay-secret", "127.0.0.1");
  t.after(relay.close);
  assert.equal(await turnAllocates("127.0.0.1", relay.port, "relay-secret"), true);

  const [challenge, allocate, release, ...rest] = relay.requests.map(attributes);
  assert.deepEqual(
    relay.requests.map((request) => request.readUInt16BE(0)),
    [0x0003, 0x0003, 0x0004],
  );
  assert.deepEqual(rest, []);
  assert.deepEqual([...(challenge?.keys() ?? [])], [0x0019]);
  assert.deepEqual(challenge?.get(0x0019), Buffer.from([17, 0, 0, 0]));

  assert.deepEqual(allocate?.get(0x0019), Buffer.from([17, 0, 0, 0]));
  const [, expiry] =
    allocate
      ?.get(0x0006)
      ?.toString()
      .match(/^(\d+):probe$/) ?? [];
  assert.ok(Math.abs(Number(expiry) - (Date.now() / 1000 + 300)) < 10, `expiry ${expiry}`);
  assert.equal(allocate?.get(0x0014)?.toString(), realm);
  assert.equal(allocate?.get(0x0015)?.toString(), nonce);
  assert.ok(signedFor("relay-secret", relay.requests[1] ?? Buffer.alloc(0)));

  assert.deepEqual(release?.get(0x000d), Buffer.alloc(4));
  assert.ok(signedFor("relay-secret", relay.requests[2] ?? Buffer.alloc(0)));
});

test("fails when the relay answers 401 twice", async (t) => {
  const relay = await fakeRelay("another-secret", "127.0.0.1");
  t.after(relay.close);
  assert.equal(await turnAllocates("127.0.0.1", relay.port, "relay-secret", 300), false);
  assert.equal(relay.requests.length, 2);
});

test("fails when the relay's first answer is not a 401", async (t) => {
  const relay = await fakeRelay("relay-secret", "127.0.0.1", { challenge: 400 });
  t.after(relay.close);
  assert.equal(await turnAllocates("127.0.0.1", relay.port, "relay-secret", 300), false);
  assert.equal(relay.requests.length, 1);
});

test("fails when the relayed address is not the relay's, and still releases it", async (t) => {
  const relay = await fakeRelay("relay-secret", "192.0.2.1");
  t.after(relay.close);
  assert.equal(await turnAllocates("127.0.0.1", relay.port, "relay-secret", 300), false);
  assert.equal(relay.requests.at(-1)?.readUInt16BE(0), 0x0004);
});

test("fails when the relay never answers", async (t) => {
  const relay = await fakeRelay("relay-secret", "127.0.0.1", { silent: true });
  t.after(relay.close);
  const started = Date.now();
  assert.equal(await turnAllocates("127.0.0.1", relay.port, "relay-secret", 300), false);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(relay.requests.length, 1);
});

test("fails when the relay's name does not resolve", async () => {
  assert.equal(await turnAllocates("relay.invalid", 3478, "relay-secret", 300), false);
});
