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
  runCap,
} from "./cap.mts";

const limit = 1_800_000_000_000;

test("a fresh month under the limit leaves the ports alone", () => {
  assert.deepEqual(decide(undefined, "2026-11", { a: 5 }, limit), {
    state: { month: "2026-11", boxes: { a: 5 }, capped: false },
    total: 5,
    ports: "keep",
  });
});

test("the box's total never goes down within a month", () => {
  const previous = { month: "2026-11", boxes: { a: 100 }, capped: false };
  assert.equal(decide(previous, "2026-11", { a: 50 }, limit).state.boxes.a, 100);
});

test("a replaced box's traffic still counts toward the month", () => {
  const previous = { month: "2026-11", boxes: { old: 1_000_000_000_000 }, capped: false };
  const result = decide(previous, "2026-11", { new: 900_000_000_000 }, limit);
  assert.equal(result.total, 1_900_000_000_000);
  assert.equal(result.ports, "capped");
  assert.deepEqual(result.state.boxes, { old: 1_000_000_000_000, new: 900_000_000_000 });
});

test("reaching the limit caps the relay ports, and every later run caps them again", () => {
  const first = decide(undefined, "2026-11", { a: limit }, limit);
  assert.equal(first.ports, "capped");
  assert.equal(decide(first.state, "2026-11", { a: limit }, limit).ports, "capped");
});

test("a new month reopens ports the cap closed", () => {
  const previous = { month: "2026-11", boxes: { a: limit }, capped: true };
  const result = decide(previous, "2026-12", { a: 0 }, limit);
  assert.equal(result.ports, "open");
  assert.deepEqual(result.state, { month: "2026-12", boxes: { a: 0 }, capped: false });
});

test("a raised limit reopens the ports within the month", () => {
  const previous = { month: "2026-11", boxes: { a: limit }, capped: true };
  assert.equal(decide(previous, "2026-11", { a: limit }, 2 * limit).ports, "open");
});

test("under the limit, ports the cap didn't close are never touched", () => {
  const previous = { month: "2026-11", boxes: { a: 1 }, capped: false };
  assert.equal(decide(previous, "2026-11", { a: 2 }, limit).ports, "keep");
});

test("every box's traffic counts toward one total, and each box keeps its own maximum", () => {
  const previous = { month: "2026-11", boxes: { a: 100, b: 200 }, capped: false };
  const result = decide(previous, "2026-11", { a: 50, b: 300 }, limit);
  assert.deepEqual(result.state.boxes, { a: 100, b: 300 });
  assert.equal(result.total, 400);
  assert.equal(decide(previous, "2026-11", { a: limit - 200, b: 0 }, limit).ports, "capped");
});

test("a state capped by hand under the limit reopens the ports", () => {
  const previous = { month: "2026-11", boxes: { a: 1, b: 2 }, capped: true };
  const result = decide(previous, "2026-11", { a: 1, b: 2 }, limit);
  assert.equal(result.ports, "open");
  assert.equal(result.state.capped, false);
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
  const env = { BOXES: JSON.stringify(boxes), LIMIT_BYTES: "1800000000000" };
  assert.deepEqual(configFromEnv(env), { boxes, limitBytes: 1_800_000_000_000 });
  assert.throws(() => configFromEnv({ ...env, LIMIT_BYTES: "abc" }));
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

const config: CapConfig = { boxes, limitBytes: limit };
const now = new Date("2026-11-24T12:00:00Z");

function fake(over: Partial<CapDeps> & { bytes?: number; state?: string } = {}) {
  const calls: string[] = [];
  const args: { boxBytes: unknown[][]; putPorts: unknown[][]; writeState: unknown[][] } = {
    boxBytes: [],
    putPorts: [],
    writeState: [],
  };
  const deps: CapDeps = {
    async boxBytes(...a) {
      calls.push("boxBytes");
      args.boxBytes.push(a);
      return over.bytes ?? limit;
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
  assert.deepEqual(args.boxBytes, [
    ["box-1", start, now],
    ["relay-1", start, now],
  ]);
  assert.deepEqual(args.putPorts, [
    ["box-1", closed],
    ["relay-1", relayClosed],
  ]);
  assert.deepEqual(calls, [
    "readState",
    "boxBytes",
    "boxBytes",
    "putPorts",
    "putPorts",
    "writeState",
    "log",
  ]);
  assert.deepEqual(JSON.parse(args.writeState[0]?.[0] as string), {
    month: "2026-11",
    boxes: { "box-1": limit, "relay-1": limit },
    capped: true,
  });
});

test("a run in a new month reopens every box's ports with its full list", async () => {
  const state = JSON.stringify({ month: "2026-10", boxes: { "box-1": limit }, capped: true });
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
    boxes: { "box-1": 5, "relay-1": 7 },
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
    boxes: { "box-1": 5, "relay-1": 7 },
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
    async boxBytes(box) {
      if (box === "relay-1") {
        throw new Error("metrics down");
      }
      return limit;
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
