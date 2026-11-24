import assert from "node:assert/strict";
import { test } from "node:test";
import { turnCredentials } from "./turn.ts";

test("mints coturn REST credentials that expire in 5 minutes", () => {
  // printf 1700000300 | openssl dgst -sha1 -hmac test-secret -binary | base64
  const fromOpenssl = "vfUuvOythRV/eOwOeQIRXFA7Gn0=";
  assert.deepEqual(turnCredentials("test-secret", 1_700_000_000_123), {
    username: "1700000300",
    credential: fromOpenssl,
  });
});
