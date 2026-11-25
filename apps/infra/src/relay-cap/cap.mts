export type Port = {
  protocol: string;
  fromPort: number;
  toPort: number;
  cidrs?: string[];
  ipv6Cidrs?: string[];
  cidrListAliases?: string[];
};
export type Traffic = { in: number; out: number };
export type CapState = { month: string; boxes: Record<string, Traffic>; capped: boolean };
export type StoredState = {
  month: string;
  boxes: Record<string, Traffic | number>;
  capped: boolean;
};
export type BoxPorts = { box: string; openPorts: Port[]; cappedPorts: Port[] };
export type CapConfig = {
  boxes: BoxPorts[];
  allowanceBytes: number;
  budgetUsd: number;
  usdPerGb: number;
  relays: string[];
  statusUrl: string;
};
export type Pricing = { allowanceBytes: number; budgetUsd: number; usdPerGb: number };
export type RelayStatus = { id: string; up: boolean }[];
export type CapDeps = {
  boxTraffic(box: string, start: Date, end: Date): Promise<Traffic>;
  readState(): Promise<string | undefined>;
  writeState(json: string): Promise<void>;
  putPorts(box: string, ports: Port[]): Promise<void>;
  log(line: string): void;
};

export function monthOf(now: Date): string {
  return now.toISOString().slice(0, 7);
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function validNumber(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function validCount(value: unknown): boolean {
  if (validNumber(value)) {
    return true;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).sort().join() === "in,out" &&
    validNumber((value as Traffic).in) &&
    validNumber((value as Traffic).out)
  );
}

export function parseState(json: string | undefined): StoredState | undefined {
  if (json === undefined) {
    return undefined;
  }
  const value = JSON.parse(json);
  const boxes = value?.boxes;
  if (
    typeof value?.month !== "string" ||
    !/^\d{4}-\d{2}$/.test(value.month) ||
    typeof boxes !== "object" ||
    boxes === null ||
    !Object.values(boxes).every(validCount) ||
    typeof value.capped !== "boolean"
  ) {
    throw new Error("relay cap state is malformed");
  }
  const copy = Object.fromEntries(
    Object.entries(boxes as Record<string, Traffic | number>).map(([box, count]) => [
      box,
      typeof count === "number" ? count : { in: count.in, out: count.out },
    ]),
  );
  return { month: value.month, boxes: copy, capped: value.capped };
}

export function decide(
  previous: StoredState | undefined,
  month: string,
  counts: Record<string, Traffic>,
  pricing: Pricing,
): { state: CapState; total: number; overageUsd: number; ports: "keep" | "open" | "capped" } {
  const boxes: Record<string, Traffic> = {};
  if (previous?.month === month) {
    for (const [box, count] of Object.entries(previous.boxes)) {
      if (typeof count !== "number") {
        boxes[box] = { ...count };
      } else if (!(box in counts)) {
        // ponytail: a count from before SIG-154 is in plus out; drop once no such state exists
        boxes[box] = { in: 0, out: count };
      }
    }
  }
  for (const [box, fresh] of Object.entries(counts)) {
    boxes[box] = {
      in: Math.max(boxes[box]?.in ?? 0, fresh.in),
      out: Math.max(boxes[box]?.out ?? 0, fresh.out),
    };
  }
  const total = Object.values(boxes).reduce((sum, t) => sum + t.in + t.out, 0);
  const out = Object.values(boxes).reduce((sum, t) => sum + t.out, 0);
  const overageBytes = Math.min(out, Math.max(0, total - pricing.allowanceBytes));
  const overageUsd = (overageBytes / 1e9) * pricing.usdPerGb;
  const capped = overageUsd >= pricing.budgetUsd;
  const ports = capped ? "capped" : previous?.capped ? "open" : "keep";
  return { state: { month, boxes, capped }, total, overageUsd, ports };
}

function boxList(json: string): BoxPorts[] {
  const value = JSON.parse(json);
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry) =>
        typeof entry?.box === "string" &&
        entry.box !== "" &&
        [entry.openPorts, entry.cappedPorts].every(
          (ports) => Array.isArray(ports) && ports.length > 0,
        ),
    );
  if (!valid) {
    throw new Error("BOXES must be a non-empty array of boxes with non-empty port lists");
  }
  return value.map(({ box, openPorts, cappedPorts }) => ({ box, openPorts, cappedPorts }));
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function positive(env: Record<string, string | undefined>, name: string): number {
  const value = required(env, name);
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Number(value);
}

export function configFromEnv(env: Record<string, string | undefined>): CapConfig {
  const boxes = boxList(required(env, "BOXES"));
  const allowanceBytes = positive(env, "ALLOWANCE_BYTES");
  const budgetUsd = positive(env, "BUDGET_USD");
  const usdPerGb = positive(env, "USD_PER_GB");
  const relays = JSON.parse(required(env, "RELAYS"));
  if (!Array.isArray(relays) || !relays.every((id) => typeof id === "string" && id !== "")) {
    throw new Error("RELAYS must be an array of relay ids");
  }
  const statusUrl = required(env, "STATUS_URL");
  if (URL.parse(statusUrl)?.protocol !== "https:") {
    throw new Error("STATUS_URL must be an https URL");
  }
  return { boxes, allowanceBytes, budgetUsd, usdPerGb, relays, statusUrl };
}

function metric(
  dimensions: Record<string, string>,
  name: string,
  value: number,
  unit: string,
  now: Date,
): string {
  return JSON.stringify({
    _aws: {
      Timestamp: now.getTime(),
      CloudWatchMetrics: [
        {
          Namespace: "Fidant",
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    ...dimensions,
    [name]: value,
  });
}

export function metricLine(total: number, now: Date): string {
  return metric({ Service: "relay" }, "RelayMonthBytes", total, "Bytes", now);
}

export function overageLine(overageUsd: number, now: Date): string {
  return metric({ Service: "relay" }, "RelayMonthOverageUsd", overageUsd, "None", now);
}

export function parseStatus(
  status: number,
  contentType: string | null,
  body: string,
): RelayStatus | undefined {
  if (status !== 200 || contentType?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  const valid =
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        Object.keys(entry).sort().join() === "id,up" &&
        typeof entry.id === "string" &&
        typeof entry.up === "boolean",
    );
  return valid ? (value as RelayStatus) : undefined;
}

const statusLimit = 64 * 1024;

export async function readStatus(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<RelayStatus | undefined> {
  try {
    const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > statusLimit) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    return parseStatus(
      response.status,
      response.headers.get("content-type"),
      Buffer.concat(chunks).toString("utf8"),
    );
  } catch {
    return undefined;
  }
}

export function statusLines(
  relays: string[],
  status: RelayStatus | undefined,
  now: Date,
): string[] {
  const lines = [metric({ Service: "relay" }, "RelayStatusOk", status ? 1 : 0, "None", now)];
  if (status) {
    for (const id of relays) {
      const up = status.some((relay) => relay.id === id && relay.up) ? 1 : 0;
      lines.push(metric({ Relay: id }, "RelayUp", up, "None", now));
    }
  }
  return lines;
}

export async function runCap(deps: CapDeps, config: CapConfig, now: Date): Promise<void> {
  const previous = parseState(await deps.readState());
  const counts: Record<string, Traffic> = {};
  for (const { box } of config.boxes) {
    counts[box] = await deps.boxTraffic(box, monthStart(now), now);
  }
  const { state, total, overageUsd, ports } = decide(previous, monthOf(now), counts, config);
  if (ports !== "keep") {
    for (const { box, openPorts, cappedPorts } of config.boxes) {
      await deps.putPorts(box, ports === "capped" ? cappedPorts : openPorts);
    }
  }
  await deps.writeState(JSON.stringify(state));
  deps.log(metricLine(total, now));
  deps.log(overageLine(overageUsd, now));
}

export async function runOnce(
  deps: CapDeps,
  config: CapConfig,
  now: Date,
  fetchStatus: (url: string) => Promise<RelayStatus | undefined> = readStatus,
): Promise<void> {
  try {
    await runCap(deps, config, now);
  } finally {
    for (const line of statusLines(config.relays, await fetchStatus(config.statusUrl), now)) {
      deps.log(line);
    }
  }
}
