import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { repoRoot, runDir, serverStderrLog, serverStdoutLog } from "../paths.ts";
import { parsePort } from "./port.ts";
import type { RunningService, Service } from "./service.ts";

const serverMain = join(repoRoot, "apps", "server", "src", "main.ts");
const startTimeoutMs = 15_000;
const stopTimeoutMs = 5_000;
const tailLines = 20;

/** The Sigill server on a free port with a throwaway certificate. */
export const server: Service = { name: "server", start: startServer };

async function startServer(): Promise<RunningService> {
  const certDir = await mkdtemp(join(tmpdir(), "sigill-e2e-certs-"));
  const stdoutLog = createWriteStream(serverStdoutLog);
  const stderrLog = createWriteStream(serverStderrLog);
  const child = spawn(process.execPath, [serverMain], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0", CERT_DIR: certDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // pipe() ends each log once the child's stream ends, so waiting for `close` drains them.
  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

  // Backstop: if the runner exits without calling stop(), do not leave the server or its
  // certificate behind. Only synchronous work runs inside an exit handler.
  const cleanUpOnExit = () => {
    child.kill("SIGKILL");
    rmSync(certDir, { recursive: true, force: true });
  };
  process.once("exit", cleanUpOnExit);

  const onUnexpectedExit = (code: number | null, signal: string | null) => {
    const line = `server exited unexpectedly (code ${code}, signal ${signal})`;
    appendFileSync(join(runDir, "stack-events.log"), `${new Date().toISOString()} ${line}\n`);
    console.error(`[e2e stack] ${line}`);
  };

  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      child.off("exit", onUnexpectedExit);
      if (child.pid === undefined) {
        // The spawn itself failed: there is no process to wait for, and pipe() never ends the logs.
        stdoutLog.end();
        stderrLog.end();
      } else {
        await terminate(child, closed);
      }
      await Promise.all([finished(stdoutLog), finished(stderrLog)]);
      process.off("exit", cleanUpOnExit);
      await rm(certDir, { recursive: true, force: true });
    })();
    return stopped;
  };

  const stderrTail: string[] = [];
  try {
    const port = await waitForPort(child, stderrTail);
    child.once("exit", onUnexpectedExit);
    return { name: "server", url: `https://localhost:${port}`, port, stop };
  } catch (error) {
    await stop();
    const tail = stderrTail.length > 0 ? stderrTail.join("\n") : "(no stderr output)";
    throw new Error(`${(error as Error).message}\nServer stderr (last lines):\n${tail}`);
  }
}

/** Resolves with the port from the first stdout or stderr line that names it. */
function waitForPort(child: ChildProcess, stderrTail: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`The server did not report a port within ${startTimeoutMs} ms.`)),
      startTimeoutMs,
    );
    const onExit = (code: number | null, signal: string | null) =>
      finish(new Error(`The server exited before listening (code ${code}, signal ${signal}).`));
    const onError = (error: Error) => finish(error);
    const onLine = (line: string) => {
      const port = parsePort(line);
      if (port !== undefined) finish(undefined, port);
    };
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(port as number);
    };

    child.once("exit", onExit);
    child.once("error", onError);
    if (child.stdout) createInterface({ input: child.stdout }).on("line", onLine);
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        stderrTail.push(line);
        if (stderrTail.length > tailLines) stderrTail.shift();
        onLine(line);
      });
    }
  });
}

/**
 * SIGTERM, then SIGKILL if the process is still alive after the grace period. Resolves on
 * `close`, once the process has exited and its stdout and stderr are drained.
 */
async function terminate(child: ChildProcess, closed: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    timer = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
  }
  await closed;
  clearTimeout(timer);
}
