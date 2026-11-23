import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { type Actor, canaryFile, expect, test } from "../src/fixtures.ts";
import { coturnLog, serverStdoutLog } from "../src/paths.ts";

// A transfer that cannot go directly: both browsers may only use relay candidates, so every byte
// passes through the local coturn. The harness's leak check also scans coturn's log.

test.skip(!process.env.SIGILL_E2E_TURN_URLS, "coturn not found; brew install coturn");

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const panel = (page: Page) => page.getByRole("region", { name: "What our server has right now" });
const relayed =
  "None. The browsers couldn't connect directly, so the file passes encrypted through our relay instead.";

/** What a run log has written since `start` bytes. */
const since = async (file: string, start: number) => (await readFile(file)).subarray(start);
const sizeOf = async (file: string) => (await readFile(file).catch(() => Buffer.alloc(0))).length;

/** Opens an actor whose peer connections may only use relay candidates, and keeps their ICE URLs. */
async function relayOnly(open: (name: string) => Promise<Actor>, name: string): Promise<Page> {
  const { context, page } = await open(name);
  await context.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    const Native = globalThis.RTCPeerConnection;
    const urls: string[] = [];
    (globalThis as { iceUrls?: string[] }).iceUrls = urls;
    globalThis.RTCPeerConnection = class extends Native {
      constructor(config: RTCConfiguration = {}) {
        for (const server of config.iceServers ?? []) {
          urls.push(...[server.urls].flat());
        }
        super({ ...config, iceTransportPolicy: "relay" });
      }
    };
  });
  return page;
}

test("a transfer forced through the TURN relay", async ({ actor, leaks, canary }) => {
  const stdoutStart = await sizeOf(serverStdoutLog);
  const coturnStart = await sizeOf(coturnLog);
  const file = leaks.watch(canaryFile(canary.fork("file"), { size: 300_001 }));

  const sender = await relayOnly(actor, "sender");
  await sender.goto("/send");
  await sender.getByLabel("Choose a file").setInputFiles({
    name: file.name,
    mimeType: file.mime,
    buffer: file.bytes,
  });
  await sender.getByLabel("Who is it for?").fill("Anna");
  await sender.getByRole("button", { name: "Add", exact: true }).click();
  const link = (await sender.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
  leaks.watchKey("link secret", new URL(link).hash.slice(1));

  const recipient = await relayOnly(actor, "recipient");
  await recipient.goto(link);
  const downloading = recipient.waitForEvent("download");
  await recipient.getByRole("button", { name: "Download" }).click();
  await expect(recipient.getByText("this is exactly the file that was sent")).toBeVisible({
    timeout: 30_000,
  });
  const download = await downloading;
  expect(sha256Hex(await readFile(await download.path()))).toBe(sha256Hex(file.bytes));

  for (const page of [sender, recipient]) {
    await expect(panel(page)).toContainText(relayed);
    await expect(panel(page)).toContainText("Our relay sees");
    await expect(panel(page)).not.toContainText("goes directly between browsers");
    // The only ICE servers the page was given are the local coturn's.
    const urls = await page.evaluate(() => (globalThis as { iceUrls?: string[] }).iceUrls);
    expect(urls?.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(process.env.SIGILL_E2E_TURN_URLS?.split(",")));
  }

  // The sender reports the path, so the server logs it, about a second after the channel opens.
  await expect
    .poll(async () =>
      (await since(serverStdoutLog, stdoutStart))
        .toString()
        .split("\n")
        .some((line) => line === '{"event":"path","path":"relay"}'),
    )
    .toBe(true);
  // coturn allocated relay addresses for the browsers.
  expect((await since(coturnLog, coturnStart)).toString()).toMatch(/ALLOCATE processed, success/);
});
