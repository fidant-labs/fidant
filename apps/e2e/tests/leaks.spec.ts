import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import { canaryFile, canaryKey, expect, test } from "../src/fixtures.ts";
import { base32Token } from "../src/leaks/canary.ts";
import type { Finding } from "../src/leaks/scan.ts";

// The detector's self-test: each case leaks a canary from the page to the real stack on purpose
// and checks that the scan finds it, with the right class, label, observation point and view.
// The requests are same-origin, so the CSP allows them; the server answers 404 or 405, which does
// not matter, because the browser records what it sent.
//
// A server-log leak cannot be forced here without changing the server, whose stdout carries only
// allowlisted events. The log checks are covered by the unit tests of checkServerLog in
// src/leaks/server-log.test.ts; src/leaks/captures.test.ts shows each log line becomes a capture
// that the canary scan searches like any other.

/** Small canaries keep the suite fast. Sizes stay six digits, so the size check applies. */
const fileOptions = { max: 200_000 };

interface Expected {
  class: Finding["class"];
  label: string;
  /** The end of the point, such as `request.url`, after the actor's file and record number. */
  field: string;
  view: RegExp;
}

function expectFinding(findings: Finding[], expected: Expected): void {
  const point = new RegExp(
    `^observations/.+/default\\.jsonl#\\d+ ${escapeRegExp(expected.field)}$`,
  );
  const match = findings.find(
    (finding) =>
      finding.class === expected.class &&
      finding.label === expected.label &&
      point.test(finding.point) &&
      expected.view.test(finding.view),
  );
  expect(match, `${JSON.stringify(expected)} in:\n${summary(findings)}`).toBeDefined();
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const summary = (findings: Finding[]) =>
  findings.map((f) => `  ${f.class} ${f.label} ${f.point} ${f.view}`).join("\n") || "  (none)";

/** Loads the app, so the page has the stack's origin for same-origin requests. */
async function open(page: Page): Promise<void> {
  await page.goto("/");
}

/**
 * Opens the real /signal endpoint and sends one relay message carrying `data`. The page has not
 * joined the link, so the server answers `not-on-link`; the frame was sent all the same, and
 * waiting for the answer means its record is in.
 */
async function relay(page: Page, link: string, data: string): Promise<string> {
  return page.evaluate(
    ([link, data]) =>
      new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${location.origin.replace("https", "wss")}/signal`);
        socket.addEventListener("open", () =>
          socket.send(JSON.stringify({ t: "relay", link, data })),
        );
        socket.addEventListener("message", (event) => {
          resolve(String(event.data));
          socket.close();
        });
        socket.addEventListener("error", () => reject(new Error("websocket error")));
      }),
    [link, data] as const,
  );
}

/**
 * POSTs `{"data": base64}`, gzip-compressed in the page. Random bytes do not compress, so gzip
 * would store them as they are, and the raw view would catch them. Base64 text compresses, so
 * only the gzip view holds it.
 */
async function postGzip(page: Page, base64: string): Promise<void> {
  await page.evaluate(async (data) => {
    const json = new Blob([JSON.stringify({ data })]);
    const body = await new Response(
      json.stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    await fetch("/upload", { method: "POST", body });
  }, base64);
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test.describe("the detector catches", () => {
  test("a fragment secret in a query string", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const key = canaryKey(canary.fork("key"));
    leaks.watchKey("fragment secret", key);
    await open(page);
    await page.evaluate((text) => fetch(`/?k=${text}`), key.text);
    const findings = await leaks.scan();
    expectFinding(findings, {
      class: "K",
      label: "fragment secret text",
      field: "request.url",
      view: /^raw$/,
    });
    // The text is also base64url, so its bytes turn up in a decoded view.
    expectFinding(findings, {
      class: "K",
      label: "fragment secret",
      field: "request.url",
      view: /^base64/,
    });
  });

  test("a name token in a request header", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    // Header values are byte strings; the name's non-ASCII letters all fit in latin1.
    await page.evaluate((name) => fetch("/", { headers: { "x-test": name } }), file.name);
    expectFinding(await leaks.scan(), {
      class: "M",
      label: "file#1 name",
      field: "request.headers.x-test",
      view: /^raw$/,
    });
  });

  test("file bytes as base64 in a JSON body", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    await page.evaluate(
      (data) => fetch("/upload", { method: "POST", body: JSON.stringify({ data }) }),
      file.bytes.toString("base64"),
    );
    expectFinding(await leaks.scan(), {
      class: "C",
      label: "file#1",
      field: "request.body",
      // Base64 text needles (0001) now catch this directly, so the raw view matches too.
      view: /^(raw|base64@\d)$/,
    });
  });

  test("file bytes as hex in a body", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    await page.evaluate(
      (body) => fetch("/upload", { method: "POST", body }),
      file.bytes.toString("hex"),
    );
    expectFinding(await leaks.scan(), {
      class: "C",
      label: "file#1",
      field: "request.body",
      view: /^hex@\d$/,
    });
  });

  test("the file's SHA-256 as hex in a URL", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    await page.evaluate((hash) => fetch(`/?h=${hash}`), sha256Hex(file.bytes));
    expectFinding(await leaks.scan(), {
      class: "C",
      label: "file#1 sha256",
      field: "request.url",
      view: /^hex@\d$/,
    });
  });

  test("a fragment secret's SHA-256 as hex in a URL", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const key = canaryKey(canary.fork("key"));
    leaks.watchKey("fragment secret", key);
    await open(page);
    // A lookup ID made by hashing the fragment string, as an app might.
    await page.evaluate((hash) => fetch(`/lookup/${hash}`), sha256Hex(Buffer.from(key.text)));
    expectFinding(await leaks.scan(), {
      class: "K",
      label: "fragment secret text sha256",
      field: "request.url",
      view: /^hex@\d$/,
    });
  });

  test("an NFD, percent-encoded file name in a URL path", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    await page.evaluate((name) => {
      // Every byte is escaped, ASCII included, so the raw view cannot contain the name's token.
      const bytes = new TextEncoder().encode(name.normalize("NFD"));
      const path = Array.from(bytes, (b) => `%${b.toString(16).padStart(2, "0")}`).join("");
      return fetch(`/files/${path}`);
    }, file.name);
    const findings = await leaks.scan();
    expectFinding(findings, {
      class: "M",
      label: "file#1 name",
      field: "request.url",
      view: /^percent$/,
    });
  });

  test("a 16-byte window of a key", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const key = canaryKey(canary.fork("key"));
    leaks.watchKey("fragment secret", key);
    await open(page);
    // Offset 5 is off the key's 3-byte base64 groups. Base64 text needles (0001) now catch the
    // window directly, so the raw view matches too.
    const window = key.bytes.subarray(5, 5 + 16).toString("base64url");
    await page.evaluate((window) => fetch(`/?k=${window}`), window);
    expectFinding(await leaks.scan(), {
      class: "K",
      label: "fragment secret",
      field: "request.url",
      view: /^(raw|base64@\d)$/,
    });
  });

  test("the exact file size in a header", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    await page.evaluate((size) => fetch("/", { headers: { "x-size": String(size) } }), file.size);
    expectFinding(await leaks.scan(), {
      class: "M",
      label: "file#1 size",
      field: "request.headers.x-size",
      view: /^raw$/,
    });
  });

  test("a key in a websocket frame to /signal", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const key = canaryKey(canary.fork("key"));
    leaks.watchKey("fragment secret", key);
    const link = canary.fork("link").bytes(16).toString("base64url");
    await open(page);
    // A well-formed relay message: the key goes as the opaque base64url payload.
    const answer = await relay(page, link, key.text);
    expect(JSON.parse(answer)).toEqual({ t: "error", code: "not-on-link" });
    expectFinding(await leaks.scan(), {
      class: "K",
      label: "fragment secret text",
      field: "frame-sent.payload",
      view: /^raw$/,
    });
  });

  test("a recipient name in a websocket frame to /signal", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const name = `Anna-${base32Token(canary.fork("name"), 8)}`;
    leaks.watchText("recipient name", name);
    const link = canary.fork("link").bytes(16).toString("base64url");
    await open(page);
    await relay(page, link, name);
    expectFinding(await leaks.scan(), {
      class: "M",
      label: "recipient name",
      field: "frame-sent.payload",
      view: /^raw$/,
    });
  });

  test("file bytes as base64 in a gzip-compressed body", async ({ page, leaks, canary }) => {
    leaks.expectLeaks();
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    await open(page);
    await postGzip(page, file.bytes.toString("base64"));
    expectFinding(await leaks.scan(), {
      class: "C",
      label: "file#1",
      field: "request.body",
      view: /^gzip(>base64@\d)?$/,
    });
  });
});

test.describe("the detector stays quiet on", () => {
  test("a 13-byte window of a key", async ({ page, leaks, canary }) => {
    const key = canaryKey(canary.fork("key"));
    leaks.watchKey("fragment secret", key);
    await open(page);
    // Too short for 20 fully determined base64 characters at any alignment (13 bytes give at
    // most 17), so 0001 does not count it. Same offset as the 16-byte case.
    const window = key.bytes.subarray(5, 5 + 13).toString("base64url");
    await page.evaluate((window) => fetch(`/?k=${window}`), window);
    expect(await leaks.scan()).toEqual([]);
  });

  test("the same requests carrying unrelated data", async ({ page, leaks, canary }) => {
    // The canaries are watched but never sent. Every request above is repeated with other
    // random data, and nothing may match. No expectLeaks: the teardown must pass too.
    const file = leaks.watch(canaryFile(canary.fork("file"), fileOptions));
    leaks.watchKey("fragment secret", canaryKey(canary.fork("key")));
    const other = canaryFile(canary.fork("other"), { size: file.size + 7 });
    const otherKey = canaryKey(canary.fork("other key"));
    const link = canary.fork("link").bytes(16).toString("base64url");
    await open(page);
    await page.evaluate(
      async ({ key, name, data, hex, hash, size, window }) => {
        await fetch(`/?k=${key}`);
        await fetch("/", { headers: { "x-test": name } });
        await fetch("/upload", { method: "POST", body: JSON.stringify({ data }) });
        await fetch("/upload", { method: "POST", body: hex });
        await fetch(`/?h=${hash}`);
        await fetch(`/files/${encodeURIComponent(name.normalize("NFD"))}`);
        await fetch(`/?k=${window}`);
        await fetch("/", { headers: { "x-size": String(size) } });
      },
      {
        key: otherKey.text,
        name: other.name,
        data: other.bytes.toString("base64"),
        hex: other.bytes.toString("hex"),
        hash: sha256Hex(other.bytes),
        size: other.size,
        window: otherKey.bytes.subarray(5, 21).toString("base64url"),
      },
    );
    await relay(page, link, otherKey.text);
    await postGzip(page, other.bytes.toString("base64"));
    expect(await leaks.scan()).toEqual([]);
    expect(await leaks.check()).toBeUndefined();
  });
});

test("a leak fails the test by default", async ({ page, leaks, canary }) => {
  const key = canaryKey(canary.fork("key"));
  leaks.watchKey("fragment secret", key);
  await open(page);
  await page.evaluate((text) => fetch(`/?k=${text}`), key.text);
  // check() is the verdict the teardown throws when expectLeaks() was not called.
  const report = await leaks.check();
  expect(report).toMatch(/Leak check failed/);
  expect(report).toContain("fragment secret");
  // Now the deliberate leak is expected: the teardown passes and the sweep skips this test.
  leaks.expectLeaks();
});
