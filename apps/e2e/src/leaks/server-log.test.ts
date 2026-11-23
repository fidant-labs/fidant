import assert from "node:assert/strict";
import { test } from "node:test";
import { ERROR_CODES, REFUSE_REASONS, UPGRADE_REJECT_REASONS } from "@sigill/protocol";
import { canaryKey, SeededRandom } from "./canary.ts";
import {
  checkServerLog,
  formatLogViolation,
  type LogRule,
  serverLogAllowlist,
} from "./server-log.ts";

const random = SeededRandom.fromLabel("server log test");

/** The rules each line breaks, in order. */
function rules(...lines: string[]): LogRule[] {
  return checkServerLog(lines, serverLogAllowlist).map((violation) => violation.rule);
}

const line = (fields: Record<string, unknown>) => JSON.stringify(fields);

test("passes the lines the server writes", () => {
  const lines = [
    line({ event: "listening", port: 8443 }),
    line({ event: "upgrade-rejected", reason: "origin" }),
    line({ event: "host", links: 3 }),
    line({ event: "joined", link: "aZ09_-" }),
    line({ event: "refused", link: "abcdef", reason: "busy" }),
    line({ event: "relay", link: "abcdef", bytes: 0 }),
    line({ event: "error", code: "not-on-link" }),
    "",
    "   ",
  ];
  assert.deepEqual(checkServerLog(lines, serverLogAllowlist), []);
});

test("passes every reason and code that @sigill/protocol defines", () => {
  const lines = [
    ...[...REFUSE_REASONS, ...UPGRADE_REJECT_REASONS].map((reason) =>
      line({ event: "refused", reason }),
    ),
    ...ERROR_CODES.map((code) => line({ event: "error", code })),
  ];
  assert.deepEqual(checkServerLog(lines, serverLogAllowlist), []);
});

test("fails text that is not JSON", () => {
  assert.deepEqual(rules("listening on https://localhost:8443"), ["json"]);
  assert.deepEqual(rules(`${line({ event: "host" })} trailing`), ["json"]);
});

test("fails JSON that is not one object", () => {
  assert.deepEqual(rules("[]", '"listening"', "42", "null"), [
    "object",
    "object",
    "object",
    "object",
  ]);
});

test("fails an unknown key", () => {
  assert.deepEqual(rules(line({ event: "host", name: "report.pdf" })), ["key"]);
});

test("fails a missing or unknown event", () => {
  assert.deepEqual(rules(line({ link: "abcdef" }), line({ event: "upload" })), ["event", "event"]);
  assert.deepEqual(rules(line({ event: 1 })), ["event"]);
});

test("fails a link that is not a 6-character prefix", () => {
  assert.deepEqual(rules(line({ event: "joined", link: "abcdefg" })), ["link"]);
  assert.deepEqual(rules(line({ event: "joined", link: "abc.ef" })), ["link"]);
  assert.deepEqual(rules(line({ event: "joined", link: 123456 })), ["link"]);
});

test("catches a key in the link field", () => {
  const key = canaryKey(random.fork("key"));
  assert.deepEqual(rules(line({ event: "joined", link: key.text })), ["link"]);
});

test("fails counts that are not non-negative integers", () => {
  assert.deepEqual(
    rules(
      line({ event: "host", links: -1 }),
      line({ event: "relay", bytes: 1.5 }),
      line({ event: "relay", bytes: "100" }),
      line({ event: "listening", port: 2 ** 60 }),
    ),
    ["links", "bytes", "bytes", "port"],
  );
});

test("fails an unknown reason or code", () => {
  assert.deepEqual(rules(line({ event: "refused", reason: "full" })), ["reason"]);
  assert.deepEqual(rules(line({ event: "error", code: "oops" })), ["code"]);
  assert.deepEqual(rules(line({ event: "error", code: null })), ["code"]);
});

test("reports every broken rule with its line number", () => {
  const violations = checkServerLog(
    [line({ event: "host" }), "", line({ event: "nope", extra: 1 })],
    serverLogAllowlist,
  );
  assert.deepEqual(
    violations.map((v) => [v.line, v.rule]),
    [
      [3, "key"],
      [3, "event"],
    ],
  );
  const [first] = violations;
  assert.ok(first);
  assert.match(formatLogViolation(first), /^line 3: key: unknown key "extra": \{/);
});

test("cuts long excerpts", () => {
  const long = `not json ${"x".repeat(500)}`;
  const [violation] = checkServerLog([long], serverLogAllowlist);
  assert.equal(violation?.excerpt, `${long.slice(0, 120)}…`);
});
