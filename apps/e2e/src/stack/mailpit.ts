import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailpitLog } from "../paths.ts";
import { onPath, waitForListening } from "./coturn.ts";
import { freePort, terminate } from "./server.ts";
import type { RunningService, Service } from "./service.ts";

const host = "127.0.0.1";
const missing = "mailpit not found; brew install mailpit (macOS) or its release binary (Linux)";

/**
 * Mailpit on free loopback ports, catching every mail the server sends. It hands the server
 * MAIL_ENABLED, MAIL_SMTP_URL and MAIL_FROM, and the tests MAILPIT_API. It has no `url`: the browser may not
 * reach it. Without `mailpit` on PATH the stack runs without mail, except in CI, where that fails
 * the run.
 */
export const mailpit: Service = { name: "mailpit", start: startMailpit };

async function startMailpit(): Promise<RunningService> {
  if (!onPath("mailpit")) {
    if (process.env.CI) {
      throw new Error(missing);
    }
    console.warn(`[e2e stack] ${missing}. Running without mail.`);
    return { name: "mailpit", env: {}, stop: async () => {} };
  }

  const dir = await mkdtemp(join(tmpdir(), "fidant-e2e-mailpit-"));
  const smtpPort = await freePort();
  let apiPort = await freePort();
  while (apiPort === smtpPort) {
    apiPort = await freePort();
  }
  const log = openSync(mailpitLog, "w");
  const child = spawn(
    "mailpit",
    [
      "--smtp",
      `${host}:${smtpPort}`,
      "--listen",
      `${host}:${apiPort}`,
      "--database",
      join(dir, "mail.db"),
      "--disable-version-check",
      "--smtp-disable-rdns",
      "--quiet",
    ],
    { stdio: ["ignore", log, log] },
  );
  closeSync(log);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  const cleanUpOnExit = () => {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
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
    await waitForListening(smtpPort, exited, "Mailpit");
    await waitForListening(apiPort, exited, "Mailpit");
  } catch (error) {
    await stop();
    throw new Error(`${(error as Error).message} See ${mailpitLog}.`);
  }
  return {
    name: "mailpit",
    env: {
      MAIL_ENABLED: "1",
      MAIL_SMTP_URL: `smtp://${host}:${smtpPort}`,
      MAIL_FROM: "Fidant <noreply@example.se>",
      MAILPIT_API: `http://${host}:${apiPort}`,
    },
    stop,
  };
}
