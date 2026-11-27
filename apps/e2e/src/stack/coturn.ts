import { spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// ponytail: relative import, not a workspace dependency on the server, for one small function.
import { relaySecret } from "../../../server/src/relay-secret.ts";
import { coturnLog, repoRoot } from "../paths.ts";
import { freePort, terminate } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

const host = "127.0.0.1";
const startTimeoutMs = 10_000;
const missing = "coturn not found; brew install coturn (macOS) or apt-get install coturn";

// Relay list of `bad`, whose secret coturn lacks, then `loc`, whose secret it has. Skipped without turnserver, except in CI.
export const coturn: Service = { name: "coturn", start: startCoturn };

async function startCoturn(): Promise<RunningService> {
  if (!onPath("turnserver")) {
    if (process.env.CI) {
      throw new Error(missing);
    }
    console.warn(`[e2e stack] ${missing}. Running without TURN.`);
    return { name: "coturn", env: {}, stop: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "sigill-e2e-coturn-"));
  const removeDir = () => rmSync(dir, { recursive: true, force: true });
  const port = await freePort();
  const master = randomBytes(32).toString("hex");
  const masterFile = join(dir, "relay-master");
  await writeFile(masterFile, `${master}\n`, { mode: 0o600 });
  const secret = relaySecret(master, "loc");
  const secretFile = join(dir, "secret");
  const config = join(dir, "turnserver.conf");
  await writeFile(secretFile, secret, { mode: 0o600 });
  // The same shape as production's TURN_URLS (apps/infra/box/user-data.sh).
  const urls = [
    `stun:${host}:${port}`,
    `turn:${host}:${port}?transport=udp`,
    `turn:${host}:${port}?transport=tcp`,
  ];
  const list = [];
  for (const [id, relayUrls] of [
    ["bad", [`turn:${host}:${port}?transport=udp`]],
    ["loc", urls],
  ] as const) {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(join(dir, `${id}.key`), privateKey.export({ type: "pkcs8", format: "pem" }), {
      mode: 0o600,
    });
    list.push({
      id,
      urls: relayUrls,
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
    });
  }
  const listFile = join(dir, "relays.json");
  await writeFile(listFile, JSON.stringify(list));
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

  const exited = () => failed || child.exitCode !== null || child.signalCode !== null;
  try {
    await waitForListening(port, exited, "coturn");
    // coturn keeps running when it can't bind its UDP port, and every transfer then fails later.
    await waitForStun(port, exited, "coturn");
  } catch (error) {
    await stop();
    throw new Error(`${(error as Error).message} See ${coturnLog}.`);
  }
  return {
    name: "coturn",
    port,
    env: {
      TURN_URLS: urls.join(","),
      TURN_SECRET_FILE: secretFile,
      RELAYS_FILE: listFile,
      RELAY_MASTER_FILE: masterFile,
    },
    stop,
  };
}

/** The setting lines of a turnserver.conf, trimmed, without blank lines and comments. */
export const configLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

/** A setting line's key: `realm` for `realm=x`, `realm = x` or `realm x`. */
export const keyOf = (line: string) => line.split(/[\s=]/, 1)[0] ?? "";

/**
 * Production's coturn config (apps/infra/box/turnserver.conf), which both e2e stacks start from.
 * Its `no-dtls` and `no-cli` stay: new coturn has DTLS and the CLI off already and warns about
 * them, but older packages such as Ubuntu's need them, or the CLI listens on a fixed port.
 */
const productionConfig = configLines(
  readFileSync(join(repoRoot, "apps", "infra", "box", "turnserver.conf"), "utf8"),
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
    .filter((line) => !Object.hasOwn(replaced, keyOf(line)))
    .filter((line) => !(loopback && loopbackDenials.includes(line)));
  const lines = [
    ...kept,
    // Production listens on every address; a test run only on the one the browsers reach.
    `listening-ip=${ip}`,
    // Relay addresses come from that same address, so the other browser can reach them.
    `relay-ip=${ip}`,
    `listening-port=${port}`,
    // Production's file has use-auth-secret but no secret: the box appends its own at first boot
    // (user-data.sh). Without this line every allocation fails authentication.
    `static-auth-secret=${secret}`,
    "realm=sigill.local",
    // On loopback, every peer of the local stack is on loopback too.
    ...(loopback ? ["allow-loopback-peers"] : []),
    // ponytail: the loopback stack keeps plain TURN over TCP; TLS is covered by the networks suite.
    // DTLS and the CLI are off by default in new coturn, but every coturn, 4.19.2 included, starts
    // TLS listeners by default, so a run without TLS needs `no-tls`.
    ...(tls
      ? [`tls-listening-port=${tls.port}`, `cert=${tls.cert}`, `pkey=${tls.pkey}`]
      : ["no-tls"]),
    // The default pid file and user database are under /var, which a test run may not write.
    `pidfile=${join(stateDir, "turnserver.pid")}`,
    `userdb=${join(stateDir, "turndb")}`,
    `log-file=${coturnLog}`,
    // The relay tests read "ALLOCATE processed, success" from the log, which only verbose writes.
    "verbose",
  ];
  return `${lines.join("\n")}\n`;
}

/** Whether `command` is a file in one of the PATH directories. */
export function onPath(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, command)));
}

/** Polls until the TCP port accepts a connection. `name` names the service in errors. */
export async function waitForListening(
  port: number,
  exited: () => boolean,
  name: string,
): Promise<void> {
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited()) {
      throw new Error(`${name} exited before listening.`);
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
  throw new Error(`${name} did not listen on port ${port} within ${startTimeoutMs} ms.`);
}

/**
 * Polls until a STUN binding request to the UDP port is answered. waitForListening only shows the
 * TCP listener, and coturn without its UDP port serves no `stun:` or `turn:...?transport=udp` URL.
 */
export async function waitForStun(
  port: number,
  exited: () => boolean,
  name: string,
  timeoutMs = startTimeoutMs,
): Promise<void> {
  // RFC 8489 section 5: type Binding request, length 0, the magic cookie, a transaction ID.
  const request = Buffer.concat([Buffer.from("000100002112a442", "hex"), randomBytes(12)]);
  const socket = createSocket("udp4");
  // A failed send is one more unanswered request.
  socket.on("error", () => {});
  const answered = new Promise<true>((resolve) => {
    socket.on("message", (message) => {
      // Any response that echoes the cookie and transaction ID came from a STUN server.
      if (message.subarray(4, 20).equals(request.subarray(4, 20))) {
        resolve(true);
      }
    });
  });
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited()) {
        throw new Error(`${name} exited before answering on UDP port ${port}.`);
      }
      socket.send(request, port, host);
      if (await Promise.race([answered, sleep(100)])) {
        return;
      }
    }
    throw new Error(
      `${name} did not answer STUN on UDP port ${port} within ${timeoutMs} ms, so it could not bind the port or another process holds it.`,
    );
  } finally {
    socket.close();
  }
}
