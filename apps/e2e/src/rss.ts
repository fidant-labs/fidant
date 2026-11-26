import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  rssBytes: number;
  command: string;
}

/** Parses `ps -A -o pid=,ppid=,rss=,comm=` output. RSS is in KiB; the command may contain spaces. */
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

/** The processes below `root` in the process tree, without `root` itself. */
export function descendants(processes: readonly ProcessInfo[], root: number): ProcessInfo[] {
  const children = Map.groupBy(processes, (info) => info.ppid);
  const found: ProcessInfo[] = [];
  const stack = [...(children.get(root) ?? [])];
  for (let info = stack.pop(); info; info = stack.pop()) {
    found.push(info);
    stack.push(...(children.get(info.pid) ?? []));
  }
  return found;
}

export interface RssWindow {
  baselineBytes: number;
  peakBytes: number;
  /** The most processes counted in one sample. */
  processes: number;
  samples: number;
}

/** Takes the summed RSS of the processes this one started, such as a worker's browser, as the baseline, then samples it every second until `end()`. */
export async function sampleRss(): Promise<{ end(): Promise<RssWindow> }> {
  const first = await treeRss();
  const window: RssWindow = {
    baselineBytes: first.bytes,
    peakBytes: first.bytes,
    processes: first.processes,
    samples: 1,
  };
  const sample = async () => {
    const { bytes, processes } = await treeRss();
    window.peakBytes = Math.max(window.peakBytes, bytes);
    window.processes = Math.max(window.processes, processes);
    window.samples++;
  };
  let sampling: Promise<void> | undefined;
  const timer = setInterval(() => {
    sampling ??= sample().finally(() => {
      sampling = undefined;
    });
  }, 1_000);
  return {
    async end() {
      clearInterval(timer);
      await sampling;
      await sample();
      return window;
    },
  };
}

async function treeRss(): Promise<{ bytes: number; processes: number }> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,rss=,comm="], {
    maxBuffer: 16 * 1024 * 1024,
  });
  // ps itself is a child of this process while it runs.
  const tree = descendants(parsePs(stdout), process.pid).filter(
    (info) => !/(^|\/)ps$/.test(info.command),
  );
  return { bytes: tree.reduce((sum, info) => sum + info.rssBytes, 0), processes: tree.length };
}
