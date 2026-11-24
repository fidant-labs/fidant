import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLinkId,
  MAX_ICE_SERVERS,
  MAX_ICE_STRING,
  MAX_ICE_URLS,
  MAX_LINKS,
  MAX_RELAY_DATA,
  parseClientMessage,
  parseIceServers,
  parseServerMessage,
} from "./signaling.ts";

const link = "AAAAAAAAAAAAAAAAAAAAAA";
const other = "abcdefghijklmnopqrstu-";
const attempt = "ZZZZZZZZZZZZZZZZZZZZZZ";
const turn = {
  urls: ["turn:127.0.0.1:3478?transport=udp", "turns:relay.example:5349", "stun:127.0.0.1:3478"],
  username: "1700000000",
  credential: "hmac",
};

function linkIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => i.toString(36).padStart(22, "_"));
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
