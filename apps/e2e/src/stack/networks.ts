import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
// ponytail: relative import, not a workspace dependency on the server, for two small functions.
import { relaySecret, sealRelaySecret } from "../../../server/src/relay-secret.ts";
import { e2eDir, repoRoot, runDir } from "../paths.ts";
import { boxFiles } from "./box.ts";
import { coturnConfig } from "./coturn.ts";
import { startServer } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

// The simulated networks of networks/compose.yaml, and the server on their public network.

const run = promisify(execFile);
const composeFile = join(e2eDir, "networks", "compose.yaml");
const compose = [
  "compose",
  "-f",
  composeFile,
  ...(process.env.FIDANT_E2E_GHA_CACHE
    ? ["-f", join(e2eDir, "networks", "compose.gha-cache.yaml")]
    : []),
];
const serverName = "fidant-e2e-server";
/** The server's address on the public network, where the browsers reach it. */
export const serverIp = "198.51.100.10";
export const turnIp = "198.51.100.20";
/** coturn's name for TURN over TLS. Browsers resolve it to turnIp (playwright.config.ts). */
export const turnHost = "turn.fidant.test";
/** The POC box container, which the browsers reach as fidant.se and turn.fidant.se. */
export const boxIp = "198.51.100.30";
export const boxOrigin = "https://fidant.se";
/** The relay box container, set up by apps/infra/relay/install.sh. */
export const relayIp = "198.51.100.40";
export const relayHost = "sto.relay.fidant.test";
export const albIp = "198.51.100.50";
/** The pages CDN stand-in (networks/pages), which a test maps fidant.se to. */
export const pagesIp = "198.51.100.60";
/** The signaling image's name, from the web build's list. The browsers resolve it to albIp. */
export const signalHost = new URL(
  JSON.parse(readFileSync(join(repoRoot, "apps", "web", "signals.json"), "utf8"))[0].url,
).hostname;
/** The node stage of networks/box/Dockerfile, so Dependabot moves the server and the box together. */
export const serverImage =
  /^FROM (\S+) AS node$/m.exec(
    readFileSync(join(e2eDir, "networks", "box", "Dockerfile"), "utf8"),
  )?.[1] ??
  (() => {
    throw new Error("networks/box/Dockerfile has no `FROM <image> AS node` line");
  })();
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

/** router-a's address on the public network, which site B sees site A's browsers at. */
const routerAIp = "198.51.100.2";

/**
 * Drops UDP between site B and router-a, both ways, as when the route between two browsers goes
 * away. TCP, so signaling, and UDP to coturn go on. router-b keeps its mode and NAT mappings.
 */
export async function cutRoute(): Promise<void> {
  await run("docker", [...compose, "exec", "-T", "router-b", "/net/router.sh", "cut", routerAIp]);
}

/** Undoes cutRoute. Does nothing when the route is not cut. */
export async function restoreRoute(): Promise<void> {
  await run("docker", [...compose, "exec", "-T", "router-b", "/net/router.sh", "uncut", routerAIp]);
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

const edgePcap = "/tmp/edge.pcap";

/**
 * Starts capturing every packet on router-a's outside interface, site A's edge. `stop` ends the
 * capture and waits for tcpdump to exit; call it from a `finally`, it is safe to call twice.
 * `read` prints the packets that match a tcpdump filter, one per line, once it has stopped.
 */
export async function captureSiteA(): Promise<{
  stop: () => Promise<void>;
  read: (filter: string) => Promise<string[]>;
}> {
  const inRouter = (...command: string[]) =>
    run("docker", [...compose, "exec", "-T", "router-a", ...command]);
  const stop = () =>
    inRouter(
      "sh",
      "-c",
      "pkill -INT tcpdump; for i in $(seq 100); do pgrep tcpdump >/dev/null || exit 0; sleep 0.1; done; exit 1",
    ).then(() => undefined);
  // A file left from an earlier capture would pass the wait below before tcpdump starts.
  await inRouter("rm", "-f", edgePcap);
  await run("docker", [
    ...compose,
    "exec",
    "-d",
    "router-a",
    "/net/router.sh",
    "capture",
    edgePcap,
  ]);
  // tcpdump writes the file's header once it is capturing.
  try {
    await inRouter(
      "sh",
      "-c",
      `for i in $(seq 100); do test -s ${edgePcap} && exit 0; sleep 0.1; done; exit 1`,
    );
  } catch (error) {
    // The caller gets no stop() when this rejects, so tcpdump must not outlive it on the shared router.
    // A failed stop must not hide why the capture never started.
    await stop().catch((stopError) => {
      throw new AggregateError([error, stopError], "the edge capture never started");
    });
    throw error;
  }
  return {
    stop,
    read: async (filter) => {
      const { stdout } = await inRouter("tcpdump", "-r", edgePcap, "-nn", filter);
      return stdout.split("\n").filter(Boolean);
    },
  };
}

async function inService(service: "box" | "relay" | "signal", command: string[]): Promise<string> {
  const { stdout } = await run("docker", [...compose, "exec", "-T", service, ...command], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** Runs a command in the box container and returns its stdout. */
export const inBox = (...command: string[]) => inService("box", command);

/** Runs a command in the relay box container and returns its stdout. */
export const inRelay = (...command: string[]) => inService("relay", command);

/** Runs a command in the signaling container and returns its stdout. */
export const inSignal = (...command: string[]) => inService("signal", command);

export async function signalLogs(): Promise<string> {
  const { stdout } = await run("docker", [
    ...compose,
    ...["logs", "--no-color", "--no-log-prefix", "signal"],
  ]);
  return stdout;
}

const clientScript = `
const WebSocket = require(process.argv[1]);
const open = (options) => new Promise((done) => {
  const ws = new WebSocket(process.argv[2], { ...options, rejectUnauthorized: false });
  ws.on("open", () => done(101));
  ws.on("unexpected-response", (req, res) => { done(res.statusCode); req.destroy(); });
  ws.on("error", () => done(0));
});
(async () => {
  const codes = [];
  for (const options of JSON.parse(process.argv[3])) codes.push(await open(options));
  console.log(JSON.stringify(codes));
  process.stdin.on("end", () => process.exit(0)).resume();
})();
`;

// Each code is 101, the status of the refused upgrade, or 0 when the socket failed.
export async function signalClients(
  site: "a1" | "b1",
  count: number,
  options: { origin: string; agent: string; forwardedFor?: (index: number) => string },
): Promise<{ codes: number[]; release: () => Promise<void> }> {
  const sockets = Array.from({ length: count }, (_, index) => ({
    origin: options.origin,
    headers: {
      "user-agent": options.agent,
      ...(options.forwardedFor && { "x-forwarded-for": options.forwardedFor(index) }),
    },
  }));
  const child = spawn(
    "docker",
    [
      ...compose,
      ...["exec", "-T", `browser-${site}`, "node", "-e", clientScript],
      join(repo, "apps", "server", "node_modules", "ws"),
      `wss://${albIp}/signal`,
      JSON.stringify(sockets),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  const release = async () => {
    child.stdin.end();
    await exited;
  };
  const line = once(createInterface({ input: child.stdout }), "line");
  const [first] = await Promise.race([
    line,
    exited.then(([code]) => {
      throw new Error(`the signaling clients exited with ${code} before they answered`);
    }),
  ]);
  return { codes: JSON.parse(first) as number[], release };
}

/** Seals `secretHex` to the relay box's key and applies it there, as the app's hand-out will. */
export async function applyRelaySecret(secretHex: string): Promise<void> {
  const publicKey = await inRelay("cat", "/etc/fidant-relay/relay.pub");
  const applying = run("docker", [...compose, "exec", "-T", "relay", "fidant-relay-apply-secret"]);
  applying.child.stdin?.end(`${sealRelaySecret(publicKey, secretHex)}\n`);
  await applying;
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

// Must match `name:` in networks/compose.yaml (networks.test.ts checks).
export const projectName = "fidant-e2e";

/** One row of `docker compose ls --all --format json`. */
type Project = { Name: string; Status: string; ConfigFiles: string };

/**
 * Another checkout's networks run that has containers: its compose file, and whether all of them
 * are stopped. `Status` counts containers per state, like `running(9)`, `created(9)` while compose
 * creates them, or `running(2), exited(7)`. The server container needs no check of its own: it
 * starts after the project is up and stops before it.
 */
export function otherRun(
  projects: Project[],
  ownFile: string,
): { file: string; stopped: boolean } | undefined {
  const project = projects.find((p) => p.Name === projectName);
  const files = project?.ConfigFiles.split(",") ?? [];
  if (project && !files.includes(ownFile)) {
    const states = project.Status.split(",").map((state) => state.trim().replace(/\(\d+\)$/, ""));
    const stopped = states.every((state) => state === "exited" || state === "dead");
    return { file: files[0] || "an unknown checkout", stopped };
  }
  return undefined;
}

const removeCommand = `\`docker rm -f ${serverName}; docker compose -p ${projectName} down --remove-orphans\``;

/**
 * Waits while another checkout's networks run is going, and fails when one has only stopped
 * containers on two checks in a row, a dead run's, or still runs after `timeoutMs`. One check
 * isn't enough: a run's own teardown passes through stopped containers on its way out. Runs can't
 * overlap: they share container and network names, subnets and host ports, and setup removes what
 * it finds, which would kill the other run. This checkout's own leftovers are a killed run's, and
 * setup removes them. A run still building its images has no containers yet, so two runs started
 * together, or two waiting for the same run, can still both go ahead.
 */
export async function waitForOtherRun({
  list = listProjects,
  log = (line: string) => console.log(line),
  intervalMs = 10_000,
  logEveryMs = 30_000,
  timeoutMs = 15 * 60_000,
}: {
  list?: () => Project[];
  log?: (line: string) => void;
  intervalMs?: number;
  logEveryMs?: number;
  timeoutMs?: number;
} = {}): Promise<void> {
  const start = Date.now();
  let logged: number | undefined;
  let stoppedChecks = 0;
  for (;;) {
    const other = otherRun(list(), composeFile);
    const waited = Date.now() - start;
    if (!other) {
      if (logged !== undefined) {
        log(
          `The other pnpm e2e:networks run ended after ${Math.round(waited / 1000)} s; starting.`,
        );
      }
      return;
    }
    stoppedChecks = other.stopped ? stoppedChecks + 1 : 0;
    if (stoppedChecks >= 2) {
      throw new Error(
        `A pnpm e2e:networks run from ${other.file} left stopped containers, on two checks ${Math.round(intervalMs / 1000)} s apart, and runs on one machine can't overlap. Remove them with ${removeCommand}.`,
      );
    }
    if (waited >= timeoutMs) {
      throw new Error(
        `Another pnpm e2e:networks run, from ${other.file}, still runs after ${Math.round(timeoutMs / 60_000)} min of waiting. If it no longer runs, remove its containers with ${removeCommand}.`,
      );
    }
    if (logged === undefined || Date.now() - logged >= logEveryMs) {
      log(
        `Waiting for another pnpm e2e:networks run, from ${other.file}, to end: runs on one machine can't overlap (${Math.round(waited / 1000)} s so far, gives up after ${Math.round(timeoutMs / 60_000)} min).`,
      );
      logged = Date.now();
    }
    await sleep(intervalMs);
  }
}

function listProjects(): Project[] {
  return (
    JSON.parse(
      execFileSync("docker", ["compose", "ls", "--all", "--format", "json"], {
        encoding: "utf8",
        timeout: 15_000,
      }) || "[]",
    ) ?? []
  );
}

/** Removes the server container and everything compose made. Synchronous, so it can run on exit. */
function down(): void {
  execFileSync("docker", ["rm", "-f", serverName], { stdio: "ignore" });
  execFileSync("docker", [...compose, "down", "-t", "2", "--remove-orphans"], { stdio: "ignore" });
}

// The relay list is `net`, coturn at 198.51.100.20, then `sto`, the relay box, which has no secret until it fetches one.
export const dockerNetworks: Service = { name: "networks", start: startNetworks };

async function startNetworks(): Promise<RunningService> {
  const dir = await mkdtemp(join(tmpdir(), "fidant-e2e-coturn-"));
  // Made here: the server's mount is read-only, and coturn needs net's secret before it starts.
  const master = randomBytes(32).toString("hex");
  const masterFile = join(dir, "relay-master");
  await writeFile(masterFile, `${master}\n`, { mode: 0o600 });
  const secret = relaySecret(master, "net");
  const secretFile = join(dir, "secret");
  await writeFile(secretFile, secret, { mode: 0o600 });
  // net's key only lets the list parse: nothing fetches net's hand-out.
  const netKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  // Before any compose command, which all load signal's env file and need its relay list mounted.
  await writeFile(
    join(dir, "signal-relays.json"),
    JSON.stringify([
      {
        id: "net",
        urls: [`stun:${turnIp}:3478`, `turn:${turnIp}:3478?transport=udp`],
        publicKey: netKey,
      },
    ]),
  );
  await writeFile(join(dir, "signal.env"), `RELAY_MASTER=${master}\n`, { mode: 0o600 });
  // The config dir is mounted read-only, so coturn keeps its state in the container's /tmp.
  // Production's peer denials stay, 10/8 among them: the public network has no route to the private
  // sites, and without the denial coturn closed allocations right after Chrome checked a private
  // peer through them ("reason: general"), and relayed rows failed at random.
  // A self-signed certificate for TURN over TLS on 443, made per run. Chrome checks it, so the
  // browsers trust its public key alone (FIDANT_E2E_TURN_SPKI, read by playwright.config.ts).
  await run("openssl", [
    ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
    ...["-days", "1", "-subj", `/CN=${turnHost}`],
    // turn.fidant.se, the relay box, pages and alb too: they serve the same pair, so one public key covers all.
    ...[
      "-addext",
      `subjectAltName=DNS:${turnHost},DNS:turn.fidant.se,DNS:${relayHost},DNS:fidant.se,DNS:${signalHost},IP:${turnIp}`,
    ],
    ...["-keyout", join(dir, "turn.key"), "-out", join(dir, "turn.crt")],
  ]);
  const spki = new X509Certificate(await readFile(join(dir, "turn.crt"))).publicKey.export({
    type: "spki",
    format: "der",
  });
  const tls = { port: 443, cert: "/etc/fidant/turn.crt", pkey: "/etc/fidant/turn.key" };
  const config = coturnConfig({ ip: turnIp, port: 3478, secret, stateDir: "/tmp", tls });
  await writeFile(join(dir, "turnserver.conf"), config, { mode: 0o600 });
  const boxDir = await mkdtemp(join(tmpdir(), "fidant-e2e-box-"));
  const turnCert = {
    cert: await readFile(join(dir, "turn.crt"), "utf8"),
    key: await readFile(join(dir, "turn.key"), "utf8"),
  };
  for (const [path, file] of boxFiles({ ip: boxIp, secret, turnCert })) {
    const target = join(boxDir, path);
    // The user data makes /etc/fidant with mode 700; the other directories are the default 755.
    await mkdir(dirname(target), {
      recursive: true,
      mode: path.startsWith("/etc/fidant/") ? 0o700 : 0o755,
    });
    await writeFile(target, file.content, { mode: file.mode });
  }
  // The relay's install.sh inputs, and the run's TLS pair in place of a Let's Encrypt one.
  const relayDir = await mkdtemp(join(tmpdir(), "fidant-e2e-relay-"));
  await writeFile(
    join(relayDir, "env"),
    `RELAY_ID=sto\nRELAY_NAME=${relayHost}\nAPP_URL=https://${serverIp}\n`,
  );
  await mkdir(join(relayDir, "tls"));
  await writeFile(join(relayDir, "tls", "turn.crt"), turnCert.cert);
  await writeFile(join(relayDir, "tls", "turn.key"), turnCert.key, { mode: 0o600 });

  const pagesDir = await mkdtemp(join(tmpdir(), "fidant-e2e-pages-"));
  const playwright = join(e2eDir, "node_modules", "@playwright", "test", "package.json");
  // Every compose command needs these, including `exec` from the test workers, which inherit them.
  Object.assign(process.env, {
    PLAYWRIGHT_VERSION: JSON.parse(readFileSync(playwright, "utf8")).version,
    FIDANT_E2E_REPO: repo,
    FIDANT_E2E_RUN_DIR: runDir,
    FIDANT_E2E_COTURN_DIR: dir,
    FIDANT_E2E_BOX_DIR: boxDir,
    FIDANT_E2E_RELAY_DIR: relayDir,
    FIDANT_E2E_PAGES_DIR: pagesDir,
    FIDANT_E2E_UID: String(process.getuid?.() ?? 1000),
    FIDANT_E2E_GID: String(process.getgid?.() ?? 1000),
    // Workers start after global setup and inherit it, like FIDANT_E2E_BASE_URL.
    FIDANT_E2E_TURN_SPKI: createHash("sha256").update(spki).digest("base64"),
  });

  const cleanUp = () => {
    try {
      down();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(boxDir, { recursive: true, force: true });
      rmSync(relayDir, { recursive: true, force: true });
      rmSync(pagesDir, { recursive: true, force: true });
    }
  };
  // Backstop for a run that ends without global teardown.
  process.once("exit", cleanUp);
  const stop = async () => {
    process.off("exit", cleanUp);
    cleanUp();
  };

  const turnUrls = [
    `stun:${turnIp}:3478`,
    `turn:${turnIp}:3478?transport=udp`,
    // By name, as in production, so Chrome sends SNI.
    `turns:${turnHost}:443?transport=tcp`,
  ];
  const relaysFile = join(dir, "relays.json");
  try {
    // Left over from a run of this checkout that was killed: global setup's waitForOtherRun has
    // waited out any other checkout's run, or refused it.
    down();
    await Promise.all([fetchImages(), timed("web build", buildPages(pagesDir))]);
    await timed(
      "stack up",
      run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "120"]),
    );
    const relays = [
      { id: "net", urls: turnUrls, publicKey: netKey },
      {
        id: "sto",
        // By address: the server resolves no test names, and its check needs a turn: UDP URL.
        urls: [`stun:${relayIp}:3478`, `turn:${relayIp}:3478?transport=udp`],
        publicKey: await inRelay("cat", "/etc/fidant-relay/relay.pub"),
      },
    ];
    await writeFile(relaysFile, JSON.stringify(relays));
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    name: "networks",
    // Not the stack's server, which is serverImage's container; only an origin the browser may reach.
    url: boxOrigin,
    origins: [`https://${signalHost}`],
    // The server ignores TURN_* while the list has relays; they stay as its fallback without one.
    env: {
      TURN_URLS: turnUrls.join(","),
      TURN_SECRET_FILE: secretFile,
      RELAYS_FILE: relaysFile,
      RELAY_MASTER_FILE: masterFile,
    },
    stop,
  };
}

/** Logs how long a setup step took, so a slow CI start shows which step to speed up. */
async function timed<T>(step: string, work: Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await work;
  console.log(`networks setup: ${step} took ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return result;
}

/** The web build the release uploads, with the signaling address from apps/web/signals.json. */
async function buildPages(outDir: string): Promise<void> {
  const vite = join(repo, "apps", "web", "node_modules", "vite", "bin", "vite.js");
  await run(
    process.execPath,
    [vite, "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"],
    {
      cwd: join(repo, "apps", "web"),
      env: { ...process.env, SIGNALS_FILE: "signals.json" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

/**
 * Pulls missing images and builds the built ones on every run, so a Dockerfile change takes effect
 * without a new tag. The layer cache makes an unchanged build take seconds.
 */
async function fetchImages(): Promise<void> {
  await Promise.all([
    timed(
      "image pull",
      run("docker", [...compose, "pull", "--policy", "missing", "--ignore-buildable", "--quiet"]),
    ),
    timed(
      "server image pull",
      run("docker", ["image", "inspect", serverImage]).catch(() =>
        run("docker", ["pull", "--quiet", serverImage]),
      ),
    ),
    timed(
      "image build",
      run("docker", [...compose, "build"], { maxBuffer: 64 * 1024 * 1024 }),
    ).catch(async (error: { stdout?: string }) => {
      // On a pipe, as in CI, the write is async and the run could exit before it drains.
      await new Promise((done) => process.stderr.write(error.stdout ?? "", done));
      throw error;
    }),
  ]);
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
        // Holds the TURN secret, the relay list and the relay master, which the server reads.
        const secretDir = dirname(env.TURN_SECRET_FILE ?? "");
        // --init: as PID 1 the server would ignore any signal it has no handler for, such as
        // SIGTERM before it listens, so tini takes PID 1 and forwards docker's signals to it.
        // ponytail: one server container at a time; waitForOtherRun holds back a second checkout's run.
        return [
          "docker",
          "run",
          "--rm",
          "--init",
          "--name",
          serverName,
          "--network",
          "fidant-e2e-public",
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
          "-e",
          "RELAYS_FILE",
          "-e",
          "RELAY_MASTER_FILE",
          serverImage,
          "node",
        ];
      },
    }),
};
