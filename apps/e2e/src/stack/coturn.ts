import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { coturnLog, repoRoot } from "../paths.ts";
import { terminate } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

const host = "127.0.0.1";
const startTimeoutMs = 10_000;
const missing = "coturn not found; brew install coturn (macOS) or apt-get install coturn";

/**
 * coturn on a free loopback port with a secret made for this run. It hands the server
 * TURN_URLS and TURN_SECRET_FILE. Without `turnserver` on PATH the stack runs without it,
 * except in CI, where that fails the run.
 */
export const coturn: Service = { name: "coturn", start: startCoturn };

async function startCoturn(): Promise<RunningService> {
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, "turnserver")));
  if (!onPath) {
    if (process.env.CI) {
      throw new Error(missing);
    }
    console.warn(`[e2e stack] ${missing}. Running without TURN.`);
    return { name: "coturn", env: {}, stop: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "sigill-e2e-coturn-"));
  const removeDir = () => rmSync(dir, { recursive: true, force: true });
  const port = await freePort();
  const secret = randomBytes(32).toString("hex");
  const secretFile = join(dir, "secret");
  const config = join(dir, "turnserver.conf");
  await writeFile(secretFile, secret, { mode: 0o600 });
  // In a config file rather than flags, so the secret does not show in `ps`.
  await writeFile(config, coturnConfig({ ip: host, port, secret, stateDir: dir }), { mode: 0o600 });

  const child = spawn("turnserver", ["-c", config], { cwd: dir, stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  const cleanUpOnExit = () => {
    child.kill("SIGKILL");
    removeDir();
  };
  process.once("exit", cleanUpOnExit);

  let stopped: Promise<void> | undefined;
  const stop = () => {
    stopped ??= (async () => {
      if (child.pid !== undefined) {
        await terminate(child, closed);
      }
      process.off("exit", cleanUpOnExit);
      await rm(dir, { recursive: true, force: true });
    })();
    return stopped;
  };

  try {
    await waitForListening(
      port,
      () => failed || child.exitCode !== null || child.signalCode !== null,
    );
  } catch (error) {
    await stop();
    throw new Error(`${(error as Error).message} See ${coturnLog}.`);
  }
  // The same shape as production's TURN_URLS (apps/infra/box/user-data.sh).
  const urls = [
    `stun:${host}:${port}`,
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`,
  ];
  return {
    name: "coturn",
    port,
    env: { TURN_URLS: urls.join(","), TURN_SECRET_FILE: secretFile },
    stop,
  };
}

/** Production's coturn config (apps/infra/box/turnserver.conf), which both e2e stacks start from. */
const productionConfig = readFileSync(
  join(repoRoot, "apps", "infra", "box", "turnserver.conf"),
  "utf8",
);

/** Production settings the e2e stacks replace, each with the reason. */
const replaced: Record<string, string> = {
  "listening-port": "each run picks its own port",
  realm: "production's has a template placeholder",
  "log-file": "tests read coturn's log, and the leak check scans it",
  "tls-listening-port": "a run with TLS sets its own port and certificate",
  cert: "a run with TLS sets its own port and certificate",
  pkey: "a run with TLS sets its own port and certificate",
};
/** Production peer denials the loopback stack drops, because every local peer is on loopback. */
const loopbackDenials = ["denied-peer-ip=127.0.0.0-127.255.255.255", "denied-peer-ip=::1"];

/**
 * turnserver.conf for coturn listening and relaying on `ip`: production's config, minus the lines
 * in `replaced` (and, on loopback, `loopbackDenials`), plus what a test run needs. Its pid file and
 * user database go in `stateDir`, and it logs verbosely to observations/run/coturn.log.
 */
export function coturnConfig(options: {
  ip: string;
  port: number;
  secret: string;
  stateDir: string;
  /** TURN over TLS on `port` with this certificate and key. Without it, coturn has no TLS. */
  tls?: { port: number; cert: string; pkey: string };
}): string {
  const { ip, port, secret, stateDir, tls } = options;
  const loopback = ip === host;
  const kept = productionConfig
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => !Object.hasOwn(replaced, line.split("=")[0] ?? ""))
    .filter((line) => !(loopback && loopbackDenials.includes(line)));
  const lines = [
    ...kept,
    `listening-ip=${ip}`,
    `relay-ip=${ip}`,
    `listening-port=${port}`,
    `static-auth-secret=${secret}`,
    "realm=sigill.local",
    ...(loopback ? ["allow-loopback-peers"] : []),
    // ponytail: the loopback stack keeps plain TURN over TCP; TLS is covered by the networks suite.
    ...(tls
      ? [`tls-listening-port=${tls.port}`, `cert=${tls.cert}`, `pkey=${tls.pkey}`]
      : ["no-tls"]),
    `pidfile=${join(stateDir, "turnserver.pid")}`,
    `userdb=${join(stateDir, "turndb")}`,
    `log-file=${coturnLog}`,
    "verbose",
  ];
  return `${lines.join("\n")}\n`;
}

/** A port that was free a moment ago. ponytail: racy, but nothing else picks ports here. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** Polls until the TCP port accepts a connection. */
async function waitForListening(port: number, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited()) {
      throw new Error("coturn exited before listening.");
    }
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, host);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`coturn did not listen on port ${port} within ${startTimeoutMs} ms.`);
}
