import assert from "node:assert/strict";
import { test } from "node:test";
import { isStackHost, parseStackOrigins } from "./hosts.ts";

const stack = ["https://localhost:51234"];

test("allows the exact stack origin", () => {
  assert.equal(isStackHost("https://localhost:51234/", stack), true);
  assert.equal(isStackHost("https://localhost:51234/assets/app.js?v=1", stack), true);
});

test("treats localhost and 127.0.0.1 alike on stack ports only", () => {
  assert.equal(isStackHost("https://127.0.0.1:51234/", stack), true);
  assert.equal(isStackHost("https://127.0.0.1:51235/", stack), false);
  assert.equal(isStackHost("https://localhost:51235/", stack), false);
  assert.equal(isStackHost("https://localhost/", stack), false);
  assert.equal(isStackHost("https://localhost:51234/", ["https://127.0.0.1:51234"]), true);
});

test("compares the scheme", () => {
  assert.equal(isStackHost("http://localhost:51234/", stack), false);
  assert.equal(isStackHost("ftp://localhost:51234/", stack), false);
});

test("maps WebSocket schemes to their HTTP scheme", () => {
  assert.equal(isStackHost("wss://localhost:51234/signal", stack), true);
  assert.equal(isStackHost("wss://127.0.0.1:51234/signal", stack), true);
  assert.equal(isStackHost("ws://localhost:51234/signal", stack), false);
  assert.equal(isStackHost("ws://localhost:8080/", ["http://localhost:8080"]), true);
  assert.equal(isStackHost("wss://localhost:443/", ["https://localhost"]), true);
});

test("rejects other hosts", () => {
  assert.equal(isStackHost("https://example.com/", stack), false);
  assert.equal(isStackHost("https://example.com:51234/", stack), false);
  assert.equal(isStackHost("https://localhost.example.com:51234/", stack), false);
  assert.equal(isStackHost("https://192.168.1.10:51234/", stack), false);
  assert.equal(isStackHost("https://[::1]:51234/", stack), false);
  assert.equal(isStackHost("wss://example.com/", stack), false);
  assert.equal(isStackHost("https://localhost:51234@example.com/", stack), false);
});

test("allows URLs that stay inside the browser", () => {
  assert.equal(isStackHost("data:text/plain,hello", stack), true);
  assert.equal(
    isStackHost("blob:https://localhost:51234/0d5c4f1e-7f43-4b7a-9d3a-3c0b0c7e2f11", stack),
    true,
  );
  assert.equal(isStackHost("about:blank", stack), true);
});

test("rejects what is not a URL", () => {
  assert.equal(isStackHost("", stack), false);
  assert.equal(isStackHost("localhost:51234", stack), false);
  assert.equal(isStackHost("/relative", stack), false);
});

test("allows nothing with no stack", () => {
  assert.equal(isStackHost("https://localhost:51234/", []), false);
});

test("parses the published origin list", () => {
  assert.deepEqual(parseStackOrigins("https://localhost:51234/, http://127.0.0.1:9000"), [
    "https://localhost:51234",
    "http://127.0.0.1:9000",
  ]);
  assert.throws(() => parseStackOrigins(undefined), /SIGILL_E2E_STACK_ORIGINS/);
  assert.throws(() => parseStackOrigins(" , "), /SIGILL_E2E_STACK_ORIGINS/);
});
