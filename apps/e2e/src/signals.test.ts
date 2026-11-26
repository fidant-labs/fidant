import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { signalName, signals } from "../../infra/src/config.ts";

test("the web client's signaling list names every signaling server the infra has", () => {
  const list = JSON.parse(readFileSync(new URL("../../web/signals.json", import.meta.url), "utf8"));
  assert.deepEqual(
    list,
    signals.map(({ id }) => ({ id, url: `wss://${signalName(id)}/signal` })),
  );
});
