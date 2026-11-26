import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { descendants, parsePs, sampleRss } from "./rss.ts";

// The worker (100) runs Chromium; the runner (50), the server (200) and another Chrome (900) don't count.
const ps = `
    1     0  9000 /sbin/launchd
   50     1 70000 node
  100    50 40000 /usr/local/bin/node
  200    50 30000 /usr/local/bin/node
  300   100 80000 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell
  301   300 20000 chrome-headless
  302   301  5000 chrome-headless
  900     1 50000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
garbage line
`;

test("parses ps output, with RSS in bytes and spaces in the command", () => {
  const processes = parsePs(ps);
  assert.equal(processes.length, 8);
  assert.deepEqual(processes[1], { pid: 50, ppid: 1, rssBytes: 70000 * 1024, command: "node" });
  assert.deepEqual(processes.at(-1), {
    pid: 900,
    ppid: 1,
    rssBytes: 50000 * 1024,
    command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});

test("counts every process below the worker, and nothing above or beside it", () => {
  const pids = descendants(parsePs(ps), 100).map((info) => info.pid);
  assert.deepEqual(
    pids.sort((a, b) => a - b),
    [300, 301, 302],
  );
  assert.deepEqual(descendants(parsePs(ps), 302), []);
});

test("sums the RSS of a child process with this platform's ps", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  await once(child, "spawn");
  try {
    const window = await (await sampleRss()).end();
    assert.equal(window.processes, 1);
    assert.equal(window.samples, 2);
    assert.ok(window.baselineBytes > 0);
    assert.ok(window.peakBytes >= window.baselineBytes);
  } finally {
    child.kill();
  }
});
