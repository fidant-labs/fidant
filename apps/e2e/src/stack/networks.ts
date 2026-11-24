import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { e2eDir, repoRoot, runDir } from "../paths.ts";
import { boxFiles } from "./box.ts";
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
/** coturn's name for TURN over TLS. Browsers resolve it to turnIp (playwright.config.ts). */
export const turnHost = "turn.sigill.test";
/** The POC box container, which the browsers reach as fidant.se and turn.fidant.se. */
export const boxIp = "198.51.100.30";
export const boxOrigin = "https://fidant.se";
// node:26-bookworm, not slim: the server's certificate step shells out to openssl.
// box/Dockerfile copies its node binary.
export const serverImage =
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

/** Runs a command in the box container and returns its stdout. */
export async function inBox(...command: string[]): Promise<string> {
  const { stdout } = await run("docker", [...compose, "exec", "-T", "box", ...command], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Every address of the browsers' network namespaces and their routers, as the box may see them. */
export async function clientAddresses(): Promise<string[]> {
  const { stdout: ids } = await run("docker", [
    ...compose,
    "ps",
    "-q",
    "net-a1",
    "net-a2",
    "net-b1",
    "router-a",
    "router-b",
  ]);
  const { stdout } = await run("docker", [
    "inspect",
    "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
    ...ids.split("\n").filter(Boolean),
  ]);
  return stdout.split(/\s+/).filter(Boolean);
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
 * The routers, browser containers, coturn and the box of networks/compose.yaml. It hands the
 * server TURN_URLS for coturn at 198.51.100.20, with a secret made for this run, which the box
 * shares.
 */
export const dockerNetworks: Service = { name: "networks", start: startNetworks };

async function startNetworks(): Promise<RunningService> {
  const dir = await mkdtemp(join(tmpdir(), "sigill-e2e-coturn-"));
  const secret = randomBytes(32).toString("hex");
  const secretFile = join(dir, "secret");
  await writeFile(secretFile, secret, { mode: 0o600 });
  // The config dir is mounted read-only, so coturn keeps its state in the container's /tmp.
  // Production's peer denials stay, 10/8 among them: the public network has no route to the private
  // sites, and without the denial coturn closed allocations right after Chrome checked a private
  // peer through them ("reason: general"), and relayed rows failed at random.
  // A self-signed certificate for TURN over TLS on 443, made per run. Chrome checks it, so the
  // browsers trust its public key alone (SIGILL_E2E_TURN_SPKI, read by playwright.config.ts).
  await run("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-days", "1", "-subj", `/CN=${turnHost}`],
    // turn.fidant.se too: the box's coturn serves the same pair, so one public key covers both.
    ...["-addext", `subjectAltName=DNS:${turnHost},DNS:turn.fidant.se,IP:${turnIp}`],
    ...["-keyout", join(dir, "turn.key"), "-out", join(dir, "turn.crt")],
  ]);
  const spki = new X509Certificate(await readFile(join(dir, "turn.crt"))).publicKey.export({
    type: "spki",
    format: "der",
  });
  const tls = { port: 443, cert: "/etc/sigill/turn.crt", pkey: "/etc/sigill/turn.key" };
  const config = coturnConfig({ ip: turnIp, port: 3478, secret, stateDir: "/tmp", tls });
  await writeFile(join(dir, "turnserver.conf"), config, { mode: 0o600 });
  const boxDir = await mkdtemp(join(tmpdir(), "sigill-e2e-box-"));
  const turnCert = {
    cert: await readFile(join(dir, "turn.crt"), "utf8"),
    key: await readFile(join(dir, "turn.key"), "utf8"),
  };
  for (const [path, file] of boxFiles({ ip: boxIp, secret, turnCert })) {
    const target = join(boxDir, path);
    // The user data makes /etc/sigill with mode 700; the other directories are the default 755.
    await mkdir(dirname(target), {
      recursive: true,
      mode: path.startsWith("/etc/sigill/") ? 0o700 : 0o755,
    });
    await writeFile(target, file.content, { mode: file.mode });
  }

  const playwright = join(e2eDir, "node_modules", "@playwright", "test", "package.json");
  // Every compose command needs these, including `exec` from the test workers, which inherit them.
  Object.assign(process.env, {
    PLAYWRIGHT_VERSION: JSON.parse(readFileSync(playwright, "utf8")).version,
    SIGILL_E2E_REPO: repo,
    SIGILL_E2E_RUN_DIR: runDir,
    SIGILL_E2E_COTURN_DIR: dir,
    SIGILL_E2E_BOX_DIR: boxDir,
    SIGILL_E2E_UID: String(process.getuid?.() ?? 1000),
    SIGILL_E2E_GID: String(process.getgid?.() ?? 1000),
    // Workers start after global setup and inherit it, like SIGILL_E2E_BASE_URL.
    SIGILL_E2E_TURN_SPKI: createHash("sha256").update(spki).digest("base64"),
  });

  const cleanUp = () => {
    try {
      down();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(boxDir, { recursive: true, force: true });
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
    // Not the stack's server, which is serverImage's container; only an origin the browser may reach.
    url: boxOrigin,
    env: {
      TURN_URLS: [
        `stun:${turnIp}:3478`,
        `turn:${turnIp}:3478?transport=udp`,
        // By name, as in production, so Chrome sends SNI.
        `turns:${turnHost}:443?transport=tcp`,
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
          // On 443, the one port the tcp-443 router mode lets out. Namespaced, so the server can
          // bind it without root.
          "--sysctl",
          "net.ipv4.ip_unprivileged_port_start=0",
          "-v",
          `${repo}:${repo}:ro`,
          "-v",
          `${certDir}:${certDir}`,
          "-v",
          `${secretDir}:${secretDir}:ro`,
          "-w",
          repo,
          "-e",
          "PORT=443",
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
