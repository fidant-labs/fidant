import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readOrCreateMaster } from "./relays.ts";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const nodeVersion = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
const entrypoint = fileURLToPath(new URL("../entrypoint.sh", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sigill-image-"));
const master = randomBytes(32).toString("hex");
const { PATH } = process.env;
const printMaster = [entrypoint, process.execPath, "-p", "process.env.RELAY_MASTER ?? 'gone'"];

test("the image is .node-version's node by digest, sets no ENV and runs as node", () => {
  const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
  assert.ok(images.length > 0);
  for (const image of images) {
    assert.match(image ?? "", new RegExp(`^node:${nodeVersion}\\.[\\w.-]+@sha256:[0-9a-f]{64}$`));
  }
  assert.doesNotMatch(dockerfile, /^ENV /m);
  const last = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  assert.match(last, /^USER node$/m);
  assert.match(last, /^ARG REVISION\nLABEL org\.opencontainers\.image\.revision=\$REVISION$/m);
});

test("the entrypoint writes RELAY_MASTER to its file, 0600, and starts the command without it", () => {
  const file = join(dir, "relay-master");
  const out = execFileSync("sh", printMaster, {
    env: { PATH, RELAY_MASTER: master, RELAY_MASTER_FILE: file },
    encoding: "utf8",
  });
  assert.equal(out, "gone\n");
  assert.equal(readFileSync(file, "utf8"), `${master}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readOrCreateMaster(file), master);
});

test("the entrypoint stops without RELAY_MASTER, so the server never makes a master of its own, and without RELAY_MASTER_FILE", () => {
  const file = join(dir, "unused");
  const unset = spawnSync("sh", printMaster, {
    env: { PATH, RELAY_MASTER_FILE: file },
    encoding: "utf8",
  });
  assert.notEqual(unset.status, 0);
  assert.equal(unset.stdout, "");
  assert.match(unset.stderr, /RELAY_MASTER/);
  assert.equal(existsSync(file), false);

  const result = spawnSync("sh", printMaster, {
    env: { PATH, RELAY_MASTER: master },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /RELAY_MASTER_FILE/);
  assert.ok(!result.stderr.includes(master));
});

test("a set but empty RELAY_MASTER is written, so the server refuses it instead of making a new master", () => {
  const file = join(dir, "empty-master");
  const out = execFileSync("sh", printMaster, {
    env: { PATH, RELAY_MASTER: "", RELAY_MASTER_FILE: file },
    encoding: "utf8",
  });
  assert.equal(out, "gone\n");
  assert.equal(existsSync(file), true);
  assert.throws(() => readOrCreateMaster(file), /64 lowercase hex/);
});
