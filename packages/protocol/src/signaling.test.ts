import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_RESULTS,
  EMAIL_STATUSES,
  isAddress,
  isLinkId,
  MAX_ADDRESS,
  MAX_EMAIL_URL,
  MAX_FROM_LENGTH,
  MAX_ICE_SERVERS,
  MAX_ICE_STRING,
  MAX_ICE_URLS,
  MAX_LINKS,
  MAX_RELAY_DATA,
  maskAddress,
  parseClientMessage,
  parseIceServers,
  parseServerMessage,
} from "./signaling.ts";

const link = "AAAAAAAAAAAAAAAAAAAAAA";
const other = "abcdefghijklmnopqrstu-";
const attempt = "ZZZZZZZZZZZZZZZZZZZZZZ";
const token = "TTTTTTTTTTTTTTTTTTTTTT";
const host = "fidant.se";
const secret = "A".repeat(43);
const url = `https://${host}/r/${link}#${secret}`;
const to = "anna@example.se";
const email = { t: "email", link, to, url, from: "Anna", lang: "sv" };
const turn = {
  urls: ["turn:127.0.0.1:3478?transport=udp", "turns:relay.example:5349", "stun:127.0.0.1:3478"],
  username: "1700000000",
  credential: "hmac",
};

function linkIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => i.toString(36).padStart(22, "_"));
}

function urlOfLength(length: number): string {
  return `https://${"h".repeat(length - url.length + host.length)}/r/${link}#${secret}`;
}

function client(message: object) {
  return parseClientMessage(JSON.stringify(message));
}

function server(message: object) {
  return parseServerMessage(JSON.stringify(message));
}

test("parses valid client messages", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "host", links: [link, other] })), {
    t: "host",
    links: [link, other],
  });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "host", links: [] })), {
    t: "host",
    links: [],
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
  for (const reason of ["used", "busy", "unknown"] as const) {
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
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "host", links })), { t: "host", links });
  const data = "A".repeat(MAX_RELAY_DATA);
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "relay", link, data })), {
    t: "relay",
    link,
    data,
  });
});

test("parses valid server messages", () => {
  assert.deepEqual(
    parseServerMessage(JSON.stringify({ t: "joined", link, attempt, iceServers: [] })),
    { t: "joined", link, attempt, iceServers: [] },
  );
  assert.deepEqual(
    parseServerMessage(JSON.stringify({ t: "joined", link, attempt, iceServers: [turn] })),
    { t: "joined", link, attempt, iceServers: [turn] },
  );
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "left", link })), { t: "left", link });
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "relay", link, data: "xyz" })), {
    t: "relay",
    link,
    data: "xyz",
  });
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "refused", reason: "busy" })), {
    t: "refused",
    reason: "busy",
  });
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
    assert.equal(parseClientMessage(JSON.stringify({ t: "host", links: [value] })), undefined);
    assert.equal(
      parseServerMessage(JSON.stringify({ t: "joined", link: value, attempt, iceServers: [] })),
      undefined,
    );
    assert.equal(
      parseServerMessage(JSON.stringify({ t: "joined", link, attempt: value, iceServers: [] })),
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
  const tooMany = linkIds(MAX_LINKS + 1);
  assert.equal(parseClientMessage(JSON.stringify({ t: "host", links: tooMany })), undefined);
  assert.equal(parseClientMessage(JSON.stringify({ t: "host", links: [link, link] })), undefined);
  assert.equal(parseClientMessage(JSON.stringify({ t: "host", links: link })), undefined);
  assert.equal(parseClientMessage(JSON.stringify({ t: "host", links: { 0: link } })), undefined);
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
    { t: "host", links: [link], ...extra },
    { t: "join", link, attempt, ...extra },
    { t: "relay", link, data: "x", ...extra },
    { t: "refuse", link, attempt, reason: "used", ...extra },
    { t: "path", link, path: "relay", ...extra },
    { t: "join", link, attempt, token, ...extra },
    { ...email, ...extra },
    { t: "gate", link, ...extra },
    { t: "send-code", link, ...extra },
    { t: "code", link, code: "123456", ...extra },
  ];
  for (const message of client) {
    assert.equal(parseClientMessage(JSON.stringify(message)), undefined, message.t);
  }
  const server = [
    { t: "joined", link, attempt, iceServers: [], ...extra },
    { t: "left", link, ...extra },
    { t: "relay", link, data: "x", ...extra },
    { t: "refused", reason: "busy", ...extra },
    { t: "host-gone", ...extra },
    { t: "error", code: "bad-message", ...extra },
    { t: "hello", mail: true, ...extra },
    { t: "email", link, status: "sent", ...extra },
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
    ...["link", "to", "url", "from", "lang"].map((key) => ({ ...email, [key]: undefined })),
    { t: "gate" },
    { t: "send-code" },
    { t: "code", link },
    { t: "code", code: "123456" },
  ];
  for (const message of client) {
    assert.equal(parseClientMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
  }
  const server = [
    { t: "joined" },
    { t: "joined", link },
    { t: "joined", link, attempt },
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
  ];
  for (const iceServers of bad) {
    assert.equal(parseIceServers(iceServers), undefined, JSON.stringify(iceServers));
    assert.equal(
      parseServerMessage(JSON.stringify({ t: "joined", link, attempt, iceServers })),
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
  for (const origin of ["192.168.1.5:8443", "localhost:8443", "[::1]:8443"]) {
    const message = { ...email, url: `https://${origin}/r/${link}#${secret}` };
    assert.deepEqual(client(message), message);
  }
  assert.deepEqual(client({ t: "gate", link }), { t: "gate", link });
  assert.deepEqual(client({ t: "send-code", link }), { t: "send-code", link });
  assert.deepEqual(client({ t: "code", link, code: "012345" }), {
    t: "code",
    link,
    code: "012345",
  });
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

test("accepts a link URL up to MAX_EMAIL_URL characters", () => {
  const longest = urlOfLength(MAX_EMAIL_URL);
  assert.equal(longest.length, MAX_EMAIL_URL);
  assert.deepEqual(client({ ...email, url: longest }), { ...email, url: longest });
  assert.equal(client({ ...email, url: urlOfLength(MAX_EMAIL_URL + 1) }), undefined);
});

test("rejects a link URL that is not https://<host>/r/<the same link>#<secret>", () => {
  const bad: unknown[] = [
    `http://${host}/r/${link}#${secret}`,
    `https://${host}/r/${other}#${secret}`,
    `https://${host}/r/${link}#${secret.slice(1)}`,
    `https://${host}/r/${link}#${secret}A`,
    `https://${host}/r/${link}#${secret.slice(1)}+`,
    `https://${host}/r/${link}`,
    `https://${host}/r/${link}/#${secret}`,
    `https://${host}/r/${link}?x=1#${secret}`,
    `https://anna@${host}/r/${link}#${secret}`,
    `https://${host}/x/r/${link}#${secret}`,
    `https://fid\nant.se/r/${link}#${secret}`,
    `https://fid ant.se/r/${link}#${secret}`,
    `https:///r/${link}#${secret}`,
    ` ${url}`,
    `${url}\n`,
    42,
    null,
  ];
  for (const value of bad) {
    assert.equal(client({ ...email, url: value }), undefined, String(value));
  }
});

test("rejects bad sender names and languages in an email message", () => {
  const longest = "x".repeat(MAX_FROM_LENGTH);
  assert.deepEqual(client({ ...email, from: longest }), { ...email, from: longest });
  for (const from of [`${longest}x`, "An\nna", "An\u202Ena", "\u0000", 42, null]) {
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
