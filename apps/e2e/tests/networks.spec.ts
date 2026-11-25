import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { buffer } from "node:stream/consumers";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "@playwright/test";
import {
  canaryFile,
  canaryKey,
  delivered as deliveredRow,
  expect,
  type Leaks,
  type Observed,
  test,
} from "../src/fixtures.ts";
import { readPeerConnections, recordPeerConnections, selectedPair } from "../src/ice.ts";
import { checkServerLog, serverLogAllowlist } from "../src/leaks/server-log.ts";
import { boxJournal, boxSyslog, serverStdoutLog } from "../src/paths.ts";
import { winningJournald } from "../src/stack/box.ts";
import {
  boxOrigin,
  clientAddresses,
  inBox,
  pauseRelay,
  type RouterMode,
  remoteBrowsers,
  resumeRelay,
  routerMode,
  sendToRelay,
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
   * A local relay candidate carries its transport to the TURN server, such as `relay+tls`.
   * `none`: the row pauses coturn, so the browsers cannot connect at all.
   */
  path: RegExp | "none";
  /** Send a larger file and check that both sides report progress honestly along the way. */
  progress?: true;
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
    path: / relay\+tls\/\S+$/,
  },
  {
    title: "only TCP 443",
    sender: "a1",
    recipient: "b1",
    routerB: "tcp-443",
    path: / relay\+tls\/\S+$/,
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
    progress: true,
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

const verifiedText = "this is exactly the file that was sent";

/**
 * Samples both pages until the recipient shows the verified text, and checks that progress was
 * honest: the recipient's bar never went back or past the file, showed at least three values in
 * between, and the sender said delivered only once the recipient had verified the file.
 */
async function expectHonestProgress(sender: Page, recipient: Page, size: number): Promise<void> {
  const bar = recipient.getByLabel("Download progress", { exact: true });
  const delivered = deliveredRow(sender, "Anna");
  const verified = recipient.getByText(verifiedText);
  const values: number[] = [];
  const deadline = Date.now() + 60_000;
  for (;;) {
    // Sender first: the recipient's verified text never goes away, so a delivered sender
    // followed by an unverified recipient means the sender was early.
    const senderDelivered = (await delivered.count()) > 0;
    const recipientVerified = await verified.isVisible();
    expect(
      senderDelivered && !recipientVerified,
      "sender delivered before recipient verified",
    ).toBe(false);
    if (recipientVerified) {
      break;
    }
    const value = (
      await bar.evaluateAll((els) => els.map((el) => (el as HTMLProgressElement).value))
    )[0];
    if (value !== undefined) {
      expect(value, "progress went back").toBeGreaterThanOrEqual(values.at(-1) ?? 0);
      expect(value, "progress past the file").toBeLessThanOrEqual(size);
      values.push(value);
    }
    expect(Date.now(), "recipient verified in time").toBeLessThan(deadline);
    await sleep(150);
  }
  const between = new Set(values.filter((v) => v > 0 && v < size));
  expect(
    between.size,
    `distinct values between 0 and size: ${values.join(",")}`,
  ).toBeGreaterThanOrEqual(3);
  await expect(delivered).toBeAttached();
}

const sizeOf = async (file: string) => (await readFile(file).catch(() => Buffer.alloc(0))).length;

test.describe.configure({ timeout: 90_000 });

test("the leak scan sees what reaches coturn", async ({ leaks, canary }) => {
  const file = leaks.watch(canaryFile(canary.fork("file"), { size: 4_001 }));
  const key = canaryKey(canary.fork("key"));
  leaks.watchKey("planted key", key.text);
  await sendToRelay(Buffer.concat([file.bytes.subarray(1000, 1200), Buffer.from(key.text)]));

  const found = (await leaks.scan())
    .filter((finding) => finding.point === "observations/run/coturn.pcap")
    .map((finding) => finding.label);
  expect(found).toEqual(expect.arrayContaining(["file#1", "planted key text"]));
  leaks.expectLeaks();
});

for (const row of scenarios) {
  test.describe(row.title, () => {
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
        await sender.page.getByRole("button", { name: "Create link", exact: true }).click();
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
      // ponytail: 1 MiB, not 3: SCTP over this link moves about 50 KB/s, so 3 MiB took a minute.
      const size = row.progress ? 1024 * 1024 + 1 : 300_001;
      const file = leaks.watch(canaryFile(canary.fork("file"), { size }));

      const sender = await actor("sender");
      await recordPeerConnections(sender.context);
      await sender.page.goto("/send");
      await sender.page.getByLabel("Choose a file").setInputFiles({
        name: file.name,
        mimeType: file.mime,
        buffer: file.bytes,
      });
      await sender.page.getByLabel("Who is it for?").fill("Anna");
      await sender.page.getByRole("button", { name: "Create link", exact: true }).click();
      const link =
        (await sender.page.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
      leaks.watchKey("link secret", new URL(link).hash.slice(1));

      const recipient = await actor("recipient");
      await recordPeerConnections(recipient.context);
      await recipient.page.goto(link);
      const downloading = recipient.page.waitForEvent("download", { timeout: 60_000 });
      const downloadButton = recipient.page.getByRole("button", { name: "Download" });
      await expect(downloadButton).toBeVisible({ timeout: 45_000 });
      await downloadButton.click();
      if (row.progress) {
        await expectHonestProgress(sender.page, recipient.page, size);
      }
      await expect(recipient.page.getByText(verifiedText)).toBeVisible({ timeout: 60_000 });
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

/**
 * One `journalctl -o json --all` entry. MESSAGE is a byte array when it is not valid UTF-8 text;
 * without --all it would also be null when over 4096 bytes.
 */
interface JournalEntry {
  MESSAGE?: string | number[] | null;
  _SYSTEMD_UNIT?: string;
}

/** A missing MESSAGE throws, so a line the checks cannot read fails the test instead of passing them. */
const messageOf = (entry: JournalEntry) => {
  if (typeof entry.MESSAGE === "string") {
    return entry.MESSAGE;
  }
  if (Array.isArray(entry.MESSAGE)) {
    return Buffer.from(entry.MESSAGE).toString("utf8");
  }
  throw new Error(`journal entry without MESSAGE: ${JSON.stringify(entry).slice(0, 200)}`);
};

/** Matches the address on its own, so 198.51.100.2 does not match 198.51.100.20. */
const addressPattern = (ip: string) => new RegExp(`(?<![\\d.])${ip.replaceAll(".", "\\.")}(?!\\d)`);

// The POC box (networks/box): what its journal and /var/log/syslog hold after one relayed
// transfer. /privacy promises the journal is the only log store and keeps lines 29 days.
test.describe("the box", () => {
  test.use({
    baseURL: boxOrigin,
    remoteBrowsers: { sender: remoteBrowsers.a1, recipient: remoteBrowsers.b1 },
  });

  test("logs a relayed transfer only to its journal, within the allowlist", async ({
    actor,
    observed,
    leaks,
    canary,
    baseURL,
  }) => {
    await routerMode("router-b", "symmetric");
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
    await sender.page.getByRole("button", { name: "Create link", exact: true }).click();
    const link =
      (await sender.page.getByLabel("Link for Anna", { exact: true }).textContent()) ?? "";
    leaks.watchKey("link secret", new URL(link).hash.slice(1));

    const recipient = await actor("recipient");
    await recordPeerConnections(recipient.context);
    await recipient.page.goto(link);
    const downloading = recipient.page.waitForEvent("download", { timeout: 60_000 });
    const downloadButton = recipient.page.getByRole("button", { name: "Download" });
    await expect(downloadButton).toBeVisible({ timeout: 45_000 });
    await downloadButton.click();
    await expect(recipient.page.getByText(verifiedText)).toBeVisible({ timeout: 60_000 });
    const download = await downloading;
    expect(sha256Hex(await buffer(await download.createReadStream()))).toBe(sha256Hex(file.bytes));
    // Relayed by the box's coturn over TLS on 443, through HAProxy, as in production. The box
    // hands out only turn.fidant.se, and Chrome resolves that name through --host-resolver-rules
    // for TCP only: its UDP STUN and TURN lookups fail here.
    await expect
      .poll(async () => `${await pathOf(sender.page)} ${await pathOf(recipient.page)}`)
      .toMatch(/relay\+tls\//);
    await watchIcePasswords(leaks, "sender", sender.page);
    await watchIcePasswords(leaks, "recipient", recipient.page);
    await expectSignaling(observed, baseURL);
    const userAgents = await Promise.all(
      [sender.page, recipient.page].map((page) => page.evaluate(() => navigator.userAgent)),
    );

    // The path report is the last line the server logs for a transfer.
    let journal = "";
    const entries = () =>
      journal
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JournalEntry);
    const sigillLines = () =>
      entries()
        .filter((entry) => entry._SYSTEMD_UNIT === "sigill.service")
        .map(messageOf);
    await expect
      .poll(async () => {
        journal = await inBox(
          ..."journalctl -o json --all --no-pager -u sigill -u haproxy -u caddy -u coturn".split(
            " ",
          ),
        );
        // The decoded messages as plain lines, which is what the leak scanner reads; JSON
        // escapes and decimal byte arrays would hide a canary from it. Kept on every attempt.
        // A binary MESSAGE goes in as hex: the scanner reads logs as UTF-8, which would mangle
        // raw file bytes, and it matches hex views.
        await writeFile(
          boxJournal,
          `${entries()
            .map((entry) =>
              Array.isArray(entry.MESSAGE)
                ? Buffer.from(entry.MESSAGE).toString("hex")
                : messageOf(entry),
            )
            .join("\n")}\n`,
        );
        return sigillLines().some((line) => line.startsWith('{"event":"path"'));
      })
      .toBe(true);

    // Straight to rsyslog's socket: journald forwards nothing, so this proves rsyslog writes.
    const probe = randomBytes(8).toString("hex");
    await inBox("logger", "-u", "/run/systemd/journal/syslog", "-t", "sigill-e2e-probe", probe);
    let syslog = "";
    await expect
      .poll(async () => {
        syslog = await inBox("cat", "/var/log/syslog");
        await writeFile(boxSyslog, syslog);
        return syslog.includes(probe);
      })
      .toBe(true);

    const services =
      /\s(node|haproxy|caddy|turnserver|coturn)(\[\d+\])?:|(sigill|haproxy|caddy|coturn)\.service/;
    expect(syslog.split("\n").filter((line) => services.test(line))).toEqual([]);

    const { files, settings } = winningJournald(
      await inBox("systemd-analyze", "cat-config", "systemd/journald.conf"),
    );
    expect(files).toEqual(
      expect.arrayContaining([
        "/usr/lib/systemd/journald.conf.d/syslog.conf",
        "/etc/systemd/journald.conf.d/zz-retention.conf",
      ]),
    );
    expect(Object.fromEntries(settings)).toMatchObject({
      ForwardToSyslog: "no",
      MaxRetentionSec: "29day",
      MaxFileSec: "1day",
    });

    // Every line of the app server is an allowlisted JSON object; the banner goes only to a TTY.
    const lines = sigillLines();
    expect(checkServerLog(lines, serverLogAllowlist)).toEqual([]);
    const events = new Set(lines.map((line) => (JSON.parse(line) as { event: string }).event));
    expect([...events]).toEqual(expect.arrayContaining(["joined", "path"]));

    const addresses = await clientAddresses();
    expect(addresses.length).toBeGreaterThan(0);
    const messages = entries().map(messageOf);
    for (const ip of addresses) {
      expect(
        messages.filter((m) => addressPattern(ip).test(m)),
        ip,
      ).toEqual([]);
    }
    for (const agent of [...userAgents, "Mozilla/"]) {
      expect(
        messages.filter((m) => m.includes(agent)),
        agent,
      ).toEqual([]);
    }
  });
});
