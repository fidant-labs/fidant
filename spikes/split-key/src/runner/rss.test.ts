import assert from "node:assert/strict";
import { test } from "node:test";
import { browserProcesses, parsePs } from "./rss.ts";

// Shaped like real macOS output: Chromium as a child of the runner (100),
// the bench server (200) beside it, an unrelated Playwright Chromium (900),
// and WebKit's XPC services started by launchd.
const PS = `
    1     0  9000 /sbin/launchd
  100    50 40000 /usr/local/bin/node
  200   100 30000 /usr/local/bin/node
  201   200  1000 /usr/bin/something
  300   100 80000 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell
  301   300 20000 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell
  900   899 50000 /Users/me/Library/Caches/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-mac-arm64/chrome-headless-shell
  400   100  1000 /bin/sh
  401   400 10000 /Users/me/Library/Caches/ms-playwright/webkit-2388/Playwright.app/Contents/MacOS/Playwright
  500     1 60000 /Users/me/Library/Caches/ms-playwright/webkit-2388/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent.Development
  501     1  5000 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
  600     1  7000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
garbage line
`;

test("parses ps output, with RSS in bytes and spaces in the command", () => {
  const processes = parsePs(PS);
  assert.equal(processes.length, 12);
  assert.deepEqual(processes.at(-1), {
    pid: 600,
    ppid: 1,
    rssBytes: 7000 * 1024,
    command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});

const pids = (engine: "chromium" | "webkit"): number[] =>
  browserProcesses(parsePs(PS), 100, [200], engine)
    .map((info) => info.pid)
    .sort((a, b) => a - b);

test("counts the runner's descendants, not the server or other browsers", () => {
  // 400/401 are descendants too: the tree does not care which engine they are.
  assert.deepEqual(pids("chromium"), [300, 301, 400, 401]);
});

test("adds launchd-started processes from the engine's Playwright build", () => {
  // 500 is Playwright WebKit's WebContent; 501 is the system WebKit's (Safari), not ours.
  assert.deepEqual(pids("webkit"), [300, 301, 400, 401, 500]);
});
