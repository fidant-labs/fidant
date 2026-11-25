import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { relaySecret } from "./relay-secret.ts";
import {
  nextState,
  parseRelays,
  type RelayState,
  readOrCreateMaster,
  relayConfig,
} from "./relays.ts";

const dir = mkdtempSync(join(tmpdir(), "sigill-relays-"));
const spki = (key: KeyObject) => key.export({ type: "spki", format: "pem" }).toString();
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = spki(rsa.publicKey);
const urls = [
  "stun:relay.test:3478",
  "turn:relay.test:3478?transport=udp",
  "turns:relay.test:443?transport=tcp",
];
const relay = (fields: Record<string, unknown> = {}) => ({
  id: "loc",
  urls,
  publicKey: pem,
  ...fields,
});
const list = (...relays: unknown[]) => JSON.stringify(relays);
const withUrls = (...relayUrls: string[]) => list(relay({ urls: relayUrls }));
const withKey = (publicKey: unknown) => list(relay({ publicKey }));

test("parses relays, each checked at its first turn: UDP URL", () => {
  const second = ["turn:198.51.100.10:3479?transport=udp", "turn:relay.test:3478?transport=udp"];
  assert.deepEqual(parseRelays(list(relay(), relay({ id: "net2", urls: second }))), [
    { id: "loc", urls, publicKey: pem, host: "relay.test", port: 3478 },
    { id: "net2", urls: second, publicKey: pem, host: "198.51.100.10", port: 3479 },
  ]);
});

test("an empty list parses to no relays", () => {
  assert.deepEqual(parseRelays("[]"), []);
});

test("on the app box the committed list is empty, so there is no relay list", () => {
  const config = relayConfig({}, true);
  assert.ok(config);
  const text = readFileSync(config.file, "utf8");
  assert.equal(text, "[]\n");
  assert.deepEqual(parseRelays(text), []);
});

const rejections: [string, string, RegExp][] = [
  ["text that is not JSON", "[", /not valid JSON/],
  ["an object instead of an array", "{}", /must be a JSON array/],
  ["an entry that is not an object", list(relay(), "loc"), /Relay 2 .* must be an object/],
  ["an extra field", list(relay({ name: "Stockholm" })), /exactly id, urls and publicKey/],
  ["a missing field", list({ id: "loc", urls }), /exactly id, urls and publicKey/],
  ["an uppercase id", list(relay({ id: "Loc" })), /Relay 1 .* id/],
  ["a one-character id", list(relay({ id: "l" })), /Relay 1 .* id/],
  ["a 17-character id", list(relay({ id: `l${"o".repeat(16)}` })), /Relay 1 .* id/],
  ["an id that starts with a digit", list(relay({ id: "1oc" })), /Relay 1 .* id/],
  ["a repeated id", list(relay(), relay({ id: "two" }), relay()), /Relay 3 .* repeats/],
  ["no URLs", withUrls(), /1 to 4 turn:, turns: or stun: URLs/],
  ["five URLs", withUrls(...urls, ...urls.slice(0, 2)), /1 to 4/],
  ["an https: URL", withUrls("https://relay.test", urls[1] ?? ""), /1 to 4/],
  ["no turn: UDP URL", withUrls(urls[0] ?? "", urls[2] ?? ""), /needs a turn:<host>/],
  [
    "an IPv6 address in the first turn: UDP URL",
    withUrls("turn:[2001:db8::1]:3478?transport=udp", urls[1] ?? ""),
    /can't be IPv6/,
  ],
  ["no port", withUrls("turn:relay.test?transport=udp"), /a host and a port/],
  ["port 0", withUrls("turn:relay.test:0?transport=udp"), /a host and a port/],
  ["port 65536", withUrls("turn:relay.test:65536?transport=udp"), /a host and a port/],
  ["a private key", withKey(rsa.privateKey.export({ type: "pkcs8", format: "pem" })), /RSA/],
  ["a PKCS#1 public key", withKey(rsa.publicKey.export({ type: "pkcs1", format: "pem" })), /RSA/],
  ["an EC key", withKey(spki(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey)), /RSA/],
  [
    "an RSA-PSS key",
    withKey(spki(generateKeyPairSync("rsa-pss", { modulusLength: 2048 }).publicKey)),
    /RSA/,
  ],
  [
    "a 1024-bit RSA key",
    withKey(spki(generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey)),
    /RSA/,
  ],
  ["a damaged key", withKey(pem.replace("MII", "AAA")), /RSA/],
  ["a key that is not a string", withKey(42), /RSA/],
];

for (const [what, text, message] of rejections) {
  test(`refuses a relay list with ${what}`, () => {
    assert.throws(() => parseRelays(text), { message });
  });
}

const boxMaster = "/var/lib/sigill/relay-master";

test("RELAYS_FILE names the list on any machine, with the master in RELAY_MASTER_FILE", () => {
  assert.deepEqual(relayConfig({ RELAYS_FILE: "/run/relays.json" }, false), {
    file: "/run/relays.json",
    masterFile: boxMaster,
  });
  const env = { RELAYS_FILE: "/run/relays.json", RELAY_MASTER_FILE: "/run/master" };
  assert.deepEqual(relayConfig(env, true), { file: "/run/relays.json", masterFile: "/run/master" });
});

test("without RELAYS_FILE the app box uses the release's committed list", () => {
  assert.deepEqual(relayConfig({}, true), {
    file: fileURLToPath(new URL("../relays.json", import.meta.url)),
    masterFile: boxMaster,
  });
});

test("without RELAYS_FILE any other machine has no relay list", () => {
  assert.equal(relayConfig({}, false), undefined);
  assert.equal(relayConfig({ RELAY_MASTER_FILE: "/run/master" }, false), undefined);
});

test("RELAYS_FILE set empty turns the relay list off, even on the app box", () => {
  assert.equal(relayConfig({ RELAYS_FILE: "" }, true), undefined);
  assert.equal(relayConfig({ RELAYS_FILE: "" }, false), undefined);
});

test("creates the relay master once, 0600, as 64 hex characters and a newline", () => {
  const file = join(dir, "created");
  const master = readOrCreateMaster(file);
  assert.match(master, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(file, "utf8"), `${master}\n`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readOrCreateMaster(file), master);
  assert.equal(readFileSync(file, "utf8"), `${master}\n`);
});

test("reuses a relay master already on disk", () => {
  const file = join(dir, "seeded");
  writeFileSync(file, `${"ab".repeat(32)}\n`);
  assert.equal(readOrCreateMaster(file), "ab".repeat(32));
  assert.equal(readFileSync(file, "utf8"), `${"ab".repeat(32)}\n`);
});

test("refuses a malformed relay master without showing its content", () => {
  const file = join(dir, "malformed");
  const contents = ["AB".repeat(32), `${"cd".repeat(31)}c`, "ef".repeat(33), `${"12".repeat(32)} `];
  for (const content of contents) {
    writeFileSync(file, `${content}\n`);
    let error: unknown;
    try {
      readOrCreateMaster(file);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.match(error.message, /relay master file must hold 64 lowercase hex characters/);
    assert.equal(inspect(error).includes(content.trim()), false);
    assert.equal(readFileSync(file, "utf8"), `${content}\n`);
  }
});

test("names the failure, not the file, when the relay master can't be created", () => {
  assert.throws(() => readOrCreateMaster(join(dir, "missing", "master")), {
    message: "Could not create the relay master file (ENOENT).",
  });
});

test("derives a relay's secret as HMAC-SHA256 of its id under the master's bytes", () => {
  // printf sto | openssl dgst -sha256 -mac HMAC -macopt hexkey:<"ab" 32 times>
  const fromOpenssl = "38fb160d081afcfaa3a6efa2f1a824855f5fb42818849688ebd9b4048db5e913";
  assert.equal(relaySecret("ab".repeat(32), "sto"), fromOpenssl);
});

test("refuses a relay master that is not 64 lowercase hex characters", () => {
  for (const bad of [
    "",
    "AB".repeat(32),
    "ab".repeat(31),
    "zz".repeat(32),
    `${"ab".repeat(32)}\n`,
  ]) {
    assert.throws(() => relaySecret(bad, "sto"), {
      name: "TypeError",
      message: "A relay master is 64 lowercase hex characters.",
    });
  }
});

test("a relay starts down, comes up on a success and goes down after two failures in a row", () => {
  let state: RelayState = { up: false, failures: 0 };
  const ups: boolean[] = [];
  for (const ok of [false, true, false, true, false, false, false, true]) {
    state = nextState(state, ok);
    ups.push(state.up);
  }
  assert.deepEqual(ups, [false, true, true, true, true, false, false, true]);
});
