import assert from "node:assert/strict";
import { test } from "node:test";
import { turnCredentials } from "./turn.ts";

test("mints coturn REST credentials that expire in 12 hours", () => {
  // printf 1700043200 | openssl dgst -sha1 -hmac test-secret -binary | base64
  const fromOpenssl = "Qz+aL4ylZphLpFuw9EctJOl6WhM=";
  assert.deepEqual(turnCredentials("test-secret", 1_700_000_000_123), {
    username: "1700043200",
    credential: fromOpenssl,
  });
});
