import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isLinkId,
  MAX_LINKS,
  MAX_RELAY_DATA,
  parseClientMessage,
  parseServerMessage,
} from "./signaling.ts";

const link = "AAAAAAAAAAAAAAAAAAAAAA";
const other = "abcdefghijklmnopqrstu-";

function linkIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => i.toString(36).padStart(22, "_"));
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
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "join", link })), { t: "join", link });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "relay", link, data: "a-b_C9" })), {
    t: "relay",
    link,
    data: "a-b_C9",
  });
  for (const reason of ["used", "busy", "unknown"] as const) {
    assert.deepEqual(parseClientMessage(JSON.stringify({ t: "refuse", link, reason })), {
      t: "refuse",
      link,
      reason,
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
  assert.deepEqual(parseServerMessage(JSON.stringify({ t: "joined", link })), {
    t: "joined",
    link,
  });
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
  for (const t of ["host", "join", "refuse", "nope"]) {
    assert.equal(parseServerMessage(JSON.stringify({ t, link })), undefined, t);
  }
  assert.equal(parseClientMessage(JSON.stringify({ link })), undefined);
});

test("rejects bad link IDs", () => {
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
    assert.equal(parseClientMessage(JSON.stringify({ t: "join", link: value })), undefined);
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "relay", link: value, data: "x" })),
      undefined,
    );
    assert.equal(
      parseClientMessage(JSON.stringify({ t: "refuse", link: value, reason: "used" })),
      undefined,
    );
    assert.equal(parseClientMessage(JSON.stringify({ t: "host", links: [value] })), undefined);
    assert.equal(parseServerMessage(JSON.stringify({ t: "joined", link: value })), undefined);
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

test("rejects unknown refuse reasons and error codes", () => {
  for (const reason of ["gone", "", "USED", 1, null]) {
    assert.equal(parseClientMessage(JSON.stringify({ t: "refuse", link, reason })), undefined);
    assert.equal(parseServerMessage(JSON.stringify({ t: "refused", reason })), undefined);
  }
  for (const code of ["", "Bad", "has space", 3, null, "x".repeat(65)]) {
    assert.equal(parseServerMessage(JSON.stringify({ t: "error", code })), undefined);
  }
});

test("rejects extra fields", () => {
  const extra = { name: "report.pdf" };
  const client = [
    { t: "host", links: [link], ...extra },
    { t: "join", link, ...extra },
    { t: "relay", link, data: "x", ...extra },
    { t: "refuse", link, reason: "used", ...extra },
  ];
  for (const message of client) {
    assert.equal(parseClientMessage(JSON.stringify(message)), undefined, message.t);
  }
  const server = [
    { t: "joined", link, ...extra },
    { t: "left", link, ...extra },
    { t: "relay", link, data: "x", ...extra },
    { t: "refused", reason: "busy", ...extra },
    { t: "host-gone", ...extra },
    { t: "error", code: "x", ...extra },
  ];
  for (const message of server) {
    assert.equal(parseServerMessage(JSON.stringify(message)), undefined, message.t);
  }
});

test("rejects missing fields", () => {
  const client = [
    { t: "host" },
    { t: "join" },
    { t: "relay", link },
    { t: "relay", data: "x" },
    { t: "refuse", link },
    { t: "refuse", reason: "used" },
  ];
  for (const message of client) {
    assert.equal(parseClientMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
  }
  const server = [{ t: "joined" }, { t: "left" }, { t: "relay", link }, { t: "refused" }];
  for (const message of server) {
    assert.equal(parseServerMessage(JSON.stringify(message)), undefined, JSON.stringify(message));
  }
  assert.equal(parseServerMessage(JSON.stringify({ t: "error" })), undefined);
});

test("does not let __proto__ smuggle fields past the key check", () => {
  const raw = `{"t":"join","link":"${link}","__proto__":{"x":1}}`;
  assert.equal(parseClientMessage(raw), undefined);
});
