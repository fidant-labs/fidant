import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import type { Page } from "@playwright/test";
import { canaryFile, expect, type Leaks, type Observed, test } from "../src/fixtures.ts";
import { readPeerConnections, recordPeerConnections, selectedPair } from "../src/ice.ts";
import { serverStdoutLog } from "../src/paths.ts";
import {
  pauseRelay,
  type RouterMode,
  remoteBrowsers,
  resumeRelay,
  routerMode,
} from "../src/stack/networks.ts";

// Transfers between browsers in Docker networks behind NAT routers (networks/compose.yaml).
// Run with `pnpm e2e:networks`. Sites: a1 and a2 share site A, b1 is alone in site B.

type Site = keyof typeof remoteBrowsers;

interface Scenario {
  title: string;
  sender: Site;
  recipient: Site;
  /** The mode of router-b. router-a stays a cone NAT. */
  routerB: RouterMode;
  /**
   * The selected candidate pair as `local/remote` for the sender, then the recipient, such as
   * `srflx/srflx srflx/srflx`. A remote candidate is prflx when the peer's check arrives before
   * its candidate does over signaling, so rows accept prflx wherever the remote side is direct.
   * A local relay candidate carries its transport to the TURN server, such as `relay+tcp`.
   * `none`: the row pauses coturn, so the browsers cannot connect at all.
   */
  path: RegExp | "none";
  /** Set while the row is not implemented yet: why it is skipped. */
  todo?: string;
}

const scenarios: Scenario[] = [
  {
    title: "same network",
    sender: "a1",
    recipient: "a2",
    routerB: "cone",
    path: /^host\/(host|prflx) host\/(host|prflx)$/,
  },
  {
    title: "home routers (cone)",
    sender: "a1",
    recipient: "b1",
    routerB: "cone",
    path: /^srflx\/(srflx|prflx) srflx\/(srflx|prflx)$/,
  },
  {
    title: "symmetric NAT",
    sender: "a1",
    recipient: "b1",
    routerB: "symmetric",
    path: /relay/,
  },
  {
    title: "UDP blocked",
    sender: "a1",
    recipient: "b1",
    routerB: "udp-blocked",
    path: / relay\+tcp\/\S+$/,
  },
  {
    title: "only TCP 443",
    sender: "a1",
    recipient: "b1",
    routerB: "tcp-443",
    path: /relay/,
    todo: "TURN over TLS on 443: SIG-93",
  },
  {
    title: "relay down",
    sender: "a1",
    recipient: "b1",
    routerB: "symmetric",
    path: "none",
  },
  {
    title: "slow lossy link",
    sender: "a1",
    recipient: "b1",
    routerB: "lossy",
    path: /^srflx\/(srflx|prflx) srflx\/(srflx|prflx)$/,
    todo: "slow lossy row arrives with the netem router mode",
  },
];

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** The selected pair of the page's last peer connection, as `local/remote` candidate types. */
async function pathOf(page: Page): Promise<string> {
  const pairs = (await readPeerConnections(page)).map((pc) => selectedPair(pc.stats));
  const pair = pairs.findLast((p) => p?.local && p.remote);
  if (!pair) {
    return "none";
  }
  const transport = pair.relayProtocol ? `+${pair.relayProtocol}` : "";
  return `${pair.local}${transport}/${pair.remote}`;
}

/** Watches the ICE password of every peer connection the page made. */
async function watchIcePasswords(leaks: Leaks, name: string, page: Page): Promise<void> {
  for (const pc of await readPeerConnections(page)) {
    // Recorded only once the connection is up.
    if (pc.pwd) {
      leaks.watchKey(`${name} ICE pwd`, pc.pwd);
    }
  }
}

/** The recorder saw each browser's traffic, so the leak scan had something to scan. */
async function expectSignaling(observed: (name: string) => Observed, baseURL: string | undefined) {
  for (const name of ["sender", "recipient"]) {
    const records = await observed(name).records();
    const types = new Set(records.map((record) => record.type));
    expect(
      records.some((r) => r.type === "request" && r.url.startsWith(`${baseURL}/`)),
      `${name} page request`,
    ).toBe(true);
    expect(
      records.some((r) => r.type === "websocket-open" && new URL(r.url).pathname === "/signal"),
      `${name} websocket-open on /signal`,
    ).toBe(true);
    expect(types.has("frame-sent"), `${name} frame-sent`).toBe(true);
    expect(types.has("frame-received"), `${name} frame-received`).toBe(true);
  }
}

const sizeOf = async (file: string) => (await readFile(file).catch(() => Buffer.alloc(0))).length;

test.describe.configure({ timeout: 90_000 });

for (const row of scenarios) {
  test.describe(row.title, () => {
    test.fixme(Boolean(row.todo), row.todo);
    test.use({
      remoteBrowsers: {
        sender: remoteBrowsers[row.sender],
        recipient: remoteBrowsers[row.recipient],
      },
    });

    const path = row.path;
    if (path === "none") {
      // Paused, not stopped: coturn keeps its address, so packets to it go unanswered.
      test.afterEach(resumeRelay);

      test("says it couldn't connect, and nothing goes another way", async ({
        actor,
        observed,
        leaks,
        canary,
        baseURL,
      }) => {
        await routerMode("router-b", row.routerB);
        await pauseRelay();
        const stdoutStart = await sizeOf(serverStdoutLog);
        const file = leaks.watch(canaryFile(canary.fork("file"), { size: 300_001 }));

        const sender = await actor("sender");
        await recordPeerConnections(sender.context);
        await sender.page.goto("/send");
        await sender.page.getByLabel("Choose a file").setInputFiles({
          name: file.name,
          mimeType: file.mime,
          buffer: file.bytes,
        });
        await sender.page.getByLabel("Who is it for?").fill("Anna");
        await sender.page.getByRole("button", { name: "Add", exact: true }).click();
        const link =
          (await sender.page.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
        leaks.watchKey("link secret", new URL(link).hash.slice(1));

        const recipient = await actor("recipient");
        await recordPeerConnections(recipient.context);
        let downloads = 0;
        recipient.page.on("download", () => downloads++);
        await recipient.page.goto(link);
        // Exact: "Couldn't connect" alone also matches the server panel.
        await expect(
          recipient.page.getByText("Couldn't connect to the sender's computer", { exact: true }),
        ).toBeVisible({ timeout: 45_000 });
        await expect(recipient.page.getByRole("button", { name: "Download" })).toHaveCount(0);
        expect(downloads).toBe(0);
        expect(await pathOf(sender.page)).toBe("none");
        expect(await pathOf(recipient.page)).toBe("none");

        // The sender reported the failed path; no fallback carried the file.
        await expect
          .poll(async () =>
            (await readFile(serverStdoutLog))
              .subarray(stdoutStart)
              .toString()
              .split("\n")
              .includes('{"event":"path","path":"failed"}'),
          )
          .toBe(true);
        await expectSignaling(observed, baseURL);
      });
      return;
    }

    test("transfers the file on the expected path", async ({
      actor,
      observed,
      leaks,
      canary,
      baseURL,
    }) => {
      await routerMode("router-b", row.routerB);
      const file = leaks.watch(canaryFile(canary.fork("file"), { size: 300_001 }));

      const sender = await actor("sender");
      await recordPeerConnections(sender.context);
      await sender.page.goto("/send");
      await sender.page.getByLabel("Choose a file").setInputFiles({
        name: file.name,
        mimeType: file.mime,
        buffer: file.bytes,
      });
      await sender.page.getByLabel("Who is it for?").fill("Anna");
      await sender.page.getByRole("button", { name: "Add", exact: true }).click();
      const link =
        (await sender.page.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
      leaks.watchKey("link secret", new URL(link).hash.slice(1));

      const recipient = await actor("recipient");
      await recordPeerConnections(recipient.context);
      await recipient.page.goto(link);
      const downloading = recipient.page.waitForEvent("download");
      await recipient.page.getByRole("button", { name: "Download" }).click();
      await expect(recipient.page.getByText("this is exactly the file that was sent")).toBeVisible({
        timeout: 60_000,
      });
      // path() is not available from a remote browser.
      const download = await downloading;
      expect(sha256Hex(await buffer(await download.createReadStream()))).toBe(
        sha256Hex(file.bytes),
      );

      await expect
        .poll(async () => `${await pathOf(sender.page)} ${await pathOf(recipient.page)}`)
        .toMatch(path);
      await watchIcePasswords(leaks, "sender", sender.page);
      await watchIcePasswords(leaks, "recipient", recipient.page);

      await expectSignaling(observed, baseURL);
    });
  });
}
