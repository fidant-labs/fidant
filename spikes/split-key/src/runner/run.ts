// Drives the bench page in Chromium, Firefox and WebKit through Playwright.
//
// Builds the page, serves it with serve.ts on free 127.0.0.1 ports (loopback
// HTTP is a secure context, so no certificate), and per engine launches a
// fresh browser (a new persistent profile under the runs directory), runs the
// microbenchmarks once, then
// every size × sink × chunk size of the pipeline. Per run it samples the
// browser's RSS, waits for the page's download, checks its size and SHA-256
// against Node regenerating the seeded plaintext, deletes it and clears OPFS.
// Results go to <out>/<YYYY-MM-DD>-<engine>.json after every run, so an
// interrupted grid keeps what it measured; a summary table is printed at the
// end.
//
// The page contract: body[data-state] is idle, running, done or error, and
// #json holds { bench, version, environment, runs[] }. The runner waits for
// runs to grow and the state to settle, then reads the last run.
//
// fsa needs a save picker, which automation cannot answer, so the grid uses
// fsa-opfs (the same FileSystemWritableFileStream on an OPFS handle) for it.
// Contexts keep service workers enabled: the sw sink needs them.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  type BrowserContext,
  chromium,
  type Download,
  firefox,
  type Page,
  webkit,
} from "@playwright/test";
import type { PipelineRun } from "../bench/results.ts";
import {
  type AutomatableSink,
  type Engine,
  parseArgs,
  type RunnerArgs,
  runTimeoutMs,
  USAGE,
} from "./args.ts";
import { RssSampler, type RssWindow } from "./rss.ts";
import { type Verification, verifyDownload } from "./verify.ts";

const MIB = 1024 * 1024;
const spikeDir = resolve(import.meta.dirname, "../..");
const engines = { chromium, firefox, webkit };
/** How long a finished run may take to fire its download event. */
const DOWNLOAD_EVENT_TIMEOUT_MS = 30_000;
const MICRO_TIMEOUT_MS = 15 * 60_000;
const CLEAR_TIMEOUT_MS = 60_000;

type PageReport = { bench: string; version: number; environment: unknown; runs: unknown[] };

type RunRecord = {
  sink: AutomatableSink;
  size: number;
  chunkSize: number;
  /** The page's record of the run, as in its JSON. */
  page?: PipelineRun;
  download?: { suggestedFilename: string; verification: Verification };
  rss?: RssWindow;
  /** From the click to the verified download, in ms. */
  wallMs: number;
  /** Set when the runner, not the page, gave up: a timeout or a missing download. */
  runnerError?: string;
  pageErrors: string[];
};

type EngineReport = {
  bench: "fidant-split-key-runner";
  version: 1;
  engine: Engine;
  browserVersion: string;
  startedAt: string;
  args: Pick<RunnerArgs, "sizes" | "sinks" | "chunks" | "seed" | "microBytes" | "headed">;
  /** The page's environment block. */
  environment?: unknown;
  micro?: { page?: unknown; rss?: RssWindow; runnerError?: string };
  runs: RunRecord[];
  /** Summed browser RSS just after the page loaded, and the highest seen in any run. */
  rss: { baselineBytes: number | null; peakBytes: number | null };
};

// --- Setup ---

let args: RunnerArgs;
try {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  args = parseArgs(process.argv.slice(2), {
    outDir: join(spikeDir, "results"),
    runsDir: join(spikeDir, ".runs"),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exit(2);
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          done(address.port);
        } else {
          fail(new Error("no port"));
        }
      });
    });
  });
}

/** Starts serve.ts and resolves once it listens. Its LAN HTTPS listener is unused here. */
async function startServer(): Promise<{ child: ChildProcess; url: string }> {
  const httpPort = await freePort();
  const httpsPort = await freePort();
  const child = spawn(process.execPath, [join(spikeDir, "serve.ts")], {
    cwd: spikeDir,
    env: { ...process.env, BENCH_PORT: String(httpPort), BENCH_HTTPS_PORT: String(httpsPort) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((done, fail) => {
    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.includes("bench is running")) {
        done();
      }
    });
    child.once("exit", (code) => fail(new Error(`serve.ts exited with ${code}`)));
  });
  return { child, url: `http://127.0.0.1:${httpPort}/` };
}

// --- Page helpers ---

async function readReport(page: Page): Promise<PageReport> {
  return JSON.parse((await page.textContent("#json")) ?? "{}") as PageReport;
}

async function openBench(
  context: BrowserContext,
  url: string,
  pageErrors: string[],
): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  await page.goto(url);
  // The page writes the environment, sinks last, once it has probed the worker.
  await page.waitForFunction(() =>
    document.getElementById("json")?.textContent?.includes('"sinks"'),
  );
  return page;
}

/** Waits until the page has more than `before` runs and is no longer running. */
async function waitForRun(page: Page, before: number, timeout: number): Promise<void> {
  await page.waitForFunction(
    (count) => {
      const state = document.body.dataset.state;
      if (state !== "done" && state !== "error") {
        return false;
      }
      const report = JSON.parse(document.getElementById("json")?.textContent || "{}");
      return (report.runs?.length ?? 0) > count;
    },
    before,
    { timeout, polling: 250 },
  );
}

async function clearOpfs(page: Page): Promise<void> {
  await page.click("#clear-opfs");
  await page.waitForFunction(
    () =>
      document.body.dataset.state === "error" ||
      (document.body.dataset.state === "done" &&
        document.getElementById("status")?.textContent?.startsWith("OPFS cleared")),
    undefined,
    { timeout: CLEAR_TIMEOUT_MS, polling: 250 },
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves with the first download that `downloads` receives, polling it. */
async function nextDownload(downloads: Download[], timeout: number): Promise<Download> {
  const deadline = Date.now() + timeout;
  while (downloads.length === 0) {
    if (Date.now() > deadline) {
      throw new Error("the run finished but no download started");
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return downloads[0] as Download;
}

// --- Runs ---

async function runMicro(
  page: Page,
  sampler: RssSampler,
): Promise<NonNullable<EngineReport["micro"]>> {
  const before = (await readReport(page)).runs.length;
  await page.fill("#micro-mib", String(args.microBytes / MIB));
  await sampler.begin();
  try {
    await page.click("#micro-run");
    await waitForRun(page, before, MICRO_TIMEOUT_MS);
    const rss = await sampler.end();
    return { page: (await readReport(page)).runs.at(-1), ...(rss ? { rss } : {}) };
  } catch (error) {
    await sampler.end();
    return { runnerError: error instanceof Error ? error.message : String(error) };
  }
}

async function runPipeline(
  page: Page,
  sampler: RssSampler,
  downloads: Download[],
  run: RunRecord,
): Promise<void> {
  const presets = await page.$$eval("#pipe-size option", (options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  if (presets.includes(String(run.size))) {
    await page.selectOption("#pipe-size", String(run.size));
  } else {
    await page.selectOption("#pipe-size", "custom");
    await page.fill("#pipe-custom-mib", String(run.size / MIB));
  }
  await page.selectOption("#pipe-chunk", String(run.chunkSize));
  await page.check('input[name="pipe-source"][value="seeded"]');
  await page.fill("#pipe-seed", String(args.seed));
  await page.selectOption("#pipe-sink", run.sink);
  const before = (await readReport(page)).runs.length;
  downloads.length = 0;

  const timeout = runTimeoutMs(run.size);
  const started = performance.now();
  await sampler.begin();
  try {
    await page.click("#pipe-run");
    await waitForRun(page, before, timeout);
    run.page = (await readReport(page)).runs.at(-1) as PipelineRun;
    if (run.page.result?.outcome === "ok") {
      const download = await nextDownload(downloads, DOWNLOAD_EVENT_TIMEOUT_MS);
      // path() resolves once the browser has written the whole file.
      const path = await withTimeout(download.path(), timeout, "the download");
      const rss = await sampler.end();
      if (rss) {
        run.rss = rss;
      }
      run.download = {
        suggestedFilename: download.suggestedFilename(),
        verification: await verifyDownload(path, args.seed, run.size),
      };
    } else {
      const rss = await sampler.end();
      if (rss) {
        run.rss = rss;
      }
    }
  } catch (error) {
    await sampler.end();
    run.runnerError = firstLine(error);
  } finally {
    run.wallMs = performance.now() - started;
    // Remove every file this run left in the downloads directory, finished or not.
    for (const download of downloads.splice(0)) {
      await download.delete().catch(() => undefined);
    }
  }
}

/** Playwright errors carry a call log after the first line. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n", 1)[0] ?? message;
}

function outcome(run: RunRecord): string {
  if (run.runnerError) {
    return "runner-error";
  }
  const result = run.page?.result?.outcome ?? "missing";
  if (result !== "ok") {
    return result;
  }
  const verification = run.download?.verification;
  return verification?.sizeMatches && verification.sha256Matches ? "ok" : "mismatch";
}

function localDate(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

async function runEngine(engine: Engine, url: string, serverPid: number): Promise<EngineReport> {
  const downloadsDir = join(args.runsDir, engine, "downloads");
  const profileDir = join(args.runsDir, engine, "profile");
  await rm(join(args.runsDir, engine), { recursive: true, force: true });
  await mkdir(downloadsDir, { recursive: true });
  await mkdir(args.outDir, { recursive: true });
  const outFile = join(args.outDir, `${localDate()}-${engine}.json`);
  // A persistent profile, not launch()'s ephemeral context: WebKit has no OPFS
  // in an ephemeral session (getDirectory() fails with UnknownError). It is
  // fresh per engine and removed at the end.
  const context = await engines[engine].launchPersistentContext(profileDir, {
    headless: !args.headed,
    downloadsPath: downloadsDir,
    acceptDownloads: true,
  });
  const sampler = new RssSampler(engine, [serverPid]);
  sampler.start();
  const report: EngineReport = {
    bench: "fidant-split-key-runner",
    version: 1,
    engine,
    browserVersion: context.browser()?.version() ?? "unknown",
    startedAt: new Date().toISOString(),
    args: {
      sizes: args.sizes,
      sinks: args.sinks,
      chunks: args.chunks,
      seed: args.seed,
      microBytes: args.microBytes,
      headed: args.headed,
    },
    runs: [],
    rss: { baselineBytes: null, peakBytes: null },
  };
  const save = (): Promise<void> => writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  const notePeak = (window: RssWindow | undefined): void => {
    if (window) {
      report.rss.baselineBytes ??= window.baselineBytes;
      report.rss.peakBytes = Math.max(report.rss.peakBytes ?? 0, window.peakBytes);
    }
  };

  try {
    const downloads: Download[] = [];
    context.on("page", (page) => page.on("download", (download) => downloads.push(download)));
    let pageErrors: string[] = [];
    let page = await openBench(context, url, pageErrors);
    report.environment = (await readReport(page)).environment;

    if (args.microBytes > 0) {
      console.log(`${engine}: microbenchmarks, ${args.microBytes / MIB} MiB per stage`);
      report.micro = await runMicro(page, sampler);
      notePeak(report.micro.rss);
      await save();
    }

    for (const size of args.sizes) {
      for (const sink of args.sinks) {
        for (const chunkSize of args.chunks) {
          pageErrors.length = 0;
          const run: RunRecord = { sink, size, chunkSize, wallMs: 0, pageErrors };
          await runPipeline(page, sampler, downloads, run);
          run.pageErrors = [...pageErrors];
          if (run.runnerError) {
            // The page may be stuck mid-run: replace it before clearing OPFS.
            await page.close().catch(() => undefined);
            pageErrors = [];
            page = await openBench(context, url, pageErrors);
          }
          await clearOpfs(page).catch((error: unknown) => {
            run.runnerError ??= `clear OPFS: ${firstLine(error)}`;
          });
          notePeak(run.rss);
          report.runs.push(run);
          await save();
          console.log(summaryRow(engine, run).join("  "));
        }
      }
    }
  } finally {
    sampler.stop();
    await context.close().catch(() => undefined);
    await rm(join(args.runsDir, engine), { recursive: true, force: true });
  }
  console.log(`${engine}: wrote ${outFile}`);
  return report;
}

// --- Summary ---

const HEADER = [
  "engine",
  "sink",
  "size",
  "chunk",
  "outcome",
  "delivery",
  "enc MB/s",
  "dec MB/s",
  "wall s",
  "RSS base→peak MiB",
];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * MIB) {
    return `${bytes / (1024 * MIB)}GiB`;
  }
  return bytes >= MIB ? `${bytes / MIB}MiB` : `${bytes / 1024}KiB`;
}

function summaryRow(engine: Engine, run: RunRecord): string[] {
  const phases = run.page?.result?.phases ?? [];
  const rate = (name: string): string =>
    phases.find((phase) => phase.phase === name)?.mbPerSecond?.toFixed(0) ?? "–";
  const delivery = run.page
    ? `${run.page.delivery}${run.page.swTransport ? ` (${run.page.swTransport})` : ""}`
    : "–";
  const rss = run.rss
    ? `${(run.rss.baselineBytes / MIB).toFixed(0)}→${(run.rss.peakBytes / MIB).toFixed(0)}`
    : "–";
  return [
    engine,
    run.sink,
    formatSize(run.size),
    formatSize(run.chunkSize),
    outcome(run),
    delivery,
    rate("encrypt"),
    rate("decrypt"),
    (run.wallMs / 1000).toFixed(1),
    rss,
  ];
}

function printTable(rows: string[][]): void {
  const widths = HEADER.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    );
  }
}

function errorDetail(run: RunRecord): string | undefined {
  const error = run.page?.result?.error;
  if (run.runnerError) {
    return run.runnerError;
  }
  return error ? `${error.phase}: ${error.name}: ${error.message}` : undefined;
}

// --- Main ---

if (args.build) {
  const built = spawnSync(
    join(spikeDir, "node_modules/.bin/vite"),
    ["build", "--logLevel", "warn"],
    {
      cwd: spikeDir,
      stdio: "inherit",
    },
  );
  if (built.status !== 0) {
    console.error("vite build failed");
    process.exit(1);
  }
}

const server = await startServer();
const stopServer = (): void => {
  server.child.kill();
};
process.once("SIGINT", () => {
  stopServer();
  process.exit(130);
});

const reports: EngineReport[] = [];
try {
  for (const engine of args.engines) {
    try {
      reports.push(await runEngine(engine, server.url, server.child.pid ?? -1));
    } catch (error) {
      console.error(`${engine}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  stopServer();
  await rm(args.runsDir, { recursive: true, force: true });
}

console.log("");
printTable([
  HEADER,
  ...reports.flatMap((report) => report.runs.map((run) => summaryRow(report.engine, run))),
]);
console.log("");
for (const report of reports) {
  const { baselineBytes, peakBytes } = report.rss;
  const mib = (bytes: number | null): string => (bytes === null ? "–" : (bytes / MIB).toFixed(0));
  console.log(
    `${report.engine} ${report.browserVersion}: browser RSS ${mib(baselineBytes)} MiB after load, peak ${mib(peakBytes)} MiB`,
  );
  for (const run of report.runs) {
    const detail = errorDetail(run);
    if (detail) {
      console.log(`  ${run.sink} ${formatSize(run.size)}/${formatSize(run.chunkSize)}: ${detail}`);
    }
  }
}
