import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { on, once } from "node:events";
import { turnCredentials } from "./turn.ts";

export type StunAttribute = [type: number, value: Buffer];

const magicCookie = 0x2112a442;
const allocate = 0x0003;
const refresh = 0x0004;
const successResponse = 0x0100;
const errorResponse = 0x0110;
const username = 0x0006;
const messageIntegrity = 0x0008;
const errorCode = 0x0009;
const lifetime = 0x000d;
const realm = 0x0014;
const nonce = 0x0015;
const xorRelayedAddress = 0x0016;
const requestedTransport = 0x0019;

function encode([type, value]: StunAttribute): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
}

/** A STUN message (RFC 8489), with MESSAGE-INTEGRITY last when `key` is given. */
export function stunMessage(
  type: number,
  transactionId: Buffer,
  attributes: StunAttribute[],
  key?: Buffer,
): Buffer {
  const body = Buffer.concat(attributes.map(encode));
  const header = Buffer.alloc(8);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length + (key ? 24 : 0), 2);
  header.writeUInt32BE(magicCookie, 4);
  const message = Buffer.concat([header, transactionId, body]);
  if (!key) {
    return message;
  }
  const hmac = createHmac("sha1", key).update(message).digest();
  return Buffer.concat([message, encode([messageIntegrity, hmac])]);
}

function attribute(message: Buffer, type: number): Buffer | undefined {
  for (let at = 20; at + 4 <= message.length; ) {
    const length = message.readUInt16BE(at + 2);
    if (message.readUInt16BE(at) === type) {
      return message.subarray(at + 4, at + 4 + length);
    }
    at += 4 + length + ((4 - (length % 4)) % 4);
  }
  return undefined;
}

function relayedIPv4(message: Buffer): string | undefined {
  const value = attribute(message, xorRelayedAddress);
  if (value?.length !== 8 || value.readUInt8(1) !== 1) {
    return undefined;
  }
  const ip = (value.readUInt32BE(4) ^ magicCookie) >>> 0;
  return [24, 16, 8, 0].map((shift) => (ip >>> shift) & 255).join(".");
}

// ponytail: no retransmit, so one lost packet fails a check; add one if relays flap.
async function exchange(socket: Socket, request: Buffer, signal: AbortSignal): Promise<Buffer> {
  const replies = on(socket, "message", { signal });
  socket.send(request);
  // ponytail: replies' MESSAGE-INTEGRITY goes unchecked; the random transaction id matches them.
  for await (const [reply] of replies) {
    if (reply.length >= 20 && reply.subarray(8, 20).equals(request.subarray(8, 20))) {
      return reply;
    }
  }
  throw new Error("The socket stopped.");
}

async function allocates(
  socket: Socket,
  host: string,
  port: number,
  secret: string,
  deadline: AbortSignal,
): Promise<boolean> {
  const expired = once(deadline, "abort").then(() => Promise.reject(deadline.reason));
  const { address } = await Promise.race([lookup(host, { family: 4 }), expired]);
  socket.connect(port, address);
  await once(socket, "connect", { signal: deadline });

  const transport: StunAttribute = [requestedTransport, Buffer.from([17, 0, 0, 0])];
  const challenge = await exchange(
    socket,
    stunMessage(allocate, randomBytes(12), [transport]),
    deadline,
  );
  const code = attribute(challenge, errorCode);
  const challengeRealm = attribute(challenge, realm);
  const challengeNonce = attribute(challenge, nonce);
  if (
    challenge.readUInt16BE(0) !== (allocate | errorResponse) ||
    code === undefined ||
    (code.readUInt8(2) & 7) * 100 + code.readUInt8(3) !== 401 ||
    challengeRealm === undefined ||
    challengeNonce === undefined
  ) {
    return false;
  }

  const credentials = turnCredentials(secret, Date.now(), "probe");
  const key = createHash("md5")
    .update(`${credentials.username}:`)
    .update(challengeRealm)
    .update(`:${credentials.credential}`)
    .digest();
  const auth: StunAttribute[] = [
    [username, Buffer.from(credentials.username)],
    [realm, challengeRealm],
    [nonce, challengeNonce],
  ];
  // ponytail: no retry on 438 (stale nonce), since the nonce is seconds old.
  const answer = await exchange(
    socket,
    stunMessage(allocate, randomBytes(12), [transport, ...auth], key),
    deadline,
  );
  if (answer.readUInt16BE(0) !== (allocate | successResponse)) {
    return false;
  }
  await exchange(
    socket,
    stunMessage(refresh, randomBytes(12), [[lifetime, Buffer.alloc(4)], ...auth], key),
    AbortSignal.any([deadline, AbortSignal.timeout(1_000)]),
  ).catch(() => undefined);
  return relayedIPv4(answer) === address;
}

// Never throws or logs: any failure is false.
export async function turnAllocates(
  host: string,
  port: number,
  secret: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const socket = createSocket("udp4");
  socket.on("error", () => undefined);
  try {
    return await allocates(socket, host, port, secret, AbortSignal.timeout(timeoutMs));
  } catch {
    return false;
  } finally {
    socket.close();
  }
}
