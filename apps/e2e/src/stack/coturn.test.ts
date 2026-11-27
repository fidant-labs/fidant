import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coturnLog, repoRoot } from "../paths.ts";
import { configLines, coturnConfig, keyOf, waitForStun } from "./coturn.ts";
import { freePort, udpFree } from "./server.ts";

const production = configLines(
  readFileSync(join(repoRoot, "apps", "infra", "box", "turnserver.conf"), "utf8"),
);
const options = { port: 40000, secret: "s", stateDir: "/tmp/x" };
const differences = ["listening-port", "realm", "log-file"];
const tlsKeys = ["tls-listening-port", "cert", "pkey"];

test("configLines trims, and drops blank lines and comments, indented ones too", () => {
  assert.deepEqual(configLines("a=1\n\n  # note\n  b = 2  \n\t\nverbose\n"), [
    "a=1",
    "b = 2",
    "verbose",
  ]);
});

test("keyOf reads the key however the value is written", () => {
  for (const line of ["realm=x", "realm = x", "realm x", "realm"]) {
    assert.equal(keyOf(line), "realm", line);
  }
});

for (const ip of ["127.0.0.1", "198.51.100.20"]) {
  test(`the ${ip} config keeps every production line except the listed ones`, () => {
    const lines = coturnConfig({ ip, ...options }).split("\n");
    const loopbackDenials = ["denied-peer-ip=127.0.0.0-127.255.255.255", "denied-peer-ip=::1"];
    for (const line of production) {
      const expected = !(
        [...differences, ...tlsKeys].includes(keyOf(line)) ||
        (ip === "127.0.0.1" && loopbackDenials.includes(line))
      );
      assert.equal(lines.includes(line), expected, line);
    }
    for (const key of differences) {
      assert.equal(lines.filter((line) => keyOf(line) === key).length, 1, key);
    }
    assert.equal(lines.includes("allow-loopback-peers"), ip === "127.0.0.1");
    assert.ok(lines.includes("no-tls"));
    assert.ok(lines.every((line) => !tlsKeys.includes(keyOf(line))));
  });

  test(`the ${ip} config adds what a test run needs`, () => {
    const lines = coturnConfig({ ip, ...options }).split("\n");
    for (const line of [
      "use-auth-secret",
      "static-auth-secret=s",
      `listening-ip=${ip}`,
      `relay-ip=${ip}`,
      "listening-port=40000",
      "realm=sigill.local",
      "pidfile=/tmp/x/turnserver.pid",
      "userdb=/tmp/x/turndb",
      `log-file=${coturnLog}`,
      "verbose",
    ]) {
      assert.ok(lines.includes(line), line);
    }
  });
}

test("the TLS option replaces production's TLS listener and certificate", () => {
  const tls = { port: 443, cert: "/etc/sigill/turn.crt", pkey: "/etc/sigill/turn.key" };
  const lines = coturnConfig({ ip: "198.51.100.20", ...options, tls }).split("\n");
  assert.ok(!lines.includes("no-tls"));
  assert.deepEqual(
    lines.filter((line) => tlsKeys.includes(keyOf(line))),
    ["tls-listening-port=443", "cert=/etc/sigill/turn.crt", "pkey=/etc/sigill/turn.key"],
  );
});

/** A loopback UDP socket on a free port that handles each datagram with `reply`. */
async function udpSocket(reply: (message: Buffer) => Buffer | undefined = () => undefined) {
  const socket = createSocket("udp4");
  const port = await freePort();
  socket.on("message", (message, from) => {
    const answer = reply(message);
    if (answer) {
      socket.send(answer, from.port, from.address);
    }
  });
  await new Promise<void>((resolve) => socket.bind(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise<void>((resolve) => socket.close(() => resolve())) };
}

test("udpFree is false only while a socket holds the port", async () => {
  const held = await udpSocket();
  assert.equal(await udpFree(held.port), false);
  await held.close();
  assert.equal(await udpFree(held.port), true);
});

test("waitForStun returns once the port answers a binding request", async () => {
  // A binding success response: the request with its type changed.
  const server = await udpSocket((message) =>
    Buffer.concat([Buffer.from("0101", "hex"), message.subarray(2)]),
  );
  await waitForStun(server.port, () => false, "coturn", 2000);
  await server.close();
});

test("waitForStun fails when the port holder is no STUN server, or the service exited", async () => {
  const other = await udpSocket((message) => Buffer.from(message).fill(0));
  await assert.rejects(
    waitForStun(other.port, () => false, "coturn", 300),
    /coturn did not answer STUN on UDP port \d+ within 300 ms/,
  );
  await assert.rejects(
    waitForStun(other.port, () => true, "coturn", 300),
    /coturn exited before answering/,
  );
  await other.close();
});
