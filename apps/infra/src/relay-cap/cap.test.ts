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
  overageLine,
  type Port,
  parseState,
  parseStatus,
  readStatus,
  runCap,
  runOnce,
  statusLines,
} from "./cap.mts";

const price = { allowanceBytes: 4_000_000_000_000, budgetUsd: 20, usdPerGb: 0.09 };
const capOut = 4_223_000_000_000;
const TB = 1_000_000_000_000;
const GB = 1_000_000_000;

const t = (out: number, inbound = 0) => ({ in: inbound, out });

test("a fresh month under the budget leaves the ports alone", () => {
  assert.deepEqual(decide(undefined, "2026-11", { a: t(5) }, price), {
    state: { month: "2026-11", boxes: { a: t(5) }, capped: false },
    total: 5,
    overageUsd: 0,
    ports: "keep",
  });
});

test("each box's in and out never go down within a month", () => {
  const previous = { month: "2026-11", boxes: { a: { in: 100, out: 10 } }, capped: false };
  assert.deepEqual(decide(previous, "2026-11", { a: { in: 50, out: 20 } }, price).state.boxes.a, {
    in: 100,
    out: 20,
  });
});

test("a replaced box's traffic still counts toward the month", () => {
  const previous = { month: "2026-11", boxes: { old: t(2200 * GB) }, capped: false };
  const result = decide(previous, "2026-11", { new: t(2100 * GB) }, price);
  assert.equal(result.total, 4300 * GB);
  assert.equal(result.ports, "capped");
  assert.deepEqual(result.state.boxes, { old: t(2200 * GB), new: t(2100 * GB) });
});

test("reaching the budget caps the relay ports, and every later run caps them again", () => {
  const first = decide(undefined, "2026-11", { a: { in: 0, out: capOut } }, price);
  assert.equal(first.ports, "capped");
  assert.equal(decide(first.state, "2026-11", { a: t(0) }, price).ports, "capped");
});

test("a new month reopens ports the cap closed", () => {
  const previous = { month: "2026-11", boxes: { a: t(capOut) }, capped: true };
  const result = decide(previous, "2026-12", { a: t(0) }, price);
  assert.equal(result.ports, "open");
  assert.deepEqual(result.state, { month: "2026-12", boxes: { a: t(0) }, capped: false });
});

test("a raised budget reopens the ports within the month", () => {
  const previous = { month: "2026-11", boxes: { a: t(capOut) }, capped: true };
  assert.equal(
    decide(previous, "2026-11", { a: t(capOut) }, { ...price, budgetUsd: 40 }).ports,
    "open",
  );
});

test("under the budget, ports the cap didn't close are never touched", () => {
  const previous = { month: "2026-11", boxes: { a: t(1) }, capped: false };
  assert.equal(decide(previous, "2026-11", { a: t(2) }, price).ports, "keep");
});

test("every box's traffic counts toward one total, and each box keeps its own maximum", () => {
  const previous = { month: "2026-11", boxes: { a: t(100), b: t(200) }, capped: false };
  const result = decide(previous, "2026-11", { a: t(50), b: { in: 100, out: 200 } }, price);
  assert.deepEqual(result.state.boxes, { a: t(100), b: { in: 100, out: 200 } });
  assert.equal(result.total, 400);
  assert.equal(decide(previous, "2026-11", { a: t(capOut - 200), b: t(0) }, price).ports, "capped");
});

test("a state capped by hand under the budget reopens the ports", () => {
  const previous = { month: "2026-11", boxes: { a: t(1), b: t(2) }, capped: true };
  const result = decide(previous, "2026-11", { a: t(1), b: t(2) }, price);
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

const cost = (...counts: { in: number; out: number }[]) =>
  decide(undefined, "2026-11", Object.fromEntries(counts.map((c, i) => [`b${i}`, c])), price);

test("10 TB in and no traffic out cost nothing and keep the ports", () => {
  const result = cost(t(0, 5 * TB), t(0, 5 * TB));
  assert.equal(result.overageUsd, 0);
  assert.equal(result.ports, "keep");
});

test("10 TB in and 100 GB out cost 9 USD and keep the ports", () => {
  const result = cost(t(100 * GB, 10 * TB));
  assert.equal(result.overageUsd.toFixed(6), "9.000000");
  assert.equal(result.ports, "keep");
});

test("4.23 TB out costs 20.7 USD and caps, 4.2 TB costs 18 USD and keeps", () => {
  const over = cost(t(4230 * GB));
  assert.equal(over.overageUsd.toFixed(6), "20.700000");
  assert.equal(over.ports, "capped");
  assert.equal(decide(over.state, "2026-11", { b0: t(4230 * GB) }, price).ports, "capped");
  const under = cost(t(4200 * GB));
  assert.equal(under.overageUsd.toFixed(6), "18.000000");
  assert.equal(under.ports, "keep");
});

test("the estimate matches AWS pricing example 2 (4 TB pool, 2.2 TB in, 2.1 TB out)", () => {
  assert.equal(cost(t(2100 * GB, 2200 * GB)).overageUsd.toFixed(6), (0.3 * 1000 * 0.09).toFixed(6));
});

test("an estimate exactly at the budget caps", () => {
  const exact = { allowanceBytes: TB, budgetUsd: 20, usdPerGb: 0.5 };
  const result = decide(undefined, "2026-11", { a: t(TB + 40 * GB) }, exact);
  assert.equal(result.overageUsd, 20);
  assert.equal(result.ports, "capped");
});

test("the estimate stays above the bill in AWS FAQ example 1 (1 TB pool, 600 GB in, 700 GB out)", () => {
  const pool = { allowanceBytes: TB, budgetUsd: 20, usdPerGb: 0.09 };
  const result = decide(undefined, "2026-11", { a: t(700 * GB, 600 * GB) }, pool);
  assert.equal(result.overageUsd.toFixed(6), (300 * 0.09).toFixed(6));
  assert.ok(result.overageUsd > 100 * 0.09);
});

test("the estimate is never more than outbound traffic at the overage price", () => {
  for (const inbound of [0, 1 * TB, 4 * TB, 10 * TB]) {
    for (const out of [0, 100 * GB, 2 * TB, 4 * TB, 5 * TB, 20 * TB]) {
      const { overageUsd } = cost(t(out, inbound));
      assert.ok(overageUsd >= 0);
      assert.ok(overageUsd <= (out / 1e9) * 0.09 + 1e-9, `${inbound} ${out}`);
    }
  }
});

test("an old-shape state capped by the byte limit reopens both boxes", async () => {
  const state = JSON.stringify({
    month: "2026-11",
    boxes: { "box-1": 1_000_000_000_000, "relay-1": 900_000_000_000 },
    capped: true,
  });
  const { deps, args } = fake({ state, bytes: 1 });
  await runCap(deps, config, now);
  assert.deepEqual(args.putPorts, [
    ["box-1", open],
    ["relay-1", relayOpen],
  ]);
  assert.equal(JSON.parse(args.writeState[0]?.[0] as string).capped, false);
});

test("a fresh read replaces an old number, even a smaller one", () => {
  const previous = { month: "2026-11", boxes: { a: 900 }, capped: false };
  const result = decide(previous, "2026-11", { a: { in: 100, out: 200 } }, price);
  assert.deepEqual(result.state.boxes, { a: { in: 100, out: 200 } });
  assert.equal(result.total, 300);
});

test("an old number for a box not in this run is kept as outbound", () => {
  const previous = { month: "2026-11", boxes: { gone: 900, a: 5 }, capped: false };
  const result = decide(previous, "2026-11", { a: { in: 1, out: 2 } }, price);
  assert.deepEqual(result.state.boxes, { gone: { in: 0, out: 900 }, a: { in: 1, out: 2 } });
  assert.equal(result.total, 903);
});

test("an old state from an earlier month is dropped", () => {
  const previous = { month: "2026-10", boxes: { a: capOut }, capped: true };
  const result = decide(previous, "2026-11", { a: t(1) }, price);
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
    ALLOWANCE_BYTES: "4000000000000",
    BUDGET_USD: "20",
    USD_PER_GB: "0.09",
    RELAYS: '["sto"]',
    STATUS_URL: "https://fidant.se/relay-status",
  };
  assert.deepEqual(configFromEnv(env), {
    boxes,
    allowanceBytes: 4_000_000_000_000,
    budgetUsd: 20,
    usdPerGb: 0.09,
    relays: ["sto"],
    statusUrl: "https://fidant.se/relay-status",
  });
  for (const [name, key] of [
    ["ALLOWANCE_BYTES", "allowanceBytes"],
    ["BUDGET_USD", "budgetUsd"],
    ["USD_PER_GB", "usdPerGb"],
  ] as const) {
    assert.equal(configFromEnv({ ...env, [name]: "1.5" })[key], 1.5);
    for (const bad of [undefined, "", "abc", "0", "0.0", "-1", "1e3", "1.", ".5", "1,5"]) {
      assert.throws(() => configFromEnv({ ...env, [name]: bad }), new RegExp(name));
    }
  }
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

test("the overage cost is logged as RelayMonthOverageUsd with the month total's dimensions", () => {
  const stamp = new Date("2026-11-24T12:00:00Z");
  assert.deepEqual(JSON.parse(overageLine(1.5, stamp)), {
    _aws: {
      Timestamp: stamp.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: "Fidant",
          Dimensions: [["Service"]],
          Metrics: [{ Name: "RelayMonthOverageUsd", Unit: "None" }],
        },
      ],
    },
    Service: "relay",
    RelayMonthOverageUsd: 1.5,
  });
});

const config: CapConfig = {
  boxes,
  ...price,
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
      return t(over.bytes ?? capOut);
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
    "log",
  ]);
  assert.deepEqual(JSON.parse(args.writeState[0]?.[0] as string), {
    month: "2026-11",
    boxes: { "box-1": t(capOut), "relay-1": t(capOut) },
    capped: true,
  });
});

test("a run logs the in plus out total as the bytes and the estimate as the overage", async () => {
  const lines: string[] = [];
  const { deps } = fake({
    async boxTraffic() {
      return t(2 * TB, 3 * TB);
    },
    log: (line) => lines.push(line),
  });
  await runCap(deps, config, now);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0] as string).RelayMonthBytes, 10 * TB);
  assert.equal(JSON.parse(lines[1] as string).RelayMonthOverageUsd.toFixed(6), "360.000000");
});

test("a run in a new month reopens every box's ports with its full list", async () => {
  const state = JSON.stringify({ month: "2026-10", boxes: { "box-1": t(capOut) }, capped: true });
  const { deps, args } = fake({ state, bytes: 0 });
  await runCap(deps, config, now);
  assert.deepEqual(args.putPorts, [
    ["box-1", open],
    ["relay-1", relayOpen],
  ]);
});

test("a run after capped is set to true by hand under the budget opens both boxes and saves capped false", async () => {
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

test("a run under the budget changes no ports", async () => {
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
      return t(capOut);
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
