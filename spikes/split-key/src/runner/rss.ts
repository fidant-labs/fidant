// Resident memory of the browser under test, sampled from `ps` every 250 ms.
//
// Which processes count:
// - every descendant of the runner, except the bench server's subtree. Playwright
//   starts Chromium and Firefox as children of this process, and their helper
//   and content processes are their children.
// - processes whose parent is launchd (ppid 1) and whose executable lives in
//   Playwright's browser cache for this engine. On macOS, WebKit's WebContent,
//   Networking and GPU processes are XPC services that launchd starts, so they
//   are not descendants of the runner. Checked with Playwright WebKit 27.2
//   (webkit-2388): .../ms-playwright/webkit-2388/com.apple.WebKit.WebContent.xpc/
//   .../com.apple.WebKit.WebContent.Development, ppid 1. Another Playwright WebKit
//   running at the same time would be counted too.
//
// RSS summed over processes counts shared pages once per process, so the sum
// overstates the real footprint. It is still a fair measure of growth during a
// run: compare peak with the baseline taken just before.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Engine } from "./args.ts";

const run = promisify(execFile);

export type ProcessInfo = { pid: number; ppid: number; rssBytes: number; command: string };

/** Parses `ps -axo pid=,ppid=,rss=,comm=` output. RSS is in KiB; comm may contain spaces. */
export function parsePs(text: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match?.[1] && match[2] && match[3] && match[4]) {
      processes.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        command: match[4],
      });
    }
  }
  return processes;
}

/** The directory prefix of the engine's builds in Playwright's cache, e.g. ms-playwright/webkit-. */
function cachePattern(engine: Engine): RegExp {
  // Headless Chromium runs chromium_headless_shell-<rev>, headed chromium-<rev>.
  const name = engine === "chromium" ? "chromium(?:_headless_shell)?" : engine;
  return new RegExp(`/ms-playwright/${name}-\\d+/`);
}

/**
 * The processes of the browser under test: descendants of `rootPid` outside
 * the `excludePids` subtrees, plus launchd-started processes from the engine's
 * Playwright build and their descendants. `rootPid` itself is not included.
 */
export function browserProcesses(
  processes: ProcessInfo[],
  rootPid: number,
  excludePids: number[],
  engine: Engine,
): ProcessInfo[] {
  const children = new Map<number, ProcessInfo[]>();
  for (const info of processes) {
    const siblings = children.get(info.ppid);
    if (siblings) {
      siblings.push(info);
    } else {
      children.set(info.ppid, [info]);
    }
  }
  const excluded = new Set(excludePids);
  const pattern = cachePattern(engine);
  const roots = [
    ...(children.get(rootPid) ?? []),
    ...processes.filter((info) => info.ppid === 1 && pattern.test(info.command)),
  ];
  const found = new Map<number, ProcessInfo>();
  const stack = roots.filter((info) => !excluded.has(info.pid));
  while (stack.length > 0) {
    const info = stack.pop() as ProcessInfo;
    if (found.has(info.pid) || excluded.has(info.pid)) {
      continue;
    }
    found.set(info.pid, info);
    stack.push(...(children.get(info.pid) ?? []));
  }
  return [...found.values()];
}

export type RssWindow = {
  /** Summed RSS at the start of the window. */
  baselineBytes: number;
  /** Highest summed RSS seen during the window. */
  peakBytes: number;
  /** Most processes counted in one sample. */
  maxProcesses: number;
  samples: number;
};

/** Samples the browser's summed RSS in the background; read it in windows around each run. */
export class RssSampler {
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;
  private current: RssWindow | undefined;
  private last = 0;
  private readonly engine: Engine;
  private readonly excludePids: number[];
  private readonly intervalMs: number;

  constructor(engine: Engine, excludePids: number[], intervalMs = 250) {
    this.engine = engine;
    this.excludePids = excludePids;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Starts a new window with a fresh sample as its baseline. */
  async begin(): Promise<void> {
    const bytes = await this.read();
    this.current = { baselineBytes: bytes, peakBytes: bytes, maxProcesses: 0, samples: 1 };
  }

  /** Ends the window with one last sample and returns it. */
  async end(): Promise<RssWindow | undefined> {
    await this.sample();
    const window = this.current;
    this.current = undefined;
    return window;
  }

  private async sample(): Promise<void> {
    // A slow ps must not pile up samples behind it.
    if (this.sampling) {
      return;
    }
    this.sampling = true;
    try {
      const bytes = await this.read();
      if (this.current) {
        this.current.peakBytes = Math.max(this.current.peakBytes, bytes);
        this.current.samples++;
      }
    } catch {
      // A failed sample is skipped; the next one runs in 250 ms.
    } finally {
      this.sampling = false;
    }
  }

  private async read(): Promise<number> {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,rss=,comm="], {
      maxBuffer: 16 * 1024 * 1024,
    });
    // ps itself is a child of the runner while it runs.
    const processes = parsePs(stdout).filter((info) => !/(^|\/)ps$/.test(info.command));
    const tree = browserProcesses(processes, process.pid, this.excludePids, this.engine);
    const bytes = tree.reduce((sum, info) => sum + info.rssBytes, 0);
    if (this.current) {
      this.current.maxProcesses = Math.max(this.current.maxProcesses, tree.length);
    }
    this.last = bytes;
    return bytes;
  }

  /** The latest summed RSS. */
  get latestBytes(): number {
    return this.last;
  }
}
