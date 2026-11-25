import assert from "node:assert/strict";
import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { relaySecret } from "./relay-secret.ts";
import {
  loadRelays,
  nextState,
  parseRelays,
  type Relay,
  type RelayState,
  readOrCreateMaster,
  relayConfig,
  startRelays,
} from "./relays.ts";
import { turnCredentials } from "./turn.ts";

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

test("the app box's committed list trusts only the Stockholm relay box's key", () => {
  const config = relayConfig({}, true);
  assert.ok(config);
  const relays = parseRelays(readFileSync(config.file, "utf8"));
  assert.deepEqual(
    relays.map(({ id, urls, host, port }) => ({ id, urls, host, port })),
    [
      {
        id: "sto",
        urls: [
          "stun:sto.relay.fidant.se:3478",
          "turn:sto.relay.fidant.se:3478?transport=udp",
          "turns:sto.relay.fidant.se:443?transport=tcp",
        ],
        host: "sto.relay.fidant.se",
        port: 3478,
      },
    ],
  );
  const key = createPublicKey(relays[0]?.publicKey ?? "");
  assert.equal(key.asymmetricKeyType, "rsa");
  assert.equal(key.asymmetricKeyDetails?.modulusLength, 3072);
  // openssl pkey -pubin -in /etc/fidant-relay/relay.pub -outform DER | sha256sum, on the relay box
  assert.equal(
    createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest("hex"),
    "ac845f931c29cd3b36a3b01700f354e765f8f4c0cd2625241100090dce6f0c26",
  );
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

test("a failed write leaves no master and no temp file, and the next start creates one", () => {
  const sub = mkdtempSync(join(dir, "failed-"));
  const file = join(sub, "master");
  const failing = (): never => {
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  assert.throws(() => readOrCreateMaster(file, failing), {
    message: "Could not create the relay master file (ENOSPC).",
  });
  assert.deepEqual(readdirSync(sub), []);
  assert.match(readOrCreateMaster(file), /^[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(sub), ["master"]);
});

test("reads an existing master in a directory that isn't writable", (t) => {
  const sub = mkdtempSync(join(dir, "readonly-"));
  const file = join(sub, "master");
  writeFileSync(file, `${"ab".repeat(32)}\n`);
  chmodSync(sub, 0o500);
  t.after(() => chmodSync(sub, 0o700));
  assert.equal(readOrCreateMaster(file), "ab".repeat(32));
  assert.deepEqual(readdirSync(sub), ["master"]);
});

test("a master published meanwhile is read, not replaced, and no temp file stays", () => {
  const sub = mkdtempSync(join(dir, "raced-"));
  const file = join(sub, "master");
  const racing = ((fd: number, data: string) => {
    writeFileSync(file, `${"cd".repeat(32)}\n`);
    return writeFileSync(fd, data);
  }) as typeof writeFileSync;
  assert.equal(readOrCreateMaster(file, racing), "cd".repeat(32));
  assert.deepEqual(readdirSync(sub), ["master"]);
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

test("on the app box the committed list replaces TURN_URLS", () => {
  const loaded = loadRelays({ TURN_URLS: "turn:turn.fidant.se:3478?transport=udp" }, true);
  assert.deepEqual(
    loaded?.relays.map(({ id }) => id),
    ["sto"],
  );
  assert.equal(loaded?.masterFile, boxMaster);
});

test("a relay list in RELAYS_FILE that isn't empty replaces TURN_URLS", () => {
  const file = join(dir, "one-relay.json");
  writeFileSync(file, list(relay()));
  assert.deepEqual(loadRelays({ RELAYS_FILE: file, RELAY_MASTER_FILE: "/run/master" }, false), {
    relays: parseRelays(list(relay())),
    masterFile: "/run/master",
  });
});

test("rolling back to an empty list, or having no list, leaves TURN_URLS in charge", () => {
  const file = join(dir, "no-relays.json");
  writeFileSync(file, "[]\n");
  const turnUrls = "turn:turn.fidant.se:3478?transport=udp";
  assert.equal(loadRelays({ RELAYS_FILE: file, TURN_URLS: turnUrls }, true), undefined);
  assert.equal(loadRelays({}, false), undefined);
});

test("a relay list that can't be read or parsed stops the start", () => {
  assert.throws(() => loadRelays({ RELAYS_FILE: join(dir, "missing.json") }, false), {
    message: "Could not read the relay list (ENOENT).",
  });
  const file = join(dir, "bad-relays.json");
  writeFileSync(file, list(relay({ id: "Loc" })));
  assert.throws(() => loadRelays({ RELAYS_FILE: file }, false), { message: /Relay 1 .* id/ });
});

const master = "ab".repeat(32);
const at = (id: string): Relay => ({
  id,
  urls: [`stun:${id}.test:3478`, `turn:${id}.test:3478?transport=udp`],
  publicKey: pem,
  host: `${id}.test`,
  port: 3478,
});
/** Lets settled checks update the relays' states. */
const settle = () => new Promise((done) => setImmediate(done));

test("offers the first relay up in list order, with credentials from its own secret", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_700_000_000_000 });
  const relays = startRelays([at("aa"), at("bb"), at("cc")], master, {
    check: async ({ id }) => id !== "aa",
  });
  t.after(relays.stop);
  await settle();
  assert.deepEqual(relays.status(), [
    { id: "aa", up: false },
    { id: "bb", up: true },
    { id: "cc", up: true },
  ]);
  assert.deepEqual(relays.ice(true), [
    { urls: at("bb").urls, ...turnCredentials(relaySecret(master, "bb"), Date.now()) },
  ]);
  assert.deepEqual(relays.ice(false), [{ urls: ["stun:bb.test:3478"] }]);
});

test("offers only the first listed relay's STUN URLs, with no credentials, when none is up", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const relays = startRelays([at("aa"), at("bb")], master, { check: async () => false });
  t.after(relays.stop);
  const stun = [{ urls: ["stun:aa.test:3478"] }];
  assert.deepEqual(relays.ice(true), stun);
  await settle();
  assert.deepEqual(relays.ice(true), stun);
  assert.deepEqual(relays.ice(false), stun);
  const none = startRelays([], master);
  t.after(none.stop);
  assert.deepEqual(none.ice(true), []);
});

test("checks every interval, and a relay goes down after two failed checks in a row", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const outcomes = [true, false, false, true];
  const relays = startRelays([at("aa"), at("bb")], master, {
    check: async ({ id }) => id === "bb" || (outcomes.shift() ?? false),
    intervalMs: 1_000,
  });
  t.after(relays.stop);
  const offered: string[] = [];
  for (let round = 0; round < 4; round += 1) {
    if (round > 0) {
      t.mock.timers.tick(1_000);
    }
    await settle();
    offered.push(relays.ice(true)[0]?.urls[0] ?? "");
  }
  assert.deepEqual(outcomes, []);
  assert.deepEqual(offered, [
    "stun:aa.test:3478",
    "stun:aa.test:3478",
    "stun:bb.test:3478",
    "stun:aa.test:3478",
  ]);
});

test("a check that throws or rejects counts as a failure", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const checks: (() => Promise<boolean>)[] = [
    async () => true,
    () => {
      throw new Error("thrown");
    },
    () => Promise.reject(new Error("rejected")),
  ];
  const relays = startRelays([at("aa")], master, {
    check: () => (checks.shift() ?? (async () => true))(),
    intervalMs: 1_000,
  });
  t.after(relays.stop);
  const ups: boolean[] = [];
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) {
      t.mock.timers.tick(1_000);
    }
    await settle();
    ups.push(relays.status()[0]?.up ?? true);
  }
  assert.deepEqual(ups, [true, true, false]);
});

test("skips a relay whose last check hasn't finished, and stop ends the checks", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const calls: Record<string, number> = { aa: 0, bb: 0 };
  let finish = () => {};
  const relays = startRelays([at("aa"), at("bb")], master, {
    check: ({ id }) => {
      calls[id] = (calls[id] ?? 0) + 1;
      return id === "aa"
        ? new Promise((done) => (finish = () => done(true)))
        : Promise.resolve(true);
    },
    intervalMs: 1_000,
  });
  t.after(relays.stop);
  for (let round = 0; round < 3; round += 1) {
    await settle();
    t.mock.timers.tick(1_000);
  }
  await settle();
  assert.deepEqual(calls, { aa: 1, bb: 4 });
  finish();
  await settle();
  t.mock.timers.tick(1_000);
  await settle();
  assert.deepEqual(calls, { aa: 2, bb: 5 });
  relays.stop();
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual(calls, { aa: 2, bb: 5 });
});

test("seals each relay's own secret to its key once, and hands out nothing for other ids", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const relays = startRelays([at("aa"), at("bb")], master, { check: async () => false });
  t.after(relays.stop);
  for (const id of ["aa", "bb"]) {
    const sealed = relays.handOut(id) ?? "";
    assert.match(sealed, /^[A-Za-z0-9+/]{342}==$/);
    const opened = privateDecrypt(
      { key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed, "base64"),
    );
    assert.equal(opened.toString(), relaySecret(master, id));
    assert.equal(relays.handOut(id), sealed);
  }
  for (const id of ["cc", "constructor", "__proto__", ""]) {
    assert.equal(relays.handOut(id), undefined, id);
  }
});
