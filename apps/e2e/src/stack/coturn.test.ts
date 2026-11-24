import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coturnLog, repoRoot } from "../paths.ts";
import { configLines, coturnConfig, keyOf } from "./coturn.ts";

const production = configLines(
  readFileSync(join(repoRoot, "apps", "infra", "box", "turnserver.conf"), "utf8"),
);
const options = { port: 40000, secret: "s", stateDir: "/tmp/x" };
const differences = ["listening-port", "realm", "log-file"];

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
        differences.includes(keyOf(line)) ||
        (ip === "127.0.0.1" && loopbackDenials.includes(line))
      );
      assert.equal(lines.includes(line), expected, line);
    }
    for (const key of differences) {
      assert.equal(lines.filter((line) => keyOf(line) === key).length, 1, key);
    }
    assert.equal(lines.includes("allow-loopback-peers"), ip === "127.0.0.1");
  });

  test(`the ${ip} config adds what a test run needs`, () => {
    const lines = coturnConfig({ ip, ...options }).split("\n");
    for (const line of [
      "use-auth-secret",
      "static-auth-secret=s",
      `listening-ip=${ip}`,
      `relay-ip=${ip}`,
      "listening-port=40000",
      "pidfile=/tmp/x/turnserver.pid",
      "userdb=/tmp/x/turndb",
      `log-file=${coturnLog}`,
      "verbose",
    ]) {
      assert.ok(lines.includes(line), line);
    }
  });
}
