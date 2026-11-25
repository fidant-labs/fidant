import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  CODE_RESULTS,
  EMAIL_STATUSES,
  emailedFragment,
  isAddress,
  isLinkId,
  MAX_ADDRESS,
  MAX_FROM_LENGTH,
  MAX_ICE_SERVERS,
  MAX_ICE_STRING,
  MAX_ICE_URLS,
  MAX_LINKS,
  MAX_RELAY_DATA,
  maskAddress,
  parseClientMessage,
  parseEmailedFragment,
  parseIceServers,
  parseServerMessage,
} from "./signaling.ts";

const link = "AAAAAAAAAAAAAAAAAAAAAA";
const other = "abcdefghijklmnopqrstu-";
const attempt = "ZZZZZZZZZZZZZZZZZZZZZZ";
const token = "TTTTTTTTTTTTTTTTTTTTTT";
const mark = "MMMMMMMMMMMMMMMMMMMMMM";
const secret = "A".repeat(43);
const to = "anna@example.se";
const email = { t: "email", link, to, secret, from: "Anna", lang: "sv" };
const turn = {
  urls: ["turn:127.0.0.1:3478?transport=udp", "turns:relay.example:5349", "stun:127.0.0.1:3478"],
  username: "1700000000",
  credential: "hmac",
};

function linkIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => i.toString(36).padStart(22, "_"));
}

function client(message: object) {
  return parseClientMessage(JSON.stringify(message));
}

function server(message: object) {
  return parseServerMessage(JSON.stringify(message));
}

test("parses valid client messages", () => {
  assert.deepEqual(
    parseClientMessage(JSON.stringify({ t: "host", links: [link, other], turn: true })),
    { t: "host", links: [link, other], turn: true },
  );
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "host", links: [], turn: false })), {
    t: "host",
    links: [],
    turn: false,
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "join", link, attempt })), {
    t: "join",
    link,
    attempt,
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "relay", link, data: "a-b_C9" })), {
    t: "relay",
    link,
    data: "a-b_C9",
  });
  for (const reason of ["used", "busy", "unknown", "drop"] as const) {
    assert.deepEqual(parseClientMessage(JSON.stringify({ t: "refuse", link, attempt, reason })), {
      t: "refuse",
      link,
      attempt,
      reason,
    });
  }
  for (const path of ["direct", "stun", "relay", "failed"] as const) {
    assert.deepEqual(parseClientMessage(JSON.stringify({ t: "path", link, path })), {
      t: "path",
      link,
      path,
    });
  }
});

test("accepts the maximum number of links and relay data size", () => {
  const links = linkIds(MAX_LINKS);
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "host", links, turn: true })), {
    t: "host",
    links,
    turn: true,
  });
  const data = "A".repeat(MAX_RELAY_DATA);
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "relay", link, data })), {
    t: "relay",
    link,
    data,
  });
});

test("parses valid server messages", () => {
  assert.deepEqual(
    parseServerMessage(JSON.stringify({ t: "joined", link, attempt, iceServers: [], turn: false })),
    { t: "joined", link, attempt, iceServers: [], turn: false },
  );
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({ t: "joined", link, attempt, iceServers: [turn], turn: true }),
    ),
    { t: "joined", link, attempt, iceServers: [turn], turn: true },
  );
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "left", link })), { t: "left", link });
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "relay", link, data: "xyz" })), {
    t: "relay",
    link,
    data: "xyz",
  });
  for (const reason of ["used", "busy", "unknown", "drop"] as const) {
    assert.deepEqual(parseServerMessage(JSON.stringify({ t: "refused", reason })), {
      t: "refused",
      reason,
    });
  }
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "host-gone" })), { t: "host-gone" });
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "error", code: "bad-message" })), {
    t: "error",
    code: "bad-message",
  });
});

test("rejects input that is not a JSON object", () => {
  for (const raw of ["", "{", "not json", "null", "42", '"host"', "[]", '[{"t":"join"}]']) {
    assert.equal(parseClientMessage(raw), undefined, raw);
    assert.equal(parseServerMessage(raw), undefined, raw);
  }
});

test("rejects unknown message types", () => {
  for (const t of ["hello", "joined", "host-gone", "", 1, null]) {
    assert.equal(parseClientMessage(JSON.stringify({ t, link })), undefined, String(t));
  }
  for (const t of ["host", "join", "refuse", "path", "nope"]) {
    assert.equal(parseServerMessage(JSON.stringify({ t, link })), undefined, t);
  }
  assert.equal(parseClientMessage(JSON.stringify({ link })), undefined);
});

test("rejects bad link IDs and attempt IDs", () => {
  const bad: unknown[] = [
    "",
    "short",
    `${link}A`,
    link.slice(1),
    "AAAAAAAAAAAAAAAAAAAAA=",
    "AAAAAAAAAAAAAAAAAAAA+/",
    "AAAAAAAAAAAAAAAAAAAAA ",
    42,
    null,
    [link],
  ];
  for (const value of bad) {
    assert.equal(isLinkId(value), false, String(value));
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "join", link: value, attempt })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "join", link, attempt: value })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "relay", link: value, data: "x" })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "refuse", link: value, attempt, reason: "used" })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "refuse", link, attempt: value, reason: "used" })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "path", link: value, path: "relay" })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "host", links: [value], turn: true })),
      undefined,
    );
    assert.equal(
      parseServerMessage(
        JSON.stringify({ t: "joined", link: value, attempt, iceServers: [], turn: true }),
      ),
      undefined,
    );
    assert.equal(
      parseServerMessage(
        JSON.stringify({ t: "joined", link, attempt: value, iceServers: [], turn: true }),
      ),
      undefined,
    );
  }
});

test("rejects oversized or malformed relay data", () => {
  for (const data of ["A".repeat(MAX_RELAY_DATA + 1), "", "a+b", "ab==", "a b", 7, null]) {
    assert.equal(parseClientMessage(JSON.stringify({ t: "relay", link, data })), undefined);
    assert.equal(parseServerMessage(JSON.stringify({ t: "relay", link, data })), undefined);
  }
});

test("rejects too many, duplicate or non-array links", () => {
  for (const links of [linkIds(MAX_LINKS + 1), [link, link], link, { 0: link }]) {
    assert.equal(parseClientMessage(JSON.stringify({ t: "host", links, turn: true })), undefined);
  }
});

test("carries the relay choice in host and joined only as a boolean", () => {
  for (const value of ["false", "true", 0, 1, null, {}]) {
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "host", links: [link], turn: value })),
      undefined,
    );
    assert.equal(
      parseServerMessage(
        JSON.stringify({ t: "joined", link, attempt, iceServers: [], turn: value }),
      ),
      undefined,
    );
  }
});

test("rejects unknown refuse reasons, connection paths and error codes", () => {
  for (const reason of ["gone", "", "USED", 1, null]) {
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "refuse", link, attempt, reason })),
      undefined,
    );
    assert.equal(parseServerMessage(JSON.stringify({ t: "refused", reason })), undefined);
  }
  for (const path of ["turn", "", "RELAY", "10.0.0.1", 1, null]) {
    assert.equal(parseClientMessage(JSON.stringify({ t: "path", link, path })), undefined);
  }
  for (const code of ["", "Bad", "has space", "no-such-code", 3, null, "x".repeat(65)]) {
    assert.equal(parseServerMessage(JSON.stringify({ t: "error", code })), undefined);
  }
});

test("rejects extra fields", () => {
  const extra = { name: "report.pdf" };
  const client = [
    { t: "host", links: [link], turn: true, ...extra },
    { t: "join", link, attempt, ...extra },
    { t: "relay", link, data: "x", ...extra },
    { t: "refuse", link, attempt, reason: "used", ...extra },
    { t: "path", link, path: "relay", ...extra },
    { t: "join", link, attempt, token, ...extra },
    { ...email, ...extra },
    { t: "gate", link, ...extra },
    { t: "send-code", link, ...extra },
    { t: "code", link, code: "123456", ...extra },
    { t: "gate", link, mark, ...extra },
    { t: "send-code", link, mark, ...extra },
    { t: "code", link, code: "123456", mark, ...extra },
  ];
  for (const message of client) {
    assert.equal(parseClientMessage(JSON.stringify(message)), undefined, message.t);
  }
  const server = [
    { t: "joined", link, attempt, iceServers: [], turn: true, ...extra },
    { t: "left", link, ...extra },
    { t: "relay", link, data: "x", ...extra },
    { t: "refused", reason: "busy", ...extra },
    { t: "host-gone", ...extra },
    { t: "error", code: "bad-message", ...extra },
    { t: "hello", mail: true, ...extra },
    { t: "email", link, status: "sent", ...extra },
    { t: "email", link, status: "sent", mark, ...extra },
    { t: "gate", link, to: "", ...extra },
    { t: "code", link, result: "sent", ...extra },
    { t: "token", link, token, ...extra },
  ];
  for (const message of server) {
    assert.equal(parseServerMessage(JSON.stringify(message)), undefined, message.t);
  }
});

test("rejects missing fields", () => {
  const client = [
    { t: "host" },
    { t: "host", turn: true },
    { t: "host", links: [link] },
    { t: "join" },
    { t: "join", link },
    { t: "join", attempt },
    { t: "relay", link },
    { t: "relay", data: "x" },
    { t: "refuse", link },
    { t: "refuse", reason: "used" },
    { t: "refuse", link, reason: "used" },
    { t: "refuse", attempt, reason: "used" },
    { t: "path", link },
    { t: "path", path: "relay" },
    { t: "join", link, token },
    { t: "join", attempt, token },
    ...["link", "to", "secret", "from", "lang"].map((key) => ({ ...email, [key]: undefined })),
    { t: "gate" },
    { t: "send-code" },
    { t: "code", link },
    { t: "code", code: "123456" },
    { t: "gate", mark },
    { t: "send-code", mark },
    { t: "code", link, mark },
  ];
  for (const message of client) {
    assert.equal(parseClientMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
  }
  const server = [
    { t: "joined" },
    { t: "joined", link },
    { t: "joined", link, attempt },
    { t: "joined", link, attempt, iceServers: [] },
    { t: "joined", link, attempt, turn: true },
    { t: "left" },
    { t: "relay", link },
    { t: "refused" },
    { t: "hello" },
    { t: "email", link },
    { t: "email", status: "sent" },
    { t: "gate", link },
    { t: "gate", to: "" },
    { t: "code", link },
    { t: "code", result: "sent" },
    { t: "token", link },
    { t: "token", token },
  ];
  for (const message of server) {
    assert.equal(parseServerMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
  }
  assert.equal(parseServerMessage(JSON.stringify({ t: "error" })), undefined);
});

test("does not let __proto__ smuggle fields past the key check", () => {
  const raw = `{"t":"join","link":"${link}","attempt":"${attempt}","__proto__":{"x":1}}`;
  assert.equal(parseClientMessage(raw), undefined);
});

test("accepts the maximum number and size of ICE servers", () => {
  const url = `turn:${"a".repeat(MAX_ICE_STRING - 5)}`;
  const long = "x".repeat(MAX_ICE_STRING);
  const server = { urls: Array(MAX_ICE_URLS).fill(url), username: long, credential: long };
  const servers = Array(MAX_ICE_SERVERS).fill(server);
  assert.deepEqual(parseIceServers(servers), servers);
});

test("accepts a STUN-only server without credentials", () => {
  const stun = [{ urls: ["stun:a", "stun:[2001:db8::1]:3478"] }];
  assert.deepEqual(parseIceServers(stun), stun);
  assert.deepEqual(
    parseServerMessage(
      JSON.stringify({ t: "joined", link, attempt, iceServers: stun, turn: false }),
    ),
    { t: "joined", link, attempt, iceServers: stun, turn: false },
  );
});

test("rejects malformed or oversized ICE servers", () => {
  const bad: unknown[] = [
    null,
    {},
    turn,
    [null],
    ["turn:a"],
    Array(MAX_ICE_SERVERS + 1).fill(turn),
    [{ ...turn, urls: [] }],
    [{ ...turn, urls: "turn:a" }],
    [{ ...turn, urls: Array(MAX_ICE_URLS + 1).fill("turn:a") }],
    [{ ...turn, urls: [`turn:${"a".repeat(MAX_ICE_STRING)}`] }],
    [{ ...turn, urls: ["http://a"] }],
    [{ ...turn, urls: ["127.0.0.1:3478"] }],
    [{ ...turn, urls: [" turn:a"] }],
    [{ ...turn, urls: ["turn:a", 1] }],
    [{ ...turn, username: 1 }],
    [{ ...turn, username: "x".repeat(MAX_ICE_STRING + 1) }],
    [{ ...turn, credential: {} }],
    [{ urls: turn.urls, username: turn.username }],
    [{ ...turn, secret: "x" }],
    [{ urls: ["turn:a"] }],
    [{ urls: ["turns:a"] }],
    [{ urls: ["stun:a", "turn:b"] }],
    [{ urls: [] }],
    [{ urls: ["stun:a"], username: "u" }],
  ];
  for (const iceServers of bad) {
    assert.equal(parseIceServers(iceServers), undefined, JSON.stringify(iceServers));
    assert.equal(
      parseServerMessage(JSON.stringify({ t: "joined", link, attempt, iceServers, turn: true })),
      undefined,
    );
  }
});

test("parses valid emailed-link client messages", () => {
  assert.deepEqual(client(email), email);
  for (const lang of ["sv", "en"]) {
    const message = { ...email, from: "", lang };
    assert.deepEqual(client(message), message);
  }
  const mixed = { ...email, secret: "az09_-AZ".repeat(6).slice(0, 43) };
  assert.deepEqual(client(mixed), mixed);
  for (const marked of [{}, { mark }]) {
    for (const message of [
      { t: "gate", link, ...marked },
      { t: "send-code", link, ...marked },
      { t: "code", link, code: "012345", ...marked },
    ]) {
      assert.deepEqual(client(message), message);
    }
  }
  assert.deepEqual(client({ t: "join", link, attempt, token }), {
    t: "join",
    link,
    attempt,
    token,
  });
});

test("parses valid emailed-link server messages", () => {
  for (const mail of [true, false]) {
    assert.deepEqual(server({ t: "hello", mail }), { t: "hello", mail });
  }
  for (const status of EMAIL_STATUSES) {
    assert.deepEqual(server({ t: "email", link, status }), { t: "email", link, status });
    assert.deepEqual(server({ t: "email", link, status, mark }), {
      t: "email",
      link,
      status,
      mark,
    });
  }
  for (const masked of ["", "a***@example.se"]) {
    assert.deepEqual(server({ t: "gate", link, to: masked }), { t: "gate", link, to: masked });
  }
  for (const result of CODE_RESULTS) {
    assert.deepEqual(server({ t: "code", link, result }), { t: "code", link, result });
  }
  assert.deepEqual(server({ t: "token", link, token }), { t: "token", link, token });
});

test("accepts addresses the HTML spec accepts, up to MAX_ADDRESS characters", () => {
  const longest = `${"a".repeat(MAX_ADDRESS - "@example.se".length)}@example.se`;
  const good = ["anna@example.se", "a@b", "first.last+tag@sub.example.co.uk", "o'neil@example.se"];
  for (const address of [...good, longest]) {
    assert.equal(isAddress(address), true, address);
    assert.deepEqual(client({ ...email, to: address }), { ...email, to: address });
  }
  const bad: unknown[] = [
    `a${longest}`,
    "",
    "anna",
    "anna@",
    "@example.se",
    "anna@@example.se",
    "anna@example.se,bob@example.se",
    "<anna@example.se>",
    '"anna"@example.se',
    "anna @example.se",
    "anna@example.se\n",
    "anna@example.se\r\nBcc: bob@example.se",
    "anna@-example.se",
    "anna@example-.se",
    "anna@example..se",
    "anna@example.se.",
    `anna@${"a".repeat(64)}.se`,
    "åsa@example.se",
    "anna@exämple.se",
    42,
    null,
  ];
  for (const address of bad) {
    assert.equal(isAddress(address), false, String(address));
    assert.equal(client({ ...email, to: address }), undefined, String(address));
  }
});

test("masks an address to its first character, three stars and the domain", () => {
  assert.equal(maskAddress("anna@example.se"), "a***@example.se");
  assert.equal(maskAddress("first.last+tag@sub.example.se"), "f***@sub.example.se");
});

test("masks a one-character local part with the same three stars, hiding its length", () => {
  assert.equal(maskAddress("a@example.se"), "a***@example.se");
  assert.equal(maskAddress("a@example.se"), maskAddress("anna@example.se"));
});

test("accepts the mask of the longest address and rejects anything unmasked", () => {
  const domain = [63, 63, 63, 60].map((n) => "b".repeat(n)).join(".");
  const longest = `a@${domain}`;
  assert.equal(longest.length, MAX_ADDRESS);
  assert.equal(isAddress(longest), true);
  const masked = maskAddress(longest);
  assert.deepEqual(server({ t: "gate", link, to: masked }), { t: "gate", link, to: masked });
  const bad: unknown[] = [
    "anna@example.se",
    "***@example.se",
    "a**@example.se",
    "a****@example.se",
    "a***b@example.se",
    "a***@",
    "a***",
    "a***@example.se\n",
    `a***@b${domain}`,
    " ",
    42,
    null,
  ];
  for (const value of bad) {
    assert.equal(server({ t: "gate", link, to: value }), undefined, String(value));
  }
});

test("rejects a secret that is not 43 base64url characters, and a link URL instead", () => {
  const bad: unknown[] = [
    secret.slice(1),
    `${secret}A`,
    `${secret.slice(1)}+`,
    `${secret.slice(1)}/`,
    `${secret.slice(1)}=`,
    ` ${secret.slice(1)}`,
    `${secret.slice(1)}\n`,
    `https://fidant.se/r/${link}#${secret}`,
    "",
    42,
    null,
  ];
  for (const value of bad) {
    assert.equal(client({ ...email, secret: value }), undefined, String(value));
  }
  const url = `https://fidant.se/r/${link}#${secret}`;
  assert.equal(client({ t: "email", link, to, url, from: "Anna", lang: "sv" }), undefined);
  assert.equal(client({ ...email, url }), undefined);
});

test("accepts only the one base64url form of a 32-byte secret", () => {
  for (const last of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_") {
    const value = `${secret.slice(1)}${last}`;
    const canonical = Buffer.from(value, "base64url").toString("base64url") === value;
    assert.equal(client({ ...email, secret: value }) !== undefined, canonical, value);
  }
  for (let i = 0; i < 20; i += 1) {
    const value = randomBytes(32).toString("base64url");
    assert.deepEqual(client({ ...email, secret: value }), { ...email, secret: value });
  }
});

test("rejects bad sender names and languages in an email message", () => {
  const longest = "x".repeat(MAX_FROM_LENGTH);
  assert.deepEqual(client({ ...email, from: longest }), { ...email, from: longest });
  for (const from of [
    `${longest}x`,
    "An\nna",
    "An\u2028na",
    "An\u2029na",
    "An\u202Ena",
    "An\u061Cna",
    "\u0000",
    42,
    null,
  ]) {
    assert.equal(client({ ...email, from }), undefined, String(from));
  }
  for (const lang of ["de", "SV", "", null, ["sv"]]) {
    assert.equal(client({ ...email, lang }), undefined, String(lang));
  }
});

test("rejects codes that are not exactly six ASCII digits", () => {
  const bad = [
    "12345",
    "1234567",
    "12345a",
    " 123456",
    "123456 ",
    "١٢٣٤٥٦",
    "１２３４５６",
    "",
    123456,
  ];
  for (const code of [...bad, null]) {
    assert.equal(client({ t: "code", link, code }), undefined, String(code));
  }
});

test("treats a present but invalid join token as invalid, not as absent", () => {
  for (const value of [
    "",
    "short",
    `${token}T`,
    token.slice(1),
    "TTTTTTTTTTTTTTTTTTTTT=",
    42,
    null,
  ]) {
    assert.equal(client({ t: "join", link, attempt, token: value }), undefined, String(value));
    assert.equal(server({ t: "token", link, token: value }), undefined, String(value));
  }
});

test("treats a present but invalid mark as invalid, not as absent", () => {
  for (const value of [
    "",
    "short",
    `${mark}M`,
    mark.slice(1),
    "MMMMMMMMMMMMMMMMMMMMM=",
    42,
    null,
  ]) {
    for (const message of [
      { t: "gate", link, mark: value },
      { t: "send-code", link, mark: value },
      { t: "code", link, code: "123456", mark: value },
    ]) {
      assert.equal(client(message), undefined, `${message.t} ${value}`);
    }
    assert.equal(
      server({ t: "email", link, status: "sent", mark: value }),
      undefined,
      String(value),
    );
  }
});

test("reads back the mark and the secret of an emailed link's fragment", () => {
  const secret = randomBytes(32).toString("base64url");
  assert.equal(emailedFragment(mark, secret), `e.${mark}.${secret}`);
  assert.deepEqual(parseEmailedFragment(emailedFragment(mark, secret)), { mark, secret });
  for (const fragment of [
    secret,
    `e.${secret}`,
    `e.${mark}`,
    `e.${mark.slice(1)}.${secret}`,
    `e..${secret}`,
    `E.${mark}.${secret}`,
    `${mark}.${secret}`,
  ]) {
    assert.equal(parseEmailedFragment(fragment), undefined, fragment);
  }
});

test("rejects bad hello flags, email statuses and code results", () => {
  for (const mail of ["true", 1, null]) {
    assert.equal(server({ t: "hello", mail }), undefined, String(mail));
  }
  for (const value of ["pending", "", "SENT", null]) {
    assert.equal(server({ t: "email", link, status: value }), undefined, String(value));
    assert.equal(server({ t: "code", link, result: value }), undefined, String(value));
  }
});

test("rejects each emailed-link message in the wrong direction", () => {
  assert.equal(server(email), undefined);
  assert.equal(server({ t: "gate", link }), undefined);
  assert.equal(server({ t: "send-code", link }), undefined);
  assert.equal(server({ t: "code", link, code: "123456" }), undefined);
  assert.equal(client({ t: "hello", mail: true }), undefined);
  assert.equal(client({ t: "email", link, status: "sent" }), undefined);
  assert.equal(client({ t: "gate", link, to: "" }), undefined);
  assert.equal(client({ t: "code", link, result: "sent" }), undefined);
  assert.equal(client({ t: "token", link, token }), undefined);
});

// From the security audit of 2026-11-25, which ran this over 1.2 million mutations.
test("one mutation of a valid message never throws, and what is accepted parses to itself", () => {
  // A fixed xorshift seed, so a failure repeats.
  let seed = 12345;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  type Fields = Record<string, unknown>;
  const iceServers = [
    { urls: ["stun:a"] },
    { urls: ["turn:a", "turns:b"], username: "u", credential: "c" },
  ];
  const valid: Fields[] = [
    { t: "host", links: [link, other], turn: true },
    { t: "join", link, attempt },
    { t: "join", link, attempt, token },
    { t: "relay", link, data: "abc" },
    { t: "refuse", link, attempt, reason: "used" },
    { t: "path", link, path: "stun" },
    { t: "email", link, to, secret, from: "Anna", lang: "sv" },
    { t: "gate", link },
    { t: "gate", link, mark },
    { t: "send-code", link, mark },
    { t: "code", link, code: "123456" },
    { t: "code", link, code: "123456", mark },
    { t: "joined", link, attempt, turn: true, iceServers },
    { t: "left", link },
    { t: "refused", reason: "busy" },
    { t: "host-gone" },
    { t: "error", code: "bad-message" },
    { t: "hello", mail: true },
    { t: "email", link, status: "sent", mark },
    { t: "email", link, status: "failed" },
    { t: "gate", link, to: "a***@b.se" },
    { t: "gate", link, to: "" },
    { t: "code", link, result: "wrong" },
    { t: "token", link, token },
  ];
  for (const message of valid) {
    const raw = JSON.stringify(message);
    assert.ok(parseClientMessage(raw) ?? parseServerMessage(raw), `a seed is not valid: ${raw}`);
  }
  const junk: unknown[] = [
    null,
    true,
    0,
    -1,
    1.5,
    2 ** 53 + 2,
    "",
    "\0",
    String.fromCharCode(0xd800),
    String.fromCharCode(0x202e),
    "x".repeat(300),
    [],
    {},
    [link],
    { t: 1 },
    `${link}\n`,
    link.slice(1),
    "host",
    "joined",
    "turn:x",
    ["turn:x"],
    "a@b.se",
    "__proto__",
  ];
  const extraKeys = ["x", "mark", "token", "turn", "username", "credential", "constructor"];
  /** The value and every object or array inside it. */
  const nested = (value: unknown): Fields[] =>
    value !== null && typeof value === "object"
      ? [value as Fields, ...Object.values(value).flatMap(nested)]
      : [];
  /** One valid message with one thing changed, as JSON text. */
  const mutate = (message: Fields): string => {
    const copy = structuredClone(message);
    const key = pick(Object.keys(copy));
    const target = pick(nested(copy));
    const targetKey = pick(Object.keys(target).length > 0 ? Object.keys(target) : ["x"]);
    let extra = "";
    switch (Math.floor(random() * 7)) {
      case 0:
        target[targetKey] = pick(junk);
        break;
      case 1:
        delete target[targetKey];
        break;
      case 2:
        target[pick(extraKeys)] = pick(junk);
        break;
      case 3:
        // The same key with a value from another message type.
        copy[key] = pick(valid.filter((each) => key in each))[key];
        break;
      case 4:
        copy.t = pick(valid).t;
        break;
      case 5:
        extra = `,"__proto__":${JSON.stringify(pick(valid))}`;
        break;
      default:
        // A duplicate key.
        extra = `,${JSON.stringify(key)}:${JSON.stringify(pick(junk))}`;
    }
    return `${JSON.stringify(copy).slice(0, -1)}${extra}}`;
  };

  let accepted = 0;
  for (let i = 0; i < 20_000; i += 1) {
    const raw = mutate(pick(valid));
    for (const parse of [parseClientMessage, parseServerMessage]) {
      const message = parse(raw);
      if (message) {
        accepted += 1;
        assert.deepEqual(parse(JSON.stringify(message)), message, raw);
        assert.ok(!Object.hasOwn(message, "__proto__"), raw);
      }
    }
  }
  // Some mutations leave a valid message, so the round trip above ran on real cases.
  assert.ok(accepted > 100, `only ${accepted} mutations were accepted`);
});
