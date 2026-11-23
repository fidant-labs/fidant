import assert from "node:assert/strict";
import { test } from "node:test";
import { startStack } from "./index.ts";
import type { Service } from "./service.ts";

function fakeService(name: string, port: number, log: string[]): Service {
  return {
    name,
    start: async () => {
      log.push(`start ${name}`);
      return {
        name,
        url: `https://localhost:${port}`,
        port,
        stop: async () => {
          log.push(`stop ${name}`);
        },
      };
    },
  };
}

test("starts services in order and stops them in reverse", async () => {
  const log: string[] = [];
  const stack = await startStack([fakeService("server", 51234, log), fakeService("db", 5432, log)]);
  assert.equal(stack.baseURL, "https://localhost:51234");
  assert.deepEqual(stack.origins, ["https://localhost:51234", "https://localhost:5432"]);
  await stack.stop();
  assert.deepEqual(log, ["start server", "start db", "stop db", "stop server"]);
});

test("stops the running services and rethrows when one fails to start", async () => {
  const log: string[] = [];
  const failure = new Error("storage did not start");
  const failing: Service = {
    name: "storage",
    start: async () => {
      log.push("start storage");
      throw failure;
    },
  };
  await assert.rejects(startStack([fakeService("server", 51234, log), failing]), failure);
  assert.deepEqual(log, ["start server", "start storage", "stop server"]);
});

test("hands env to later services and keeps services without a url out of origins", async () => {
  let seen: Readonly<Record<string, string>> = {};
  const relay: Service = {
    name: "relay",
    start: async () => ({
      name: "relay",
      env: { TURN_URLS: "turn:127.0.0.1:3478" },
      stop: async () => {},
    }),
  };
  const web: Service = {
    name: "server",
    start: async (env) => {
      seen = { ...env };
      return { name: "server", url: "https://localhost:51234", stop: async () => {} };
    },
  };
  const stack = await startStack([relay, web]);
  assert.deepEqual(seen, { TURN_URLS: "turn:127.0.0.1:3478" });
  assert.deepEqual(stack.origins, ["https://localhost:51234"]);
  assert.deepEqual(stack.env, { TURN_URLS: "turn:127.0.0.1:3478" });
  await stack.stop();
});
