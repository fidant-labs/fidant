import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Request, Response, WebSocket } from "@playwright/test";
import { isStackHost } from "./hosts.ts";
import {
  type BlockedRecord,
  type Headers,
  type ObservationRecord,
  stripFragment,
} from "./observations.ts";

const now = () => new Date().toISOString();

/**
 * Records one browser context's traffic and blocks every host outside the stack.
 * Records keep event order. Header lookups are async, so each record is a promise that
 * `write()` awaits before anything is written.
 */
export class Recorder {
  readonly actor: string;
  /** Requests and sockets that were aborted because they left the stack, in order. */
  readonly blocked: BlockedRecord[] = [];
  #records: Promise<ObservationRecord>[] = [];
  #stackOrigins: readonly string[];

  constructor(actor: string, stackOrigins: readonly string[]) {
    this.actor = actor;
    this.#stackOrigins = stackOrigins;
  }

  /** Attaches the listeners and routes. Call it before the context opens any page. */
  async attach(context: BrowserContext): Promise<void> {
    context.on("request", (request) => this.#add(requestRecord(request)));
    context.on("response", (response) => this.#add(responseRecord(response)));
    context.on("requestfailed", (request) =>
      this.#add({
        type: "requestfailed",
        time: now(),
        url: stripFragment(request.url()),
        failure: request.failure()?.errorText ?? "unknown",
      }),
    );
    for (const page of context.pages()) this.#watchPage(page);
    context.on("page", (page) => this.#watchPage(page));

    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (isStackHost(url, this.#stackOrigins)) return route.continue();
      this.#block(url, "http");
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, (ws) => {
      const url = ws.url();
      if (isStackHost(url, this.#stackOrigins)) {
        // Without handlers, Playwright forwards every message both ways. The page still opens a
        // real socket, so the page's `websocket` event records the frames.
        ws.connectToServer();
        return;
      }
      this.#block(url, "websocket");
      return ws.close({ code: 1008, reason: "Blocked: outside the local stack" });
    });
  }

  /** Every record so far, once its headers are resolved. */
  records(): Promise<ObservationRecord[]> {
    return Promise.all(this.#records);
  }

  /** Writes the records as JSON lines to `<dir>/<actor>.jsonl`. */
  async write(dir: string): Promise<void> {
    const records = await this.records();
    await mkdir(dir, { recursive: true });
    const lines = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    await writeFile(join(dir, `${this.actor}.jsonl`), lines);
  }

  #add(record: ObservationRecord | Promise<ObservationRecord>): void {
    this.#records.push(Promise.resolve(record));
  }

  #block(url: string, kind: BlockedRecord["kind"]): void {
    const record: BlockedRecord = { type: "blocked", time: now(), url: stripFragment(url), kind };
    this.blocked.push(record);
    this.#add(record);
  }

  #watchPage(page: Page): void {
    page.on("websocket", (ws) => this.#watchSocket(ws));
  }

  #watchSocket(ws: WebSocket): void {
    const url = stripFragment(ws.url());
    this.#add({ type: "websocket-open", time: now(), url });
    ws.on("framesent", ({ payload }) => this.#add(frameRecord("frame-sent", url, payload)));
    ws.on("framereceived", ({ payload }) => this.#add(frameRecord("frame-received", url, payload)));
    ws.on("close", () => this.#add({ type: "websocket-close", time: now(), url }));
  }
}

async function requestRecord(request: Request): Promise<ObservationRecord> {
  const time = now();
  return {
    type: "request",
    time,
    method: request.method(),
    url: stripFragment(request.url()),
    headers: await headersOf(request.allHeaders(), request.headers()),
  };
}

async function responseRecord(response: Response): Promise<ObservationRecord> {
  const time = now();
  return {
    type: "response",
    time,
    url: stripFragment(response.url()),
    status: response.status(),
    headers: await headersOf(response.allHeaders(), response.headers()),
  };
}

/** All headers, or the provisional ones if the browser no longer has the full set. */
async function headersOf(all: Promise<Headers>, provisional: Headers): Promise<Headers> {
  try {
    return await all;
  } catch {
    return provisional;
  }
}

function frameRecord(
  type: "frame-sent" | "frame-received",
  url: string,
  payload: string | Buffer,
): ObservationRecord {
  return typeof payload === "string"
    ? { type, time: now(), url, payload }
    : { type, time: now(), url, payload: payload.toString("base64"), base64: true };
}
