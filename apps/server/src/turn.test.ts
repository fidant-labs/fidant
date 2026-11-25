import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseIceServers } from "@sigill/protocol";
import { iceServersFor, turnCredentials } from "./turn.ts";

const userData = readFileSync(new URL("../../infra/box/user-data.sh", import.meta.url), "utf8");
const [, staticUrls = ""] = userData.match(/^turn_urls="([^"]*)"$/m) ?? [];
const ipv6Stun = "stun:[2a05:d016:1f3:8a00:1234:5678:9abc:def0]:3478";
/** The app box's TURN_URLS, with the IPv6 STUN address it appends when it has one. */
const boxUrls = [...staticUrls.replaceAll("@DOMAIN@", "fidant.se").split(","), ipv6Stun];

test("mints coturn REST credentials that expire in 5 minutes", () => {
  // printf 1700000300 | openssl dgst -sha1 -hmac test-secret -binary | base64
  const fromOpenssl = "vfUuvOythRV/eOwOeQIRXFA7Gn0=";
  assert.deepEqual(turnCredentials("test-secret", 1_700_000_000_123), {
    username: "1700000300",
    credential: fromOpenssl,
  });
});

test("adds a label to the username, which coturn checks with the rest of it", () => {
  // printf 1700000300:probe | openssl dgst -sha1 -hmac test-secret -binary | base64
  const fromOpenssl = "ubv0JVKpypWCxEDBRu/bsN7A+10=";
  assert.deepEqual(turnCredentials("test-secret", 1_700_000_000_123, "probe"), {
    username: "1700000300:probe",
    credential: fromOpenssl,
  });
});

test("the app box's TURN_URLS, with its IPv6 STUN address, pass the startup check", () => {
  assert.equal(boxUrls.length, 4);
  assert.ok(parseIceServers([{ urls: boxUrls, username: "", credential: "" }]));
});

test("hands the app box's TURN URLs with fresh credentials when the sender allows it", () => {
  const ice = { urls: boxUrls, secret: "test-secret" };
  assert.deepEqual(iceServersFor(ice, 1_700_000_000_123, true), [
    { urls: boxUrls, ...turnCredentials("test-secret", 1_700_000_000_123) },
  ]);
});

test("hands only the app box's STUN URLs, with no credentials, when the sender refuses TURN", () => {
  const servers = iceServersFor({ urls: boxUrls, secret: "test-secret" }, 0, false);
  assert.deepEqual(servers, [{ urls: ["stun:turn.fidant.se:3478", ipv6Stun] }]);
  assert.deepEqual(parseIceServers(JSON.parse(JSON.stringify(servers))), servers);
});

test("hands no ICE servers when the sender refuses TURN and there is no STUN URL", () => {
  const ice = { urls: ["turn:a:3478?transport=udp", "turns:a:5349"], secret: "test-secret" };
  assert.deepEqual(iceServersFor(ice, 0, false), []);
});
