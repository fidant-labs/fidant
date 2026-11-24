import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../paths.ts";
import { coturnConfig } from "./coturn.ts";

const production = readFileSync(join(repoRoot, "apps", "infra", "box", "turnserver.conf"), "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));
const options = { port: 40000, secret: "s", stateDir: "/tmp/x" };
const differences = ["listening-port=", "realm=", "log-file="];

for (const ip of ["127.0.0.1", "198.51.100.20"]) {
  test(`the ${ip} config keeps every production line except the listed ones`, () => {
    const lines = coturnConfig({ ip, ...options }).split("\n");
    const loopbackDenials = ["denied-peer-ip=127.0.0.0-127.255.255.255", "denied-peer-ip=::1"];
    for (const line of production) {
      const expected = !(
        differences.some((key) => line.startsWith(key)) ||
        (ip === "127.0.0.1" && loopbackDenials.includes(line))
      );
      assert.equal(lines.includes(line), expected, line);
    }
    for (const key of differences) {
      assert.equal(lines.filter((line) => line.startsWith(key)).length, 1, key);
    }
    assert.ok(lines.includes("listening-port=40000"));
    assert.equal(lines.includes("allow-loopback-peers"), ip === "127.0.0.1");
  });
}
