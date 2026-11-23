import type { ObservationRecord } from "../observations.ts";
import type { Capture } from "./scan.ts";

/**
 * The captures in one actor's observation records. `file` names the JSONL file, such as
 * `observations/<test>/<actor>.jsonl`; each point adds the record's 1-based line and field, such as
 * `…/sender.jsonl#12 request.headers.referer`. Bodies and binary frames are stored as base64, so
 * they are decoded here and scanned as the bytes that went over the wire.
 */
export function recordCaptures(file: string, records: readonly ObservationRecord[]): Capture[] {
  const captures: Capture[] = [];
  records.forEach((record, index) => {
    const at = `${file}#${index + 1} ${record.type}`;
    const add = (field: string, bytes: Buffer, contentEncoding?: string) =>
      captures.push({
        point: `${at}.${field}`,
        bytes,
        ...(contentEncoding ? { hints: { contentEncoding } } : {}),
      });
    add("url", Buffer.from(record.url));
    switch (record.type) {
      case "request":
      case "response":
        // The name is part of the capture: a header name could carry a secret too.
        for (const [name, value] of Object.entries(record.headers)) {
          add(`headers.${name}`, Buffer.from(`${name}: ${value}`));
        }
        if (record.type === "request" && record.body !== undefined) {
          add("body", Buffer.from(record.body, "base64"), record.headers["content-encoding"]);
        }
        break;
      case "frame-sent":
      case "frame-received":
        add("payload", Buffer.from(record.payload, record.base64 ? "base64" : "utf8"));
        break;
      case "requestfailed":
        add("failure", Buffer.from(record.failure));
        break;
    }
  });
  return captures;
}

/** A slice of a log file: its whole lines from `start`, and the line number of the first one. */
export interface LogSlice {
  lines: string[];
  /** 1-based. */
  firstLine: number;
}

/**
 * The whole lines of `log` that begin at or after byte `start`. A line still being written (no
 * newline yet) is left out, as is the rest of a line that began before `start`: both belong to
 * a scan that sees the full log, such as the run-level sweep.
 */
export function logSlice(log: Buffer, start = 0): LogSlice {
  let from = Math.min(start, log.length);
  if (from > 0 && log[from - 1] !== 0x0a) {
    const next = log.indexOf(0x0a, from);
    from = next === -1 ? log.length : next + 1;
  }
  const end = log.lastIndexOf(0x0a) + 1;
  let firstLine = 1;
  for (let at = log.indexOf(0x0a); at !== -1 && at < from; at = log.indexOf(0x0a, at + 1)) {
    firstLine++;
  }
  const text = end > from ? log.subarray(from, end - 1).toString("utf8") : undefined;
  return { lines: text === undefined ? [] : text.split("\n"), firstLine };
}

/** One capture per line of a log slice, at points such as `observations/run/server.stdout.log:7`. */
export function logCaptures(file: string, slice: LogSlice): Capture[] {
  return slice.lines.map((line, index) => ({
    point: `${file}:${slice.firstLine + index}`,
    bytes: Buffer.from(line),
  }));
}
