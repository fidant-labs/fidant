import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { repoRoot, runDir } from "../paths.ts";
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
  const stdoutLog = createWriteStream(join(runDir, "server.stdout.log"));
  const stderrLog = createWriteStream(join(runDir, "server.stderr.log"));
  const child = spawn(process.execPath, [serverMain], {
    cwd: repoRoot,
    env: { ...process.env, PORT: "0", CERT_DIR: certDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdoutLog);
  child.stderr.pipe(stderrLog);

  // Backstop: if the runner exits without calling stop(), do not leave the server behind.
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);

  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      await terminate(child);
      process.off("exit", killOnExit);
      await Promise.all([closeLog(stdoutLog), closeLog(stderrLog)]);
      await rm(certDir, { recursive: true, force: true });
    })();
    return stopped;
  };

  const stderrTail: string[] = [];
  try {
    const port = await waitForPort(child, stderrTail);
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

/** SIGTERM, then SIGKILL if the process is still alive after the grace period. */
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
  await exited;
  clearTimeout(timer);
}

function closeLog(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}
