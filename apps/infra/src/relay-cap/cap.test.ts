import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CapConfig,
  type CapDeps,
  configFromEnv,
  decide,
  metricLine,
  monthOf,
  monthStart,
  type Port,
  parseState,
  parseStatus,
  readStatus,
  runCap,
  runOnce,
  statusLines,
} from "./cap.mts";

const limit = 1_800_000_000_000;

const t = (out: number, inbound = 0) => ({ in: inbound, out });

test("a fresh month under the limit leaves the ports alone", () => {
  assert.deepEqual(decide(undefined, "2026-11", { a: t(5) }, limit), {
    state: { month: "2026-11", boxes: { a: t(5) }, capped: false },
    total: 5,
    ports: "keep",
  });
});

test("each box's in and out never go down within a month", () => {
  const previous = { month: "2026-11", boxes: { a: { in: 100, out: 10 } }, capped: false };
  assert.deepEqual(decide(previous, "2026-11", { a: { in: 50, out: 20 } }, limit).state.boxes.a, {
    in: 100,
    out: 20,
  });
});

test("a replaced box's traffic still counts toward the month", () => {
  const previous = { month: "2026-11", boxes: { old: t(1_000_000_000_000) }, capped: false };
  const result = decide(previous, "2026-11", { new: t(900_000_000_000) }, limit);
  assert.equal(result.total, 1_900_000_000_000);
  assert.equal(result.ports, "capped");
  assert.deepEqual(result.state.boxes, { old: t(1_000_000_000_000), new: t(900_000_000_000) });
});

test("reaching the limit caps the relay ports, and every later run caps them again", () => {
  const first = decide(undefined, "2026-11", { a: { in: limit / 2, out: limit / 2 } }, limit);
  assert.equal(first.ports, "capped");
  assert.equal(decide(first.state, "2026-11", { a: t(0) }, limit).ports, "capped");
});

test("a new month reopens ports the cap closed", () => {
  const previous = { month: "2026-11", boxes: { a: t(limit) }, capped: true };
  const result = decide(previous, "2026-12", { a: t(0) }, limit);
  assert.equal(result.ports, "open");
  assert.deepEqual(result.state, { month: "2026-12", boxes: { a: t(0) }, capped: false });
});

test("a raised limit reopens the ports within the month", () => {
  const previous = { month: "2026-11", boxes: { a: t(limit) }, capped: true };
  assert.equal(decide(previous, "2026-11", { a: t(limit) }, 2 * limit).ports, "open");
});

test("under the limit, ports the cap didn't close are never touched", () => {
  const previous = { month: "2026-11", boxes: { a: t(1) }, capped: false };
  assert.equal(decide(previous, "2026-11", { a: t(2) }, limit).ports, "keep");
});

test("every box's traffic counts toward one total, and each box keeps its own maximum", () => {
  const previous = { month: "2026-11", boxes: { a: t(100), b: t(200) }, capped: false };
  const result = decide(previous, "2026-11", { a: t(50), b: { in: 100, out: 200 } }, limit);
  assert.deepEqual(result.state.boxes, { a: t(100), b: { in: 100, out: 200 } });
  assert.equal(result.total, 400);
  assert.equal(decide(previous, "2026-11", { a: t(limit - 200), b: t(0) }, limit).ports, "capped");
});

test("a state capped by hand under the limit reopens the ports", () => {
  const previous = { month: "2026-11", boxes: { a: t(1), b: t(2) }, capped: true };
  const result = decide(previous, "2026-11", { a: t(1), b: t(2) }, limit);
  assert.equal(result.ports, "open");
  assert.equal(result.state.capped, false);
});

test("a state from before in and out were kept apart is read and migrated", () => {
  const old = parseState('{"month":"2026-11","boxes":{"a":7,"b":{"in":1,"out":2}},"capped":false}');
  assert.deepEqual(old?.boxes, { a: 7, b: { in: 1, out: 2 } });
  assert.deepEqual(parseState('{"month":"2026-11","boxes":{"a":{"in":1,"out":2}},"capped":true}'), {
    month: "2026-11",
    boxes: { a: { in: 1, out: 2 } },
    capped: true,
  });
});

test("a fresh read replaces an old number, even a smaller one", () => {
  const previous = { month: "2026-11", boxes: { a: 900 }, capped: false };
  const result = decide(previous, "2026-11", { a: { in: 100, out: 200 } }, limit);
  assert.deepEqual(result.state.boxes, { a: { in: 100, out: 200 } });
  assert.equal(result.total, 300);
});

test("an old number for a box not in this run is kept as outbound", () => {
  const previous = { month: "2026-11", boxes: { gone: 900, a: 5 }, capped: false };
  const result = decide(previous, "2026-11", { a: { in: 1, out: 2 } }, limit);
  assert.deepEqual(result.state.boxes, { gone: { in: 0, out: 900 }, a: { in: 1, out: 2 } });
  assert.equal(result.total, 903);
});

test("an old state from an earlier month is dropped", () => {
  const previous = { month: "2026-10", boxes: { a: limit }, capped: true };
  const result = decide(previous, "2026-11", { a: t(1) }, limit);
  assert.deepEqual(result.state.boxes, { a: t(1) });
  assert.equal(result.ports, "open");
});

test("months roll over in UTC", () => {
  assert.equal(monthOf(new Date("2026-11-30T23:59:59Z")), "2026-11");
  assert.equal(monthOf(new Date("2026-12-01T00:00:00Z")), "2026-12");
  assert.equal(
    monthStart(new Date("2026-12-15T10:00:00+05:00")).toISOString(),
    "2026-12-01T00:00:00.000Z",
  );
});

test("a malformed state throws instead of starting over", () => {
  assert.equal(parseState(undefined), undefined);
  assert.throws(() => parseState("{"));
  assert.throws(() => parseState('{"month":"2026-11"}'));
  assert.throws(() => parseState('{"month":"2026-11","boxes":{"a":"1"},"capped":false}'));
  for (const bad of [
    "-1",
    '{"in":1}',
    '{"in":1,"out":2,"x":3}',
    '{"in":"1","out":2}',
    '{"in":-1,"out":2}',
    '{"in":1,"out":null}',
    "null",
    "[1,2]",
  ]) {
    assert.throws(
      () => parseState(`{"month":"2026-11","boxes":{"a":${bad}},"capped":false}`),
      /malformed/,
    );
  }
});

const open: Port[] = [{ protocol: "udp", fromPort: 3478, toPort: 3478 }];
const closed: Port[] = [{ protocol: "tcp", fromPort: 22, toPort: 22 }];
const relayOpen: Port[] = [{ protocol: "tcp", fromPort: 443, toPort: 443 }];
const relayClosed: Port[] = [{ protocol: "tcp", fromPort: 80, toPort: 80 }];
const boxes = [
  { box: "box-1", openPorts: open, cappedPorts: closed },
  { box: "relay-1", openPorts: relayOpen, cappedPorts: relayClosed },
];

test("config comes from the environment and refuses to run without it", () => {
  assert.throws(() => configFromEnv({}), /BOXES/);
  const env = {
    BOXES: JSON.stringify(boxes),
    LIMIT_BYTES: "1800000000000",
    RELAYS: '["sto"]',
    STATUS_URL: "https://fidant.se/relay-status",
  };
  assert.deepEqual(configFromEnv(env), {
    boxes,
    limitBytes: 1_800_000_000_000,
    relays: ["sto"],
    statusUrl: "https://fidant.se/relay-status",
  });
  assert.throws(() => configFromEnv({ ...env, LIMIT_BYTES: "abc" }));
  assert.throws(() => configFromEnv({ ...env, RELAYS: '"sto"' }), /RELAYS/);
  assert.throws(() => configFromEnv({ ...env, RELAYS: '[""]' }), /RELAYS/);
  assert.throws(() => configFromEnv({ ...env, STATUS_URL: "http://fidant.se/relay-status" }));
  for (const bad of [
    [],
    [{ box: "", openPorts: open, cappedPorts: closed }],
    [{ box: "box-1", openPorts: open, cappedPorts: [] }],
    [{ box: "box-1", openPorts: open }],
  ]) {
    assert.throws(() => configFromEnv({ ...env, BOXES: JSON.stringify(bad) }), /BOXES/);
  }
});

test("the month total is logged in CloudWatch embedded metric format", () => {
  const stamp = new Date("2026-11-24T12:00:00Z");
  assert.deepEqual(JSON.parse(metricLine(5, stamp)), {
    _aws: {
      Timestamp: stamp.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: "Fidant",
          Dimensions: [["Service"]],
          Metrics: [{ Name: "RelayMonthBytes", Unit: "Bytes" }],
        },
      ],
    },
    Service: "relay",
    RelayMonthBytes: 5,
  });
});

const config: CapConfig = {
  boxes,
  limitBytes: limit,
  relays: ["sto"],
  statusUrl: "https://fidant.se/relay-status",
};
const now = new Date("2026-11-24T12:00:00Z");

function fake(over: Partial<CapDeps> & { bytes?: number; state?: string } = {}) {
  const calls: string[] = [];
  const args: { boxTraffic: unknown[][]; putPorts: unknown[][]; writeState: unknown[][] } = {
    boxTraffic: [],
    putPorts: [],
    writeState: [],
  };
  const deps: CapDeps = {
    async boxTraffic(...a) {
      calls.push("boxTraffic");
      args.boxTraffic.push(a);
      return t(over.bytes ?? limit);
    },
    async readState() {
      calls.push("readState");
      return over.state;
    },
    async writeState(...a) {
      calls.push("writeState");
      args.writeState.push(a);
    },
    async putPorts(...a) {
      calls.push("putPorts");
      args.putPorts.push(a);
    },
    log() {
      calls.push("log");
    },
    ...over,
  };
  return { deps, calls, args };
}

test("a run sums the month so far over every box, caps each box's ports, then saves the state", async () => {
  const { deps, calls, args } = fake();
  await runCap(deps, config, now);
  const start = new Date("2026-11-01T00:00:00Z");
  assert.deepEqual(args.boxTraffic, [
    ["box-1", start, now],
    ["relay-1", start, now],
  ]);
  assert.deepEqual(args.putPorts, [
    ["box-1", closed],
    ["relay-1", relayClosed],
  ]);
  assert.deepEqual(calls, [
    "readState",
    "boxTraffic",
    "boxTraffic",
    "putPorts",
    "putPorts",
    "writeState",
    "log",
  ]);
  assert.deepEqual(JSON.parse(args.writeState[0]?.[0] as string), {
    month: "2026-11",
    boxes: { "box-1": t(limit), "relay-1": t(limit) },
    capped: true,
  });
});

test("a run in a new month reopens every box's ports with its full list", async () => {
  const state = JSON.stringify({ month: "2026-10", boxes: { "box-1": t(limit) }, capped: true });
  const { deps, args } = fake({ state, bytes: 0 });
  await runCap(deps, config, now);
  assert.deepEqual(args.putPorts, [
    ["box-1", open],
    ["relay-1", relayOpen],
  ]);
});

test("a run after capped is set to true by hand under the limit opens both boxes and saves capped false", async () => {
  const state = JSON.stringify({
    month: "2026-11",
    boxes: { "box-1": t(5), "relay-1": t(7) },
    capped: true,
  });
  const { deps, args } = fake({ state, bytes: 1 });
  await runCap(deps, config, now);
  assert.deepEqual(args.putPorts, [
    ["box-1", open],
    ["relay-1", relayOpen],
  ]);
  assert.deepEqual(JSON.parse(args.writeState[0]?.[0] as string), {
    month: "2026-11",
    boxes: { "box-1": t(5), "relay-1": t(7) },
    capped: false,
  });
});

test("a run under the limit changes no ports", async () => {
  const { deps, args } = fake({ bytes: 1 });
  await runCap(deps, config, now);
  assert.equal(args.putPorts.length, 0);
  assert.equal(args.writeState.length, 1);
});

test("a failed metrics read saves nothing", async () => {
  const { deps, args } = fake({
    async boxTraffic(box) {
      if (box === "relay-1") {
        throw new Error("metrics down");
      }
      return t(limit);
    },
  });
  await assert.rejects(runCap(deps, config, now));
  assert.equal(args.writeState.length, 0);
  assert.equal(args.putPorts.length, 0);
});

test("a failed port change on any box saves nothing", async () => {
  const { deps, args } = fake({
    async putPorts(box) {
      if (box === "relay-1") {
        throw new Error("lightsail down");
      }
    },
  });
  await assert.rejects(runCap(deps, config, now));
  assert.equal(args.writeState.length, 0);
});

const json = "application/json";

test("the relay status parses only a 200 JSON array of exactly id and up", () => {
  assert.deepEqual(parseStatus(200, json, '[{"id":"sto","up":true}]'), [{ id: "sto", up: true }]);
  assert.deepEqual(parseStatus(200, "Application/JSON; charset=utf-8", '[{"up":false,"id":"a"}]'), [
    { id: "a", up: false },
  ]);
  assert.deepEqual(parseStatus(200, json, "[]"), []);
  const html = '<!doctype html><html lang="en"><head><title>Fidant</title></head></html>';
  for (const [status, type, body] of [
    [200, "text/html; charset=utf-8", html],
    [200, json, html],
    [200, null, '[{"id":"sto","up":true}]'],
    [200, "application/jsonx", '[{"id":"sto","up":true}]'],
    [404, json, '[{"id":"sto","up":true}]'],
    [503, json, '[{"id":"sto","up":true}]'],
    [200, json, '{"id":"sto","up":true}'],
    [200, json, "null"],
    [200, json, "[null]"],
    [200, json, '[["sto",true]]'],
    [200, json, '[{"id":"sto"}]'],
    [200, json, '[{"id":"sto","up":"true"}]'],
    [200, json, '[{"id":1,"up":true}]'],
    [200, json, '[{"id":"sto","up":true,"extra":1}]'],
  ] as const) {
    assert.equal(parseStatus(status, type, body), undefined, `${status} ${type} ${body}`);
  }
});

test("reading the relay status passes an abort signal and never throws", async () => {
  const seen: (RequestInit | undefined)[] = [];
  const answering =
    (response: () => Response): typeof fetch =>
    async (_url, init) => {
      seen.push(init);
      return response();
    };
  const ok = () => new Response('[{"id":"sto","up":true}]', { headers: { "content-type": json } });
  assert.deepEqual(await readStatus("https://fidant.se/relay-status", answering(ok)), [
    { id: "sto", up: true },
  ]);
  assert.ok(seen[0]?.signal instanceof AbortSignal);
  const spa = () =>
    new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });
  assert.equal(await readStatus("https://fidant.se/relay-status", answering(spa)), undefined);
  const failing: typeof fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  assert.equal(await readStatus("https://fidant.se/relay-status", failing), undefined);
  const brokenBody = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("reset"));
        },
      }),
      { headers: { "content-type": json } },
    );
  assert.equal(
    await readStatus("https://fidant.se/relay-status", answering(brokenBody)),
    undefined,
  );
});

test("a read status logs that it was read and whether each configured relay is up", () => {
  const lines = (status: Parameters<typeof statusLines>[1]) =>
    statusLines(["sto", "osl"], status, now).map((line) => JSON.parse(line));
  const emf = (dimensions: Record<string, string>, name: string, value: number) => ({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: "Fidant",
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: name, Unit: "None" }],
        },
      ],
    },
    ...dimensions,
    [name]: value,
  });
  assert.deepEqual(lines(undefined), [emf({ Service: "relay" }, "RelayStatusOk", 0)]);
  assert.deepEqual(
    lines([
      { id: "sto", up: true },
      { id: "osl", up: false },
      { id: "other", up: true },
    ]),
    [
      emf({ Service: "relay" }, "RelayStatusOk", 1),
      emf({ Relay: "sto" }, "RelayUp", 1),
      emf({ Relay: "osl" }, "RelayUp", 0),
    ],
  );
  assert.deepEqual(lines([]), [
    emf({ Service: "relay" }, "RelayStatusOk", 1),
    emf({ Relay: "sto" }, "RelayUp", 0),
    emf({ Relay: "osl" }, "RelayUp", 0),
  ]);
});

test("a status body over 64 KiB is not read to the end", async () => {
  let pulled = 0;
  const huge = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(16 * 1024));
          if (pulled > 1000) {
            controller.close();
          }
        },
      }),
      { headers: { "content-type": json } },
    );
  assert.equal(await readStatus("https://fidant.se/relay-status", async () => huge()), undefined);
  assert.ok(pulled < 20, `pulled ${pulled} chunks`);
});

test("reading the relay status refuses redirects", async () => {
  const seen: (RequestInit | undefined)[] = [];
  const redirecting: typeof fetch = async (_url, init) => {
    seen.push(init);
    throw new TypeError("fetch failed");
  };
  assert.equal(await readStatus("https://fidant.se/relay-status", redirecting), undefined);
  assert.equal(seen[0]?.redirect, "error");
});

test("the cap runs before the status is fetched, and a failing cap still logs the status", async () => {
  const order: string[] = [];
  const runConfig = { ...config, statusUrl: "https://fidant.se/relay-status" };
  const status = async () => {
    order.push("status");
    return undefined;
  };
  const { deps } = fake({
    async boxTraffic() {
      order.push("cap");
      return t(0);
    },
    log: (line) => order.push(line.includes("RelayStatusOk") ? "line" : "other"),
  });
  await runOnce(deps, runConfig, new Date("2026-03-10T00:00:00Z"), status);
  assert.ok(order.indexOf("status") > order.lastIndexOf("cap"));
  assert.ok(order.includes("line"));
  const lines: string[] = [];
  const broken = fake({
    async readState() {
      throw new Error("ssm down");
    },
    log: (line) => lines.push(line),
  });
  await assert.rejects(runOnce(broken.deps, runConfig, new Date(), status), /ssm down/);
  assert.equal(lines.length, 1);
});

test("a run on an old-shape state saves only the new shape", async () => {
  const state = JSON.stringify({ month: "2026-11", boxes: { "box-1": 9, gone: 4 }, capped: false });
  const { deps, args } = fake({ state, bytes: 1 });
  await runCap(deps, config, now);
  assert.deepEqual(JSON.parse(args.writeState[0]?.[0] as string), {
    month: "2026-11",
    boxes: { "box-1": t(1), gone: t(4), "relay-1": t(1) },
    capped: false,
  });
});
