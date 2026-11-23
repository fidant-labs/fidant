import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePort } from "./port.ts";

test("reads the port from the listening event", () => {
  assert.equal(parsePort('{"event":"listening","port":51234}'), 51234);
  assert.equal(parsePort('  {"port":443,"event":"listening"}\r'), 443);
});

test("reads the port from the banner", () => {
  assert.equal(parsePort("  https://localhost:8443"), 8443);
  assert.equal(parsePort("Open https://localhost:61000 and accept the warning"), 61000);
});

test("ignores other events and invalid ports", () => {
  assert.equal(parsePort('{"event":"connected","port":51234}'), undefined);
  assert.equal(parsePort('{"event":"listening","port":"51234"}'), undefined);
  assert.equal(parsePort('{"event":"listening","port":0}'), undefined);
  assert.equal(parsePort('{"event":"listening","port":70000}'), undefined);
  assert.equal(parsePort("https://localhost:99999"), undefined);
  assert.equal(parsePort("https://localhost:123456"), undefined);
});

test("ignores garbage and other hosts", () => {
  assert.equal(parsePort(""), undefined);
  assert.equal(parsePort("Sigill is running."), undefined);
  assert.equal(parsePort("  https://192.168.1.10:8443"), undefined);
  assert.equal(parsePort("http://localhost:8443"), undefined);
  assert.equal(parsePort("{not json"), undefined);
});

test("ignores partial lines", () => {
  assert.equal(parsePort('{"event":"listening","po'), undefined);
  assert.equal(parsePort('{"event":"listening","port":5'), undefined);
  assert.equal(parsePort("https://localhost:"), undefined);
  assert.equal(parsePort("https://local"), undefined);
});
