import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, createWriteStream, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { repoRoot, runDir, serverPidFile, serverStderrLog, serverStdoutLog } from "../paths.ts";
import { parsePort } from "./port.ts";
import type { RunningService, Service } from "./service.ts";

const serverMain = join(repoRoot, "apps", "server", "src", "main.ts");
const startTimeoutMs = 15_000;
const stopTimeoutMs = 5_000;
const restartTimeoutMs = 20_000;
const tailLines = 20;

/** The Sigill server on a free port with a throwaway certificate. */
export const server: Service = { name: "server", start: (env) => startServer(env) };

/** Runs the server elsewhere, such as in a container, and names the host it is reached at. */
export interface ServerWrapper {
  host: string;
  /** The command that runs `node` there, given the certificate directory to share with it. */
  command(certDir: string): string[];
}

export async function startServer(
  stackEnv: Readonly<Record<string, string>>,
  wrapper?: ServerWrapper,
): Promise<RunningService> {
  const certDir = await mkdtemp(join(tmpdir(), "sigill-e2e-certs-"));
  const stdoutLog = createWriteStream(serverStdoutLog);
  const stderrLog = createWriteStream(serverStderrLog);
  const [command, ...args] = [...(wrapper?.command(certDir) ?? [process.execPath]), serverMain];
  // Settles once every server run so far has closed, so no output can arrive after stop().
  let closed = Promise.resolve();
  const spawnChild = (port: number): ChildProcess => {
    const child = spawn(command as string, args, {
      cwd: repoRoot,
      env: { ...process.env, ...stackEnv, PORT: String(port), CERT_DIR: certDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A restarted server appends to the same logs, so the leak checks cover both runs. stop()
    // ends them; waiting for `close` first means every chunk has been written to them.
    child.stdout?.pipe(stdoutLog, { end: false });
    child.stderr?.pipe(stderrLog, { end: false });
    const previous = closed;
    closed = new Promise<void>((resolve) => child.once("close", () => resolve())).then(
      () => previous,
    );
    return child;
  };
  let child = spawnChild(0);

  // Backstop: if the runner exits without calling stop(), do not leave the server or its
  // certificate behind. Only synchronous work runs inside an exit handler.
  const cleanUpOnExit = () => {
    child.kill("SIGKILL");
    rmSync(certDir, { recursive: true, force: true });
  };
  process.once("exit", cleanUpOnExit);

  const event = (line: string) => {
    appendFileSync(join(runDir, "stack-events.log"), `${new Date().toISOString()} ${line}\n`);
    console.error(`[e2e stack] ${line}`);
  };

  /**
   * Once the server listens: on the local stack, publish its PID for restartServer() and, like
   * systemd's Restart=always, start it again on the same port when something SIGTERMs it.
   */
  const watch = (port: number) => {
    if (!wrapper && child.pid !== undefined) {
      writeFileSync(serverPidFile, String(child.pid));
    }
    child.once("exit", (code, signal) => {
      if (stopped) {
        return;
      }
      if (wrapper || signal !== "SIGTERM") {
        event(`server exited unexpectedly (code ${code}, signal ${signal})`);
        return;
      }
      child = spawnChild(port);
      waitForPort(child, []).then(
        () => {
          event("server restarted");
          watch(port);
        },
        (error: Error) => stopped || event(`server did not restart: ${error.message}`),
      );
    });
  };

  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      if (child.pid !== undefined) {
        await terminate(child, closed);
      }
      stdoutLog.end();
      stderrLog.end();
      await Promise.all([finished(stdoutLog), finished(stderrLog)]);
      process.off("exit", cleanUpOnExit);
      await rm(certDir, { recursive: true, force: true });
    })();
    return stopped;
  };

  const stderrTail: string[] = [];
  try {
    const port = await waitForPort(child, stderrTail);
    watch(port);
    // The origin, so port 443 drops out of the URL as it does in the browser's.
    const url = new URL(`https://${wrapper?.host ?? "localhost"}:${port}`).origin;
    return { name: "server", url, port, stop };
  } catch (error) {
    await stop();
    const tail = stderrTail.length > 0 ? stderrTail.join("\n") : "(no stderr output)";
    throw new Error(`${(error as Error).message}\nServer stderr (last lines):\n${tail}`);
  }
}

/**
 * For specs: SIGTERMs the local stack's server and resolves once its replacement listens on the
 * same port. Browsers see their signaling sockets drop and the server forget every link.
 */
export async function restartServer(): Promise<void> {
  const before = await readFile(serverPidFile, "utf8");
  process.kill(Number(before), "SIGTERM");
  const deadline = Date.now() + restartTimeoutMs;
  for (;;) {
    const pid = await readFile(serverPidFile, "utf8");
    if (pid !== before && /^\d+$/.test(pid)) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`The server did not restart within ${restartTimeoutMs} ms.`);
    }
    await sleep(100);
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
      if (port !== undefined) {
        finish(undefined, port);
      }
    };
    const finish = (error?: Error, port?: number) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) {
        reject(error);
      } else {
        resolve(port as number);
      }
    };

    child.once("exit", onExit);
    child.once("error", onError);
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", onLine);
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on("line", (line) => {
        stderrTail.push(line);
        if (stderrTail.length > tailLines) {
          stderrTail.shift();
        }
        onLine(line);
      });
    }
  });
}

/**
 * SIGTERM, then SIGKILL if the process is still alive after the grace period. Resolves on
 * `close`, once the process has exited and its stdout and stderr are drained.
 */
export async function terminate(child: ChildProcess, closed: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    timer = setTimeout(() => child.kill("SIGKILL"), stopTimeoutMs);
  }
  await closed;
  clearTimeout(timer);
}
