// The `sigill` fixture gives each test its own server and watches everything
// that leaves the browsers.
//
// Per test it:
// - starts `node apps/server/src/main.ts` on a free port (PORT=0) with a fresh
//   certificate directory, and reads the port from the `listening` log event;
// - opens every page in its own browser context (separate profiles, like
//   separate devices), with the File System Access picker removed so the
//   recipient page saves through a Blob download Playwright can read;
// - records every WebSocket frame those pages send and receive.
//
// After the test it stops the server and checks that stdout is strictly JSON
// log lines with allowlisted fields, and that neither the server output nor any
// WebSocket frame contains a value the test marked secret, or plaintext SDP.
// A server per test keeps tests independent and makes each leak check cover
// exactly what that test did, so together they cover the whole run.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import { ERROR_CODES, REFUSE_REASONS, UPGRADE_REJECT_REASONS } from "@sigill/protocol";

export { expect };

export type Sigill = {
  /** The server's origin, like https://localhost:54321. */
  baseURL: string;
  /** A page in a new browser context. */
  openPage(): Promise<Page>;
  /** Fails the test if `value` shows up in server output or a WebSocket frame. */
  forbid(label: string, value: string): void;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverMain = fileURLToPath(new URL("../../server/src/main.ts", import.meta.url));
const webIndex = fileURLToPath(new URL("../dist/index.html", import.meta.url));

/** Signaling must never carry these: SDP is encrypted before it is relayed. */
const SDP_MARKERS = ["v=0", "a=fingerprint", "a=ice-ufrag"];

const LOG_KEYS = new Set(["event", "link", "links", "bytes", "reason", "code", "port"]);
const LOG_REASONS = new Set<string>([...REFUSE_REASONS, ...UPGRADE_REJECT_REASONS]);
const LOG_CODES = new Set<string>(ERROR_CODES);
const LOG_LINK = /^[A-Za-z0-9_-]{6}$/;

export const test = base.extend<{ sigill: Sigill }>({
  sigill: async ({ browser }, use, testInfo) => {
    if (!existsSync(webIndex)) {
      throw new Error(`${webIndex} is missing. Run \`pnpm build\` first.`);
    }

    const certDir = mkdtempSync(join(tmpdir(), "sigill-e2e-certs-"));
    const server = spawn(process.execPath, [serverMain], {
      cwd: repoRoot,
      env: { ...process.env, PORT: "0", CERT_DIR: certDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    let stdout = "";
    let stderr = "";
    server.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    server.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    const frames: { direction: "sent" | "received"; payload: string }[] = [];
    const pageErrors: string[] = [];
    const forbidden: { label: string; value: string }[] = [];

    try {
      const port = await waitForPort(
        server,
        () => stdout,
        () => stderr,
      );
      await use({
        baseURL: `https://localhost:${port}`,
        async openPage() {
          const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
          });
          contexts.push(context);
          await context.addInitScript(() => {
            // Force the recipient's Blob fallback so the file arrives as a download.
            delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
          });
          const page = await context.newPage();
          page.on("pageerror", (error) => pageErrors.push(error.message));
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) =>
              frames.push({ direction: "sent", payload: String(payload) }),
            );
            socket.on("framereceived", ({ payload }) =>
              frames.push({ direction: "received", payload: String(payload) }),
            );
          });
          return page;
        },
        forbid(label, value) {
          if (value.length < 4) {
            throw new Error(`Forbidden value for ${label} is too short to check`);
          }
          forbidden.push({ label, value });
        },
      });
    } finally {
      for (const context of contexts) {
        await context.close();
      }
      server.kill();
      await exited;
      rmSync(certDir, { recursive: true, force: true });
      await testInfo.attach("server-stdout.log", { body: stdout, contentType: "text/plain" });
      await testInfo.attach("server-stderr.log", { body: stderr, contentType: "text/plain" });
    }

    checkLogLines(stdout);

    const sources = [
      { name: "server stdout", text: stdout },
      { name: "server stderr", text: stderr },
      ...frames.map((frame, i) => ({
        name: `WebSocket frame ${i} (${frame.direction})`,
        text: frame.payload,
      })),
    ];
    const leaks: string[] = [];
    for (const { name, text } of sources) {
      for (const { label, value } of forbidden) {
        if (text.includes(value)) {
          leaks.push(`${label} in ${name}`);
        }
      }
      for (const marker of SDP_MARKERS) {
        if (text.includes(marker)) {
          leaks.push(`SDP "${marker}" in ${name}`);
        }
      }
    }
    expect(leaks, "values that must stay in the browser").toEqual([]);

    if (contexts.length > 0) {
      expect(
        frames.some((f) => f.direction === "sent"),
        "captured sent frames",
      ).toBe(true);
      expect(
        frames.some((f) => f.direction === "received"),
        "captured received frames",
      ).toBe(true);
    }
    expect(pageErrors, "uncaught page errors").toEqual([]);
  },
});

/** Resolves with the port from the server's `{"event":"listening","port":N}` line. */
function waitForPort(
  server: ChildProcess,
  stdout: () => string,
  stderr: () => string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (why: string) => {
      cleanup();
      reject(new Error(`Server did not start: ${why}\nstdout:\n${stdout()}\nstderr:\n${stderr()}`));
    };
    const onData = () => {
      for (const line of stdout().split("\n")) {
        if (!line.endsWith("}")) {
          continue;
        }
        try {
          const entry = JSON.parse(line) as { event?: unknown; port?: unknown };
          if (entry.event === "listening" && typeof entry.port === "number") {
            cleanup();
            resolve(entry.port);
            return;
          }
        } catch {
          // A malformed line fails checkLogLines after the test.
        }
      }
    };
    const onExit = (code: number | null) => fail(`exited with code ${code}`);
    const timer = setTimeout(() => fail("no listening event within 20 s"), 20_000);
    const cleanup = () => {
      clearTimeout(timer);
      server.stdout?.off("data", onData);
      server.off("exit", onExit);
    };
    server.stdout?.on("data", onData);
    server.once("exit", onExit);
  });
}

/** stdout must be one JSON object per line, with only allowlisted fields. */
function checkLogLines(stdout: string): void {
  const problems: string[] = [];
  const lines = stdout.split("\n");
  if (lines.pop() !== "") {
    problems.push("stdout does not end with a newline");
  }
  for (const [i, line] of lines.entries()) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1} is not JSON`);
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      problems.push(`line ${i + 1} is not an object`);
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      const ok =
        key === "event"
          ? typeof value === "string"
          : key === "link"
            ? typeof value === "string" && LOG_LINK.test(value)
            : key === "links" || key === "bytes" || key === "port"
              ? Number.isSafeInteger(value) && (value as number) >= 0
              : key === "reason"
                ? LOG_REASONS.has(value as string)
                : key === "code"
                  ? LOG_CODES.has(value as string)
                  : false;
      if (!ok) {
        problems.push(
          `line ${i + 1}: ${LOG_KEYS.has(key) ? "bad value for" : "unexpected"} field "${key}"`,
        );
      }
    }
    if (!("event" in entry)) {
      problems.push(`line ${i + 1} has no event`);
    }
  }
  expect(problems, "server stdout log lines").toEqual([]);
}
