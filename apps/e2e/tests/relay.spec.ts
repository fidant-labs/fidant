import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { type Actor, canaryFile, expect, type Observed, test } from "../src/fixtures.ts";
import { coturnLog, serverStdoutLog } from "../src/paths.ts";

// Transfers that cannot go directly: the recipient may only use relay candidates, so every byte
// passes through the local coturn, unless the sender refuses the relay. The forced transfer runs
// once with only the TURN-over-UDP URL and once with only the TURN-over-TCP one, so each transport
// is proven on its own. The harness's leak check also scans coturn's log.

test.skip(!process.env.SIGILL_E2E_TURN_URLS, "coturn not found; brew install coturn");

type Transport = "udp" | "tcp";

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const panel = (page: Page) => page.getByRole("region", { name: "What our server has right now" });
const relayed =
  "None. The browsers couldn't connect directly, so the file passes encrypted through our relay instead.";

/** What a run log has written since `start` bytes. */
const since = async (file: string, start: number) => (await readFile(file)).subarray(start);
const sizeOf = async (file: string) => (await readFile(file).catch(() => Buffer.alloc(0))).length;
/** Whether the server logged `line` since `start` bytes. */
const logged = async (start: number, line: string) =>
  (await since(serverStdoutLog, start)).toString().split("\n").includes(line);

/** The signaling messages of type `t` that an actor sent or received so far. */
const signals = async (seen: Observed, type: "frame-sent" | "frame-received", t: string) =>
  (await seen.records()).flatMap((record) => {
    if (record.type !== type) {
      return [];
    }
    const message = JSON.parse(record.payload) as Record<string, unknown>;
    return message.t === t ? [message] : [];
  });

/** A list the page's peer connections kept (see `watchPeers`). */
const peerList = (page: Page, key: "iceUrls" | "peerStates" | "relayPaths") =>
  page.evaluate((k) => (globalThis as Record<string, unknown>)[k] as string[] | undefined, key);

/**
 * Init script: keeps every peer connection's ICE URLs and states, and, once it connects, the type
 * and relay protocol of its selected local candidate (`relay/udp`, `host/` and so on). With a
 * `relay` transport it allows only relay candidates, from the TURN URLs for that transport.
 */
function watchPeers(relay: Transport | null) {
  delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  const Native = globalThis.RTCPeerConnection;
  const urls: string[] = [];
  const states: string[] = [];
  const paths: string[] = [];
  Object.assign(globalThis, { iceUrls: urls, peerStates: states, relayPaths: paths });
  globalThis.RTCPeerConnection = class extends Native {
    constructor(config: RTCConfiguration = {}) {
      for (const server of config.iceServers ?? []) {
        urls.push(...[server.urls].flat());
      }
      const iceServers = (config.iceServers ?? [])
        .map((server) => ({
          ...server,
          urls: [server.urls].flat().filter((url) => url.endsWith(`?transport=${relay}`)),
        }))
        .filter((server) => server.urls.length > 0);
      super(relay ? { ...config, iceServers, iceTransportPolicy: "relay" } : config);
      states.push(this.connectionState);
      this.addEventListener("connectionstatechange", async () => {
        states.push(this.connectionState);
        if (this.connectionState !== "connected") {
          return;
        }
        const reports = [...(await this.getStats()).values()];
        const pairId = reports.find((r) => r.type === "transport")?.selectedCandidatePairId;
        const pair = reports.find((r) => r.id === pairId);
        const local = reports.find((r) => r.id === pair?.localCandidateId);
        paths.push(`${local?.candidateType}/${local?.relayProtocol ?? ""}`);
      });
    }
  };
}

/**
 * Opens an actor whose peer connections may only use relay candidates reached over `transport`,
 * and keeps their ICE URLs.
 */
async function relayOnly(
  open: (name: string) => Promise<Actor>,
  name: string,
  transport: Transport,
): Promise<Page> {
  const { context, page } = await open(name);
  await context.addInitScript(watchPeers, transport);
  return page;
}

for (const transport of ["udp", "tcp"] as const) {
  test(`a transfer forced through the TURN relay over ${transport}`, async ({
    actor,
    leaks,
    canary,
  }) => {
    const stdoutStart = await sizeOf(serverStdoutLog);
    const coturnStart = await sizeOf(coturnLog);
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 300_001 }));

    const sender = await relayOnly(actor, "sender", transport);
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

    const recipient = await relayOnly(actor, "recipient", transport);
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
      // The panel and the Why? text also say "through our relay".
      await expect(page.getByText("Through our relay", { exact: true })).toBeVisible();
      await page.getByText("Why?", { exact: true }).click();
      await expect(
        page.getByText("So the file goes through our relay in Stockholm."),
      ).toBeVisible();
      // The only ICE servers the page was given are the local coturn's.
      const urls = await peerList(page, "iceUrls");
      expect(urls?.length).toBeGreaterThan(0);
      expect(new Set(urls)).toEqual(new Set(process.env.SIGILL_E2E_TURN_URLS?.split(",")));
    }

    // Every connection went through a relay candidate reached over the transport under test.
    for (const page of [sender, recipient]) {
      await expect.poll(() => peerList(page, "relayPaths")).toEqual([`relay/${transport}`]);
    }

    // The sender reports the path, so the server logs it, about a second after the channel opens.
    await expect.poll(() => logged(stdoutStart, '{"event":"path","path":"relay"}')).toBe(true);
    // coturn allocated relay addresses for the browsers.
    expect((await since(coturnLog, coturnStart)).toString()).toMatch(/ALLOCATE processed, success/);
  });
}

test("a sender who refuses the relay: no credentials, no bytes, plain words on both pages", async ({
  actor,
  observed,
  leaks,
  canary,
}) => {
  // The sender gives up on the refused connection after its 20 s setup timeout.
  test.setTimeout(90_000);
  const stdoutStart = await sizeOf(serverStdoutLog);
  const coturnStart = await sizeOf(coturnLog);
  const file = leaks.watch(canaryFile(canary.fork("file"), { size: 100_001 }));

  const { context, page: sender } = await actor("sender");
  await context.addInitScript(watchPeers, null);
  await sender.goto("/send");
  await sender.getByLabel("Choose a file").setInputFiles({
    name: file.name,
    mimeType: file.mime,
    buffer: file.bytes,
  });
  const allowRelay = sender.getByLabel("Allow our relay if a direct connection isn't possible");
  await allowRelay.uncheck();
  await sender.getByLabel("Who is it for?").fill("Anna");
  await sender.getByRole("button", { name: "Add", exact: true }).click();
  const link = (await sender.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
  leaks.watchKey("link secret", new URL(link).hash.slice(1));
  const hostTurn = async () =>
    (await signals(observed("sender"), "frame-sent", "host")).at(-1)?.turn;
  await expect.poll(hostTurn).toBe(false);

  const recipient = await relayOnly(actor, "recipient", "udp");
  await recipient.goto(link);
  await expect(
    recipient.getByRole("heading", { name: "Couldn't connect directly to the sender" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(recipient.getByText("The sender doesn't allow our relay")).toBeVisible();
  await expect(
    sender.getByRole("list", { name: "Recipients" }).getByText("couldn't connect directly"),
  ).toBeVisible();

  await expect(recipient.getByRole("button", { name: "Download" })).toHaveCount(0);
  for (const page of [sender, recipient]) {
    const states = await peerList(page, "peerStates");
    expect(states?.length, "peer connections made").toBeGreaterThan(0);
    expect(states).not.toContain("connected");
    const urls = await peerList(page, "iceUrls");
    expect(
      urls?.every((url) => url.startsWith("stun:")),
      `only stun: URLs, got ${urls}`,
    ).toBe(true);
  }

  // No relay credentials, before the recovery below legitimately hands them out.
  for (const name of ["sender", "recipient"]) {
    const joined = await signals(observed(name), "frame-received", "joined");
    expect(joined.length, `joined frames for ${name}`).toBeGreaterThan(0);
    for (const message of joined) {
      expect(message.turn).toBe(false);
      const urls = (message.iceServers as RTCIceServer[]).flatMap((server) => [server.urls].flat());
      expect(urls.length, "the stun: URL").toBeGreaterThan(0);
      expect(
        urls.every((url) => url.startsWith("stun:")),
        `only stun: URLs, got ${urls}`,
      ).toBe(true);
      expect(JSON.stringify(message)).not.toMatch(/username|credential/);
    }
  }
  expect((await since(coturnLog, coturnStart)).toString()).not.toMatch(
    /ALLOCATE processed, success/,
  );
  await expect.poll(() => logged(stdoutStart, '{"event":"path","path":"failed"}')).toBe(true);

  await allowRelay.check();
  await expect.poll(hostTurn).toBe(true);
  await recipient.getByRole("button", { name: "Try again" }).click();
  const download = recipient.getByRole("button", { name: "Download" });
  await expect(download).toBeVisible({ timeout: 30_000 });
  const downloading = recipient.waitForEvent("download");
  await download.click();
  await expect(recipient.getByText("this is exactly the file that was sent")).toBeVisible({
    timeout: 30_000,
  });
  expect(sha256Hex(await readFile(await (await downloading).path()))).toBe(sha256Hex(file.bytes));
  await expect(recipient.getByText("Through our relay", { exact: true })).toBeVisible();
});

test("a sender who refuses the relay and fails setup shows the refused relay", async ({
  actor,
  leaks,
  canary,
}) => {
  const file = leaks.watch(canaryFile(canary.fork("file"), { size: 10_001 }));
  const { context, page: sender } = await actor("sender");
  await context.addInitScript(() => {
    RTCPeerConnection.prototype.setLocalDescription = () =>
      Promise.reject(new DOMException("injected", "OperationError"));
  });
  await sender.goto("/send");
  await sender.getByLabel("Choose a file").setInputFiles({
    name: file.name,
    mimeType: file.mime,
    buffer: file.bytes,
  });
  await sender.getByLabel("Allow our relay if a direct connection isn't possible").uncheck();
  await sender.getByLabel("Who is it for?").fill("Anna");
  await sender.getByRole("button", { name: "Add", exact: true }).click();
  const link = (await sender.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
  leaks.watchKey("link secret", new URL(link).hash.slice(1));

  const recipient = await relayOnly(actor, "recipient", "udp");
  await recipient.goto(link);
  await expect(recipient.getByText("The sender doesn't allow our relay")).toBeVisible({
    timeout: 20_000,
  });
  await expect(recipient.getByText("Couldn't connect to the sender's computer")).toHaveCount(0);
});
