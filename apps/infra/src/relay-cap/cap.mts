export type Port = {
  protocol: string;
  fromPort: number;
  toPort: number;
  cidrs?: string[];
  ipv6Cidrs?: string[];
  cidrListAliases?: string[];
};
export type CapState = { month: string; boxes: Record<string, number>; capped: boolean };
export type BoxPorts = { box: string; openPorts: Port[]; cappedPorts: Port[] };
export type CapConfig = {
  boxes: BoxPorts[];
  limitBytes: number;
  relays: string[];
  statusUrl: string;
};
export type RelayStatus = { id: string; up: boolean }[];
export type CapDeps = {
  boxBytes(box: string, start: Date, end: Date): Promise<number>;
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

export function parseState(json: string | undefined): CapState | undefined {
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
    !Object.values(boxes).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) ||
    typeof value.capped !== "boolean"
  ) {
    throw new Error("relay cap state is malformed");
  }
  return { month: value.month, boxes: { ...boxes }, capped: value.capped };
}

export function decide(
  previous: CapState | undefined,
  month: string,
  counts: Record<string, number>,
  limitBytes: number,
): { state: CapState; total: number; ports: "keep" | "open" | "capped" } {
  const boxes = previous?.month === month ? { ...previous.boxes } : {};
  for (const [box, bytes] of Object.entries(counts)) {
    boxes[box] = Math.max(boxes[box] ?? 0, bytes);
  }
  const total = Object.values(boxes).reduce((sum, n) => sum + n, 0);
  const capped = total >= limitBytes;
  const ports = capped ? "capped" : previous?.capped ? "open" : "keep";
  return { state: { month, boxes, capped }, total, ports };
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

export function configFromEnv(env: Record<string, string | undefined>): CapConfig {
  const boxes = boxList(required(env, "BOXES"));
  const limit = required(env, "LIMIT_BYTES");
  if (!/^[1-9]\d*$/.test(limit)) {
    throw new Error("LIMIT_BYTES must be a positive integer");
  }
  const relays = JSON.parse(required(env, "RELAYS"));
  if (!Array.isArray(relays) || !relays.every((id) => typeof id === "string" && id !== "")) {
    throw new Error("RELAYS must be an array of relay ids");
  }
  const statusUrl = required(env, "STATUS_URL");
  if (URL.parse(statusUrl)?.protocol !== "https:") {
    throw new Error("STATUS_URL must be an https URL");
  }
  return { boxes, limitBytes: Number(limit), relays, statusUrl };
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

export async function readStatus(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<RelayStatus | undefined> {
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
    return parseStatus(
      response.status,
      response.headers.get("content-type"),
      await response.text(),
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
  const counts: Record<string, number> = {};
  for (const { box } of config.boxes) {
    counts[box] = await deps.boxBytes(box, monthStart(now), now);
  }
  const { state, total, ports } = decide(previous, monthOf(now), counts, config.limitBytes);
  if (ports !== "keep") {
    for (const { box, openPorts, cappedPorts } of config.boxes) {
      await deps.putPorts(box, ports === "capped" ? cappedPorts : openPorts);
    }
  }
  await deps.writeState(JSON.stringify(state));
  deps.log(metricLine(total, now));
}
