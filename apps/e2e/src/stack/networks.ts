import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { e2eDir, repoRoot, runDir } from "../paths.ts";
import { coturnConfig } from "./coturn.ts";
import { startServer } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

// The simulated networks of networks/compose.yaml, and the server on their public network.

const run = promisify(execFile);
const compose = ["compose", "-f", join(e2eDir, "networks", "compose.yaml")];
const serverName = "sigill-e2e-server";
/** The server's address on the public network, where the browsers reach it. */
export const serverIp = "198.51.100.10";
export const turnIp = "198.51.100.20";
// node:26-bookworm, not slim: the server's certificate step shells out to openssl.
const serverImage =
  "node:26.13.1-bookworm@sha256:0a7c0471c10988ef5ab64718fa58bf8d5be578b4d20cf42b10b5fa6ccda39ae1";
const repo = repoRoot.replace(/\/$/, "");

/** The `playwright run-server` of each browser container, published on the host. */
export const remoteBrowsers = {
  a1: "ws://127.0.0.1:39011/",
  a2: "ws://127.0.0.1:39012/",
  b1: "ws://127.0.0.1:39021/",
} as const;

export type RouterMode = "cone" | "symmetric" | "udp-blocked" | "tcp-443" | "lossy";

/** Switches a router to a mode of networks/router.sh. Existing NAT mappings are dropped. */
export async function routerMode(router: "router-a" | "router-b", mode: RouterMode): Promise<void> {
  await run("docker", [...compose, "exec", "-T", router, "/net/router.sh", mode]);
}

/** Freezes coturn, so STUN and TURN get no answer, as if the relay were down. */
export async function pauseRelay(): Promise<void> {
  await run("docker", [...compose, "pause", "coturn"]);
}

/** Undoes pauseRelay. Does nothing when coturn is not paused. */
export async function resumeRelay(): Promise<void> {
  const { stdout } = await run("docker", [
    ...compose,
    "ps",
    "-a",
    "--format",
    "{{.State}}",
    "coturn",
  ]);
  if (stdout.trim() === "paused") {
    await run("docker", [...compose, "unpause", "coturn"]);
  }
}

/** Sends `payload` from router-a to coturn's port in UDP datagrams, for the leak self-test. */
export async function sendToRelay(payload: Uint8Array): Promise<void> {
  const sending = run("docker", [
    ...compose,
    "exec",
    "-T",
    "router-a",
    "nc",
    "-u",
    "-w1",
    turnIp,
    "3478",
  ]);
  sending.child.stdin?.end(payload);
  await sending;
}

/** Fails at once with a clear message when Docker or Compose v2 is missing or not running. */
export function assertDocker(): void {
  try {
    execFileSync("docker", ["compose", "ls", "-q"], { stdio: "ignore", timeout: 15_000 });
  } catch {
    throw new Error(
      "pnpm e2e:networks needs Docker with Compose v2. Start Docker or install Compose.",
    );
  }
}

/** Removes the server container and everything compose made. Synchronous, so it can run on exit. */
function down(): void {
  execFileSync("docker", ["rm", "-f", serverName], { stdio: "ignore" });
  execFileSync("docker", [...compose, "down", "-t", "2", "--remove-orphans"], { stdio: "ignore" });
}

/**
 * The routers, browser containers and coturn of networks/compose.yaml. It hands the server
 * TURN_URLS for coturn at 198.51.100.20, with a secret made for this run.
 */
export const dockerNetworks: Service = { name: "networks", start: startNetworks };

async function startNetworks(): Promise<RunningService> {
  const dir = await mkdtemp(join(tmpdir(), "sigill-e2e-coturn-"));
  const secret = randomBytes(32).toString("hex");
  const secretFile = join(dir, "secret");
  await writeFile(secretFile, secret, { mode: 0o600 });
  // The config dir is mounted read-only, so coturn keeps its state in the container's /tmp.
  // Like production (apps/infra/box/turnserver.conf), deny the private site ranges as peers.
  // The public network has no route to them. Without this, coturn closed allocations right after
  // Chrome checked a private peer through them ("reason: general"), and relayed rows failed at random.
  const config = `${coturnConfig({ ip: turnIp, port: 3478, secret, stateDir: "/tmp" })}denied-peer-ip=10.0.0.0-10.255.255.255\n`;
  await writeFile(join(dir, "turnserver.conf"), config, { mode: 0o600 });

  const playwright = join(e2eDir, "node_modules", "@playwright", "test", "package.json");
  // Every compose command needs these, including `exec` from the test workers, which inherit them.
  Object.assign(process.env, {
    PLAYWRIGHT_VERSION: JSON.parse(readFileSync(playwright, "utf8")).version,
    SIGILL_E2E_REPO: repo,
    SIGILL_E2E_RUN_DIR: runDir,
    SIGILL_E2E_COTURN_DIR: dir,
    SIGILL_E2E_UID: String(process.getuid?.() ?? 1000),
    SIGILL_E2E_GID: String(process.getgid?.() ?? 1000),
  });

  const cleanUp = () => {
    try {
      down();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  // Backstop for a run that ends without global teardown.
  process.once("exit", cleanUp);
  const stop = async () => {
    process.off("exit", cleanUp);
    cleanUp();
  };

  try {
    // Left over from a run that was killed.
    down();
    await run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "120"]);
    // Pulled here, so the server's start timeout does not include a download.
    await run("docker", ["image", "inspect", serverImage]).catch(() =>
      run("docker", ["pull", "--quiet", serverImage]),
    );
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    name: "networks",
    env: {
      TURN_URLS: [
        `stun:${turnIp}:3478`,
        `turn:${turnIp}:3478?transport=udp`,
        `turn:${turnIp}:3478?transport=tcp`,
      ].join(","),
      TURN_SECRET_FILE: secretFile,
    },
    stop,
  };
}

/**
 * The server in a container at 198.51.100.10 on the public network, where the browsers reach it
 * through their routers. The host does not need to reach it: it reads the port from the output.
 */
export const dockerServer: Service = {
  name: "server",
  start: (env) =>
    startServer(env, {
      host: serverIp,
      command: (certDir) => {
        const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
        const secretDir = dirname(env.TURN_SECRET_FILE ?? "");
        // --init: the server has no SIGTERM handler, and as PID 1 it would ignore one.
        // ponytail: one server container at a time; a second run on this machine replaces it.
        return [
          "docker",
          "run",
          "--rm",
          "--init",
          "--name",
          serverName,
          "--network",
          "sigill-e2e-public",
          "--ip",
          serverIp,
          "--user",
          user,
          "-v",
          `${repo}:${repo}:ro`,
          "-v",
          `${certDir}:${certDir}`,
          "-v",
          `${secretDir}:${secretDir}:ro`,
          "-w",
          repo,
          "-e",
          "PORT",
          "-e",
          "CERT_DIR",
          "-e",
          "TURN_URLS",
          "-e",
          "TURN_SECRET_FILE",
          serverImage,
          "node",
        ];
      },
    }),
};
