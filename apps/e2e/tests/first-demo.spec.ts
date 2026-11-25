import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { maskAddress } from "@sigill/protocol";
import {
  breakableSender,
  canaryFile,
  canaryKey,
  delivered,
  expect,
  test as harness,
  type Leaks,
  makeName,
  type Observed,
  recipientRow,
} from "../src/fixtures.ts";
import { base32Token, type CanaryFile, type SeededRandom } from "../src/leaks/canary.ts";
import type { Allowed } from "../src/leaks/needles.ts";
import { type Message, mailTo } from "../src/mail.ts";
import { serverStderrLog, serverStdoutLog } from "../src/paths.ts";
import { restartServer } from "../src/stack/server.ts";

// The first demo end to end: a sender page sends one file to named recipients, each recipient on
// their own link and in their own browser context. The harness's leak check runs after every test
// and searches everything the browsers sent and received and everything the server logged for the
// file, its name, type and size, the link secrets and the sender and recipient names.

const MiB = 1024 * 1024;

/** Signaling must never carry these: SDP is encrypted before it is relayed. */
const sdpMarkers = ["v=0", "a=fingerprint", "a=ice-ufrag"];

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

interface Demo {
  /** A recorded browser context named `name`, whose page saves files as Blob downloads. */
  open(name: string): Promise<Page>;
}

const test = harness.extend<{ demo: Demo }>({
  demo: async ({ actor, observed }, use) => {
    const names: string[] = [];
    const pageErrors: string[] = [];
    await use({
      async open(name) {
        const { context, page } = await actor(name);
        names.push(name);
        await context.addInitScript(() => {
          // Force the recipient's Blob fallback so the file arrives as a download.
          delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
        });
        page.on("pageerror", (error) => pageErrors.push(`${name}: ${error.message}`));
        return page;
      },
    });

    const frames: { type: string; text: string }[] = [];
    for (const name of names) {
      for (const record of await observed(name).records()) {
        if (record.type !== "frame-sent" && record.type !== "frame-received") {
          continue;
        }
        // Binary frames are recorded as base64.
        const text = record.base64
          ? Buffer.from(record.payload, "base64").toString()
          : record.payload;
        frames.push({ type: record.type, text });
      }
    }
    const sdp = frames.flatMap(({ type, text }) =>
      sdpMarkers.filter((marker) => text.includes(marker)).map((m) => `${m} in ${type}`),
    );
    expect(sdp, "plaintext SDP over signaling").toEqual([]);
    // Guards the checks above and the leak scan against a recorder that saw no signaling.
    expect(
      frames.some((f) => f.type === "frame-sent"),
      "captured sent frames",
    ).toBe(true);
    expect(
      frames.some((f) => f.type === "frame-received"),
      "captured received frames",
    ).toBe(true);
    expect(pageErrors, "uncaught page errors").toEqual([]);
  },
});

// The 8 MiB transfer and its leak scan take longer than Playwright's default.
test.describe.configure({ timeout: 90_000 });

/** A watched canary file of exactly `size` bytes. */
function makeFile(leaks: Leaks, canary: SeededRandom, size: number): CanaryFile {
  return leaks.watch(canaryFile(canary.fork("file"), { size }));
}

/** Opens the sender page, runs `setup` on it before it loads, types the sender's name if given, and chooses the file. */
async function openSender(
  demo: Demo,
  file: CanaryFile,
  from = "",
  setup?: (page: Page) => Promise<unknown>,
): Promise<Page> {
  const page = await demo.open("sender");
  await setup?.(page);
  await page.goto("/send");
  if (from) {
    await page.getByLabel("Your name").fill(from);
  }
  await page.getByLabel("Choose a file").setInputFiles({
    name: file.name,
    mimeType: file.mime,
    buffer: file.bytes,
  });
  await page.getByText("Technical details").click();
  await expect(page.getByText(sha256Hex(file.bytes))).toBeVisible();
  return page;
}

/** Adds a recipient on the sender page and returns their link, with its secret watched. */
async function addRecipient(leaks: Leaks, sender: Page, name: string): Promise<string> {
  await sender.getByLabel("Who is it for?").fill(name);
  await sender.getByRole("button", { name: "Create link", exact: true }).click();
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  const secret = new URL(link).hash.slice(1);
  expect(secret, `link secret for ${name}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
  leaks.watchKey(`link secret for ${name}`, secret);
  return link;
}

/** Opens a link as `actor`, checks the offer, downloads, and returns the bytes of the automatic download. */
async function receive(
  demo: Demo,
  actor: string,
  link: string,
  file: CanaryFile,
  sizeText: string,
  from = "",
  sender?: Page,
) {
  const page = await demo.open(actor);
  await page.goto(link);
  const heading = from ? `${from} wants to send you a file` : "You've been sent a file";
  await expect(page.getByRole("heading", { name: heading })).toBeFocused();
  await expect(page.getByText("Name typed by the sender, not verified.")).toHaveCount(from ? 1 : 0);
  await expect(page.getByText(file.name)).toBeVisible();
  await expect(page.getByText(sizeText, { exact: true })).toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.getByText(`${file.size.toLocaleString("en-US")} bytes`)).toBeVisible();
  await expect(page.getByRole("region", { name: "What our server has right now" })).toContainText(
    "this page is connected to the sender",
  );
  if (sender) {
    await expect(
      sender.getByRole("region", { name: "What our server has right now" }),
    ).toContainText(/[1-9] recipients? connected right now/);
  }
  const bytes = await download(page, file);
  // The typed name is unverified, so it stays on the offer screen only.
  if (from) {
    await expect(page.getByText(from)).toHaveCount(0);
  }
  const again = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("link", { name: "Save file" }).click();
  expect((await again).suggestedFilename()).toBe(file.name);
  return { page, bytes };
}

/** Clicks Download on the offer screen, waits for the verified file and returns its bytes. */
async function download(page: Page, file: CanaryFile): Promise<Buffer> {
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download" }).click();
  await expect(page.getByText("this is exactly the file that was sent")).toBeVisible({
    timeout: 60_000,
  });
  const saved = await downloading;
  expect(saved.suggestedFilename()).toBe(file.name);
  await expect(page.getByRole("heading", { name: "Download complete" })).toBeFocused();
  return readFile(await saved.path());
}

test("delivers a file to two recipients with a verified checksum", async ({
  demo,
  leaks,
  canary,
}) => {
  // Odd size so the last chunk is partial and padding is exercised.
  const file = makeFile(leaks, canary, 8 * MiB + 321);
  const from = makeName(leaks, canary, "David");
  const sender = await openSender(demo, file, from);
  const names = [makeName(leaks, canary, "Anna"), makeName(leaks, canary, "Erik")];
  const links: string[] = [];
  for (const name of names) {
    links.push(await addRecipient(leaks, sender, name));
  }

  const received = await Promise.all(
    links.map((link, i) => receive(demo, `recipient-${i + 1}`, link, file, "8.4 MB", from, sender)),
  );
  for (const { bytes } of received) {
    expect(sha256Hex(bytes)).toBe(sha256Hex(file.bytes));
  }

  for (const name of names) {
    await expect(delivered(sender, name)).toBeAttached();
  }
  await sender.getByText("Show details", { exact: true }).click();
  const cards = names.map((name) => recipientRow(sender, name));
  for (const scope of [...cards, ...received.map(({ page }) => page)]) {
    await expect(scope.getByText("Direct connection", { exact: true })).toBeVisible();
    await scope.getByText("Why?", { exact: true }).click();
    await expect(scope.getByText("The file goes straight between the two devices.")).toBeVisible();
    await expect(scope.getByRole("link", { name: /More about how it works/ })).toHaveAttribute(
      "href",
      "/how#direct",
    );
  }

  const panel = sender.getByRole("region", { name: "What our server has right now" });
  await expect(panel).toContainText("None. The file goes directly between browsers.");
  await expect(panel).toContainText(/[1-9]\d* setup messages? \(/);

  const recipientPanel = received[0]?.page.getByRole("region", {
    name: "What our server has right now",
  });
  if (!recipientPanel) {
    throw new Error("no recipient");
  }
  await expect(recipientPanel).toContainText(
    "Nothing about this page once it notices the connection has closed",
  );
  await expect(recipientPanel).toContainText(/[1-9]\d* setup messages? \(/);
});

test("refuses used, unknown and malformed links", async ({ demo, leaks, canary, baseURL }) => {
  const file = makeFile(leaks, canary, 100_001);
  const sender = await openSender(demo, file);
  const name = makeName(leaks, canary, "Anna");
  const link = await addRecipient(leaks, sender, name);

  const first = await receive(demo, "recipient", link, file, "100 KB");
  expect(sha256Hex(first.bytes)).toBe(sha256Hex(file.bytes));
  await expect(delivered(sender, name)).toBeAttached();
  await first.page.context().close();

  const reopened = await demo.open("reopened");
  await reopened.goto(link);
  await expect(reopened.getByText("This link has already been used")).toBeVisible();

  // Well formed, but no sender hosts it: the server refuses.
  const unlistedSecret = canaryKey(canary.fork("unlisted secret")).text;
  leaks.watchKey("unlisted link secret", unlistedSecret);
  const linkId = canary.fork("unlisted link id").bytes(16).toString("base64url");
  const unlisted = await demo.open("unlisted");
  await unlisted.goto(`${baseURL}/r/${linkId}#${unlistedSecret}`);
  await expect(unlisted.getByText("This link isn't active")).toBeVisible();

  const malformed = await demo.open("malformed");
  await malformed.goto("/r/not-a-link#nope");
  await expect(malformed.getByText("This link doesn't work")).toBeVisible();
  await expect(
    malformed.getByRole("region", { name: "What our server has right now" }),
  ).toHaveCount(0);
});

test("a sender whose connection setup fails logs why and lets the recipient try again", async ({
  demo,
  observed,
  leaks,
  canary,
}) => {
  const sender = await openSender(demo, makeFile(leaks, canary, 10), "", (page) =>
    page.addInitScript(() => {
      RTCPeerConnection.prototype.setLocalDescription = () =>
        Promise.reject(new DOMException("injected", "OperationError"));
    }),
  );
  const link = await addRecipient(leaks, sender, makeName(leaks, canary, "Anna"));
  const recipient = await demo.open("recipient");
  await recipient.goto(link);

  const logged = async () =>
    (await observed("sender").records()).flatMap((r) => (r.type === "console" ? [r.text] : []));
  await expect
    .poll(logged)
    .toContain("sigill: sender dropped a connection: setup-failed (OperationError)");
  expect((await logged()).filter((text) => text.includes("injected"))).toEqual([]);

  const refusals = async () =>
    (await observed("recipient").records()).flatMap((r) => {
      if (r.type !== "frame-received" || r.base64) {
        return [];
      }
      const message = JSON.parse(r.payload) as { t: string; reason?: string };
      return message.t === "refused" ? [message.reason] : [];
    });
  await expect.poll(refusals).toEqual(["drop"]);
  await expect(
    recipient.getByRole("heading", { name: "Couldn't connect to the sender's computer" }),
  ).toBeVisible();
  await expect(recipient.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(recipient.getByText("This link is open somewhere else")).toHaveCount(0);
});

test("a declined offer shows as declined, and the link can be reopened", async ({
  demo,
  leaks,
  canary,
}) => {
  const file = makeFile(leaks, canary, 100_001);
  const sender = await openSender(demo, file);
  const name = makeName(leaks, canary, "Erik");
  const link = await addRecipient(leaks, sender, name);

  const recipient = await demo.open("recipient");
  await recipient.goto(link);
  const opened = recipientRow(sender, name).getByText(`${name}'s link has been opened`);
  await expect(opened).toBeVisible();
  const decline = recipient.getByRole("button", { name: "Decline" });
  await expect(decline).toBeVisible();
  const offerHeading = await recipient.locator("#receive h1").elementHandle();
  // From the keyboard, so the browser would show a focus ring on the next focused element.
  await decline.focus();
  await recipient.keyboard.press("Enter");
  const declined = recipient.getByRole("heading", { name: "You declined the file" });
  await expect(declined).toBeFocused();
  // Script moved focus there to announce the step; a heading isn't a control, so no ring.
  await expect(declined).toHaveCSS("outline-style", "none");
  // A new heading node, not the offer's heading with new text, so screen readers announce it.
  expect(await offerHeading.evaluate((h) => h.isConnected)).toBe(false);
  await expect(
    recipientRow(sender, name).getByText(
      `${name}'s link was opened and the file was declined. The link still works.`,
    ),
  ).toBeVisible();
  await expect(sender.getByRole("button", { name: `Copy link for ${name}` })).toBeVisible();

  await recipient.getByRole("button", { name: "Show the file again" }).click();
  await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible();
  await expect(opened).toBeVisible();
});

// No one joins here, so the sender receives no signaling and the demo fixture's frame checks don't apply.
harness("a held Enter on Remove removes only one recipient", async ({ actor, leaks, canary }) => {
  const demo: Demo = { open: async (name) => (await actor(name)).page };
  const sender = await openSender(demo, makeFile(leaks, canary, 10));
  const anna = makeName(leaks, canary, "Anna");
  const erik = makeName(leaks, canary, "Erik");
  await addRecipient(leaks, sender, anna);
  await addRecipient(leaks, sender, erik);

  await sender.getByRole("button", { name: `Remove ${anna}` }).focus();
  await sender.keyboard.down("Enter");
  await expect(sender.getByRole("button", { name: `Remove ${erik}` })).toBeFocused();
  await sender.keyboard.down("Enter"); // auto-repeat while held
  await sender.keyboard.up("Enter");
  await expect(recipientRow(sender, anna)).toHaveCount(0);
  await expect(sender.getByRole("button", { name: `Copy link for ${erik}` })).toBeVisible();

  await sender.keyboard.down("Enter");
  await expect(recipientRow(sender, erik)).toHaveCount(0);
  await expect(sender.getByLabel("Who is it for?")).toBeFocused();
  await sender.keyboard.down("Enter"); // the repeat lands on the empty name field
  await sender.keyboard.up("Enter");
  await expect(sender.getByText("Enter a name.")).toHaveCount(0);
});

harness("a recipient gives up connecting after 30 seconds", async ({ actor, leaks, canary }) => {
  const demo: Demo = { open: async (name) => (await actor(name)).page };
  const sender = await openSender(demo, makeFile(leaks, canary, 10));
  const anna = makeName(leaks, canary, "Anna");
  const link = await addRecipient(leaks, sender, anna);

  const recipient = await demo.open("recipient");
  // The sender's offer never lands, so the data channel never opens.
  await recipient.addInitScript(() => {
    RTCPeerConnection.prototype.setRemoteDescription = () => new Promise(() => {});
  });
  await recipient.clock.install();
  await recipient.goto(link);
  await expect(recipient.getByRole("heading", { name: "Connecting to the sender…" })).toBeVisible();
  // The server tells the sender only after it sent `joined`, so the recipient's peer exists by now.
  await expect(
    recipientRow(sender, anna).getByText(`Connecting through ${anna}'s link…`),
  ).toBeVisible();

  await recipient.clock.fastForward(29_000);
  await expect(recipient.getByRole("heading", { name: "Connecting to the sender…" })).toBeVisible();
  await recipient.clock.fastForward(1_000);
  await expect(recipient.getByText("Couldn't connect to the sender's computer")).toBeVisible();
  await expect(recipient.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("the sender's name must fit with the file name, and stray drops are ignored", async ({
  demo,
  leaks,
  canary,
}) => {
  // A canary file whose name is padded to 884 characters: too long with a 100-character sender name, short enough with a short one.
  const base = canaryFile(canary.fork("long file name"), { size: 5, ext: "bin" });
  const file = leaks.watch({
    ...base,
    name: base.name.replace(/\.bin$/, `${"r".repeat(884 - base.name.length)}.bin`),
  });
  const page = await demo.open("sender");
  await page.goto("/send");
  await page.getByLabel("Your name").fill("x".repeat(100));
  await page.getByLabel("Choose a file").setInputFiles({
    name: file.name,
    mimeType: file.mime,
    buffer: file.bytes,
  });
  // Whether a dragover and a drop of what `fill` adds (nothing: no DataTransfer) onto `selector` are cancelled.
  const cancelled = async (selector: string, fill = "") => {
    const results = [];
    for (const type of ["dragover", "drop"]) {
      results.push(
        await page.evaluate(`(() => {
          const dt = ${fill ? "new DataTransfer()" : "null"};
          ${fill};
          const e = new DragEvent("${type}", { bubbles: true, cancelable: true, dataTransfer: dt });
          document.querySelector("${selector}").dispatchEvent(e);
          return e.defaultPrevented;
        })()`),
      );
    }
    return results;
  };
  const someFile = `dt.items.add(new File(["x"], "x.bin"))`;
  const text = `dt.setData("text/plain", "x")`;
  expect(await cancelled("#file", someFile)).toEqual([false, false]);
  expect(await cancelled("#file", text)).toEqual([true, true]);
  expect(await cancelled("#recipient-name", text)).toEqual([false, false]);
  expect(await cancelled("#recipient-name", someFile)).toEqual([true, true]);
  const name = makeName(leaks, canary, "Anna");
  await page.getByLabel("Who is it for?").fill(name);
  await page.getByRole("button", { name: "Create link", exact: true }).click();
  await expect(page.getByText("Your name and the file name are too long together")).toBeVisible();
  await expect(page.getByRole("list", { name: "Recipients" })).toHaveCount(0);

  const from = makeName(leaks, canary, "Al");
  await page.getByLabel("Your name").fill(from);
  await expect(page.getByText("Your name and the file name are too long together")).toHaveCount(0);
  const link = await addRecipient(leaks, page, name);
  await expect(page.getByLabel("Your name")).toBeDisabled();

  expect(await cancelled("#from", text)).toEqual([true, true]);
  expect(await cancelled("body")).toEqual([true, true]);

  const recipient = await demo.open("recipient");
  await recipient.goto(link);
  await expect(
    recipient.getByRole("heading", { name: `${from} wants to send you a file` }),
  ).toBeVisible();
});

test("a waiting recipient sees when the sender goes offline", async ({ demo, leaks, canary }) => {
  const file = makeFile(leaks, canary, 100_001);
  const sender = await openSender(demo, file);
  const link = await addRecipient(leaks, sender, makeName(leaks, canary, "Anna"));

  const recipient = await demo.open("recipient");
  await recipient.goto(link);
  await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible();
  await sender.close();
  await expect(recipient.getByText("The sender's page is closed")).toBeVisible();
  await expect(
    recipient.getByRole("region", { name: "What our server has right now" }),
  ).toContainText("Nothing about this page once it notices the connection has closed");
});

test("the Why? link to /how keeps a transfer alive on both pages", async ({
  demo,
  leaks,
  canary,
}) => {
  const file = makeFile(leaks, canary, 100_001);
  const sender = await openSender(demo, file);
  const name = makeName(leaks, canary, "Anna");
  const link = await addRecipient(leaks, sender, name);

  const recipient = await demo.open("recipient");
  await recipient.goto(link);
  const download = recipient.getByRole("button", { name: "Download" });
  await expect(download).toBeVisible();
  const card = recipientRow(sender, name);
  const opened = card.getByText(`${name}'s link has been opened`);
  await expect(opened).toBeVisible();

  // A remounted receive page would rejoin from the same URL, so only node identity tells it apart.
  const kept = [await card.elementHandle(), await recipient.locator("#receive h1").elementHandle()];
  for (const [page, scope] of [
    [sender, card],
    [recipient, recipient],
  ] as const) {
    await expect(scope.getByText("Direct connection", { exact: true })).toBeVisible();
    const back = page.url();
    await scope.getByText("Why?", { exact: true }).click();
    await scope.getByRole("link", { name: "More about how it works" }).click();
    await expect(page).toHaveURL(/\/how#direct$/);
    await expect(page.locator("#direct h2")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(back);
  }
  for (const node of kept) {
    expect(await node.evaluate((n) => n.isConnected)).toBe(true);
  }
  await expect(download).toBeVisible();
  await expect(opened).toBeVisible();

  const downloading = recipient.waitForEvent("download", { timeout: 60_000 });
  await download.click();
  await expect(recipient.getByText("this is exactly the file that was sent")).toBeVisible({
    timeout: 60_000,
  });
  const bytes = await readFile(await (await downloading).path());
  expect(sha256Hex(bytes)).toBe(sha256Hex(file.bytes));
  await expect(delivered(sender, name)).toBeAttached();
});

test("a lost sender says whether the file may have been saved", async ({ demo, leaks, canary }) => {
  const file = makeFile(leaks, canary, 100_001);
  const sender = await openSender(demo, file, "", (page) => page.addInitScript(breakableSender));
  const stall = (stalled: boolean) =>
    sender.evaluate((on) => {
      (globalThis as { stalled?: boolean }).stalled = on;
    }, stalled);
  const cut = () => sender.evaluate(() => (globalThis as { cut?: () => void }).cut?.());

  /** Opens a link for `first` and, if `download`, starts a download the stalled sender never feeds. */
  const join = async (first: string, download: boolean) => {
    const link = await addRecipient(leaks, sender, makeName(leaks, canary, first));
    await stall(false);
    const page = await demo.open(first.toLowerCase());
    await page.goto(link);
    await expect(page.getByRole("button", { name: "Download" })).toBeVisible();
    if (download) {
      await stall(true);
      await page.getByRole("button", { name: "Download" }).click();
      await expect(page.getByRole("heading", { name: "Downloading…" })).toBeVisible();
    }
    return page;
  };

  // Before the download: nothing can have been saved.
  const anna = await join("Anna", false);
  await cut();
  await expect(anna.getByText("The connection to the sender was lost")).toBeVisible();
  await expect(anna.getByText("Nothing was saved.")).toBeVisible();

  // Mid-download, the connection drops while the sender's page stays open.
  const erik = await join("Erik", true);
  await cut();
  await expect(erik.getByText("The connection to the sender was lost")).toBeVisible();
  await expect(erik.getByText("The file may not have been saved.")).toBeVisible();

  // Mid-download, the sender's page closes. Its pagehide closes the peers, so the drop arrives
  // at once instead of when ICE consent expires (about 15 s).
  const bo = await join("Bo", true);
  await sender.close();
  await expect(bo.getByText("The sender's page is closed")).toBeVisible({ timeout: 3_000 });
  await expect(bo.getByText("The file may not have been saved.")).toBeVisible();
});

type Tamper = "flip" | "other";

/**
 * Runs in the sender page through addInitScript, so it may use nothing from this module. Alters
 * the frames the sender's data channels send, as a hostile path would deliver them. The server
 * and a TURN relay only see DTLS records, which they can't alter into well-formed frames, so
 * tampering below the app's AES-GCM layer, in the sender, stands in for a broken or hostile
 * transport. It reads only the plaintext header: byte 1 is the kind (see apps/web/src/lib/frames.ts).
 * `other` records the first channel that reaches END and, instead of sending that END, closes the
 * channel, so the transfer is never delivered and the link stays usable. On each later channel it sends the recorded frame at
 * the same index in place of its own, except INIT: an earlier transfer's META, CHUNKs and END
 * under this transfer's fresh transferId, on the same link.
 */
function tamperSender(mode: Tamper) {
  const INIT = 0;
  const CHUNK = 2;
  const END = 3;
  const send = RTCDataChannel.prototype.send;
  const sent = new Map<RTCDataChannel, Uint8Array[]>();
  let source: Uint8Array[] | undefined;
  let flipped = false;
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, data: Uint8Array) {
    const out = (frame: Uint8Array) => Reflect.apply(send, this, [frame]);
    let frame: Uint8Array = data.slice();
    const kind = frame[1];
    if (mode === "other") {
      const own = sent.get(this) ?? [];
      sent.set(this, own);
      if (source && source !== own && kind !== INIT) {
        frame = source[own.length] ?? frame;
      }
      own.push(frame);
      if (kind === END && !source) {
        source = own;
        return this.close();
      }
      return out(frame);
    }
    if (kind === CHUNK && !flipped) {
      flipped = true;
      frame[10] = (frame[10] as number) ^ 1; // the first ciphertext byte, after the 10-byte header
    }
    return out(frame);
  } as RTCDataChannel["send"];
}

/** Counts `page`'s downloads; the returned check expects the invalid-data problem, no download and no delivery to `name`. */
function expectRefusal(page: Page) {
  let downloads = 0;
  page.on("download", () => downloads++);
  return async (sender: Page, name: string) => {
    await expect(page.getByText("Something went wrong with the transfer")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/so nothing was saved\.$/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Download complete" })).toHaveCount(0);
    await expect(page.getByText("this is exactly the file that was sent")).toHaveCount(0);
    expect(downloads, "downloads").toBe(0);
    await expect(delivered(sender, name)).toHaveCount(0);
  };
}

/** A signaling message as JSON; only a `relay` message has `data`. */
type Signal = { t: string; data: string };

/**
 * Passes `page`'s signaling socket through `edit`, as a hostile server could: `sent` is true for
 * what the page sends. Register it before the page loads. A page route takes precedence over the
 * recorder's context route, which then no longer blocks the sockets this one matches, so match only
 * the stack's own. The recorder still sees the frames on the wire, as the server sends and receives
 * them: what the page sends after `edit`, what the server sends before it.
 */
function tamperSignal(page: Page, edit: (message: Signal, sent: boolean) => Signal) {
  const pass = (text: string | Buffer, sent: boolean) =>
    JSON.stringify(edit(JSON.parse(text.toString()) as Signal, sent));
  return page.routeWebSocket(
    // A relative pattern resolves against baseURL, so this matches only the stack's own socket.
    "/signal",
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((text) => server.send(pass(text, true)));
      server.onMessage((text) => ws.send(pass(text, false)));
    },
  );
}

/** Counts `page`'s downloads; the returned check expects the connect error well before the 30 s connect timeout, no offer, no download and no delivery to `name`. */
function expectNoConnection(page: Page) {
  let downloads = 0;
  page.on("download", () => downloads++);
  return async (sender: Page, name: string) => {
    await expect(page.getByText("Couldn't connect to the sender's computer")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: "Download" })).toHaveCount(0);
    expect(downloads, "downloads").toBe(0);
    await expect(delivered(sender, name)).toHaveCount(0);
  };
}

test.describe("a hostile path", () => {
  test("a recipient refuses a data channel frame that was tampered with", async ({
    demo,
    leaks,
    canary,
  }) => {
    const file = makeFile(leaks, canary, 100_001);
    const sender = await openSender(demo, file, "", (page) =>
      page.addInitScript(tamperSender, "flip" as const),
    );
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const recipient = await demo.open("recipient");
    const refused = expectRefusal(recipient);
    await recipient.goto(link);
    const downloadButton = recipient.getByRole("button", { name: "Download" });
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });
    await downloadButton.click();
    await refused(sender, name);
  });

  test("a recipient refuses an earlier transfer's frames replayed on its link", async ({
    demo,
    leaks,
    canary,
  }) => {
    const file = makeFile(leaks, canary, 100_001);
    const sender = await openSender(demo, file, "", (page) =>
      page.addInitScript(tamperSender, "other" as const),
    );
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);

    // Attempt 1 is recorded, and the sender closes the channel instead of sending END.
    const recipient = await demo.open("recipient");
    await recipient.goto(link);
    const downloadButton = recipient.getByRole("button", { name: "Download" });
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });
    await downloadButton.click();
    await expect(recipient.getByText("The connection to the sender was lost")).toBeVisible();

    // Attempt 2 is the same link and tab: a fresh transferId, attempt 1's frames. Its META fails to open, so there is no offer to download.
    const refused = expectRefusal(recipient);
    await recipient.getByRole("button", { name: "Try again" }).click();
    await refused(sender, name);
  });

  // The server relays signals it can't open: changing or moving their sealed bytes makes them fail
  // to open in the browser, so a hostile server can't swap the DTLS fingerprint in the SDP.

  test("a recipient refuses a relayed signal with one character changed", async ({
    demo,
    leaks,
    canary,
  }) => {
    const sender = await openSender(demo, makeFile(leaks, canary, 10));
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const recipient = await demo.open("recipient");
    let changed = false;
    await tamperSignal(recipient, (message, sent) => {
      if (sent || changed || message.t !== "relay") {
        return message;
      }
      changed = true;
      const i = message.data.length >> 1;
      const other = message.data[i] === "A" ? "B" : "A";
      return { ...message, data: message.data.slice(0, i) + other + message.data.slice(i + 1) };
    });
    const failed = expectNoConnection(recipient);
    await recipient.goto(link);
    await failed(sender, name);
    expect(changed, "changed the sender's offer").toBe(true);
  });

  test("a sender refuses its own offer reflected as the answer", async ({
    demo,
    observed,
    leaks,
    canary,
  }) => {
    let offer: string | undefined;
    let reflected = false;
    const sender = await openSender(demo, makeFile(leaks, canary, 10), "", (page) =>
      tamperSignal(page, (message, sent) => {
        if (message.t !== "relay") {
          return message;
        }
        if (sent) {
          offer ??= message.data;
          return message;
        }
        if (reflected || offer === undefined) {
          return message;
        }
        reflected = true;
        return { ...message, data: offer };
      }),
    );
    const warnings = async () =>
      (await observed("sender").records()).flatMap((r) => (r.type === "console" ? [r.text] : []));
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const recipient = await demo.open("recipient");
    const failed = expectNoConnection(recipient);
    await recipient.goto(link);
    await expect
      .poll(warnings, { timeout: 10_000 })
      .toContain("sigill: sender dropped a connection: bad-signal");
    await failed(sender, name);
    expect(reflected, "reflected the offer").toBe(true);
  });
});

test.describe("through a server restart", () => {
  // The client's reconnect backoff and the recipient's rejoins add to the transfer time.
  test.describe.configure({ timeout: 120_000 });

  const lost = (sender: Page) => sender.getByText("Lost the connection to the server");

  test("a waiting sender re-hosts its links without reloading", async ({
    demo,
    observed,
    leaks,
    canary,
  }) => {
    const file = makeFile(leaks, canary, 100_001);
    const sender = await openSender(demo, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    let navigations = 0;
    sender.on("framenavigated", (frame) => {
      if (frame === sender.mainFrame()) {
        navigations++;
      }
    });
    const hosts = async () =>
      (await observed("sender").records()).filter(
        (r) => r.type === "frame-sent" && !r.base64 && JSON.parse(r.payload).t === "host",
      ).length;
    await expect.poll(hosts).toBeGreaterThan(0);
    const before = await hosts();

    await restartServer();
    await expect.poll(hosts, { timeout: 30_000 }).toBeGreaterThan(before);

    const { bytes } = await receive(demo, "recipient", link, file, "100 KB", "", sender);
    expect(sha256Hex(bytes)).toBe(sha256Hex(file.bytes));
    await expect(delivered(sender, name)).toBeAttached();
    expect(navigations).toBe(0);
    await expect(lost(sender)).toHaveCount(0);
  });

  test("a recipient with an open channel downloads after the restart", async ({
    demo,
    leaks,
    canary,
  }) => {
    const file = makeFile(leaks, canary, 100_001);
    const sender = await openSender(demo, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const recipient = await demo.open("recipient");
    await recipient.goto(link);
    await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible();

    await restartServer();
    const bytes = await download(recipient, file);
    expect(sha256Hex(bytes)).toBe(sha256Hex(file.bytes));
    await expect(delivered(sender, name)).toBeAttached();
  });

  test("a recipient still connecting gets the file after the restart", async ({
    demo,
    leaks,
    canary,
  }) => {
    const file = makeFile(leaks, canary, 100_001);
    const sender = await openSender(demo, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const recipient = await demo.open("recipient");
    // The sender's first offer never lands, so the first attempt stays connecting.
    await recipient.addInitScript(() => {
      const native = RTCPeerConnection.prototype.setRemoteDescription;
      let stalled = false;
      RTCPeerConnection.prototype.setRemoteDescription = function (
        this: RTCPeerConnection,
        ...args: unknown[]
      ) {
        if (!stalled) {
          stalled = true;
          return new Promise(() => {});
        }
        return Reflect.apply(native, this, args);
      } as RTCPeerConnection["setRemoteDescription"];
    });
    await recipient.goto(link);
    await expect(
      recipient.getByRole("heading", { name: "Connecting to the sender…" }),
    ).toBeVisible();
    await expect(
      recipientRow(sender, name).getByText(`Connecting through ${name}'s link…`),
    ).toBeVisible();

    await restartServer();
    await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible({
      timeout: 60_000,
    });
    const bytes = await download(recipient, file);
    expect(sha256Hex(bytes)).toBe(sha256Hex(file.bytes));
    await expect(delivered(sender, name)).toBeAttached();
  });
});

/** A made-up address for `first`, unique to this run, at a reserved domain. */
const addressFor = (canary: SeededRandom, first: string) =>
  `${first.toLowerCase()}-${base32Token(canary.fork(`address ${first}`), 8).toLowerCase()}@example.com`;

interface Emailed {
  /** The link the server emailed: `/r/<linkId>#e.<mark>.<secret>`. */
  link: string;
  linkId: string;
  mark: string;
  secret: string;
  notice: Message;
}

/**
 * Adds `name` with the address `to` and waits for the notice. Watches the link's secret, the
 * server's value, the address and, if given, the sender's typed name `from` where decision 0012
 * lets them appear.
 */
async function addEmailed(
  leaks: Leaks,
  sender: Page,
  name: string,
  to: string,
  from = "",
): Promise<Emailed> {
  await sender.getByLabel("Who is it for?").fill(name);
  await sender.getByLabel("Their email address").fill(to);
  await sender.getByRole("button", { name: "Create and email link", exact: true }).click();
  await expect(
    recipientRow(sender, name).getByText(`Email sent to ${maskAddress(to)}`),
  ).toBeVisible();
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  const url = new URL(link);
  const [, mark = "", secret = ""] = /^#e\.([\w-]{22})\.([\w-]{43})$/.exec(url.hash) ?? [];
  await expect.poll(async () => (await mailTo(to)).length).toBe(1);
  const [notice] = await mailTo(to);
  if (!notice) {
    throw new Error(`no notice to ${to}`);
  }
  expect(notice.Text).toContain(link);
  const linkId = url.pathname.slice("/r/".length);
  const mail: Allowed["mail"] = { to, notice: notice.ID };
  leaks.watchKey(`link secret for ${name}`, secret, "K", {
    link: linkId,
    frames: ["sent email"],
    mail,
  });
  leaks.watchKey(`value for ${name}`, mark, "K", {
    link: linkId,
    frames: ["received email", "sent gate", "sent send-code", "sent code"],
    mail,
  });
  leaks.watchText(`address for ${name}`, to, {
    link: linkId,
    frames: ["sent email"],
    mail: { to },
  });
  if (from) {
    leaks.watchText(`typed name ${from}`, from, { link: linkId, frames: ["sent email"], mail });
  }
  return { link, linkId, mark, secret, notice };
}

/** Asks for a code on the recipient page and returns it from the one code mail to `to`. */
async function requestCode(page: Page, to: string): Promise<string> {
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByText("Code sent. Check your email.")).toBeVisible();
  const codeMail = async () =>
    (await mailTo(to)).filter((mail) => mail.Subject === "Your Fidant code");
  await expect.poll(async () => (await codeMail()).length).toBe(1);
  const code = /Your code: (\d{6})/.exec((await codeMail())[0]?.Text ?? "")?.[1];
  if (!code) {
    throw new Error("no code in the code mail");
  }
  return code;
}

async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel("Code from the email").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
}

/** Watches the token the recipient page keeps for the link, which only its frames may carry. */
async function watchToken(leaks: Leaks, page: Page, emailed: Emailed, name: string) {
  const token = await page.evaluate((id) => sessionStorage.getItem(`token:${id}`), emailed.linkId);
  expect(token).toMatch(/^[\w-]{22}$/);
  leaks.watchKey(`token for ${name}`, token ?? "", "K", {
    link: emailed.linkId,
    frames: ["received token", "sent join"],
  });
  return token ?? "";
}

/** The server never logged these. The scan cannot look for a 6-digit code, so this does. */
async function expectNotLogged(values: string[]): Promise<void> {
  const logs = (await Promise.all([serverStdoutLog, serverStderrLog].map((p) => readFile(p)))).join(
    "\n",
  );
  for (const value of values) {
    // A code counts only as a whole number, not as part of a longer one.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(logs).not.toMatch(new RegExp(`(?<!\\d)${escaped}(?!\\d)`));
  }
}

/** Parsed `t` messages of type `type` that `actor` sent (or received) on /signal. */
async function messages(
  observed: (name: string) => Observed,
  actor: string,
  type: string,
  direction: "frame-sent" | "frame-received" = "frame-sent",
): Promise<Record<string, unknown>[]> {
  return (await observed(actor).records()).flatMap((record) => {
    if (record.type !== direction || record.base64) {
      return [];
    }
    const message = JSON.parse(record.payload) as Record<string, unknown>;
    return message.t === type ? [message] : [];
  });
}

/**
 * Hosts `link` as a plain link over a socket of the page's own, which stays open, then joins it
 * from another socket without a token. Returns the type of the server's answer to that join.
 */
function hostPlain(page: Page, link: string, attempt: string): Promise<string> {
  return page.evaluate(
    ([link, attempt]) =>
      new Promise<string>((resolve, reject) => {
        const url = `${location.origin.replace("https", "wss")}/signal`;
        const host = new WebSocket(url);
        (globalThis as { host?: WebSocket }).host = host;
        host.addEventListener("error", () => reject(new Error("host socket error")));
        host.addEventListener("open", () => {
          host.send(JSON.stringify({ t: "host", links: [link], turn: false }));
          const guest = new WebSocket(url);
          guest.addEventListener("error", () => reject(new Error("guest socket error")));
          guest.addEventListener("open", () =>
            guest.send(JSON.stringify({ t: "join", link, attempt })),
          );
          guest.addEventListener("message", (event) => {
            const { t } = JSON.parse(String(event.data)) as { t: string };
            if (t !== "hello") {
              resolve(t);
              guest.close();
            }
          });
        });
      }),
    [link, attempt] as const,
  );
}

test.describe("emailed links", () => {
  test.skip(!process.env.SIGILL_E2E_MAILPIT, "needs Mailpit");

  test("a recipient enters the emailed code and gets the file", async ({
    demo,
    observed,
    leaks,
    canary,
    baseURL,
  }) => {
    const file = makeFile(leaks, canary, 100_001);
    // Watched by addEmailed, with where the email may carry it.
    const from = `David-${base32Token(canary.fork("typed name"), 8)}`;
    const sender = await openSender(demo, file, from);
    const name = makeName(leaks, canary, "Anna");
    const to = addressFor(canary, "Anna");
    const masked = maskAddress(to);
    const emailed = await addEmailed(leaks, sender, name, to, from);
    expect(emailed.notice.HTML).toBe("");
    expect(emailed.notice.Text).toContain(
      `${from} (name typed by the sender, not verified) wants to send you a file or a secret.`,
    );

    const recipient = await demo.open("recipient");
    await recipient.goto(emailed.link);
    const codeStep = (page: Page) =>
      page.getByRole("heading", { name: "Confirm your email to open this link" });
    await expect(codeStep(recipient)).toBeVisible();
    await expect(recipient.getByText(`We'll email a code to ${masked}.`)).toBeVisible();
    await expect(recipient.getByText(from)).toHaveCount(0);
    const code = await requestCode(recipient, to);
    await expect(recipientRow(sender, name).getByText(`Code sent to ${masked}`)).toBeVisible();
    await enterCode(recipient, String((Number(code) + 1) % 1_000_000).padStart(6, "0"));
    await expect(recipient.getByText("That code is wrong. Try again.")).toBeVisible();
    await enterCode(recipient, code);
    await expect(
      recipient.getByRole("heading", { name: `${from} wants to send you a file` }),
    ).toBeVisible();
    const token = await watchToken(leaks, recipient, emailed, name);
    const verified = recipientRow(sender, name).getByText(
      `Verified with the code sent to ${masked}`,
    );
    await expect(verified).toBeVisible();

    // The token is this tab's: another tab gets the code step. The link without its marker
    // joins without a token, and the server refuses it.
    const tab = await recipient.context().newPage();
    await tab.goto(emailed.link);
    await expect(codeStep(tab)).toBeVisible();
    await tab.close();
    const stripped = await demo.open("stripped");
    await stripped.goto(`${baseURL}/r/${emailed.linkId}#${emailed.secret}`);
    await expect(stripped.getByText("This link no longer works")).toBeVisible();

    const bytes = await download(recipient, file);
    expect(sha256Hex(bytes)).toBe(sha256Hex(file.bytes));
    await expect(delivered(sender, name)).toBeAttached();
    await sender.getByText("Show details", { exact: true }).click();
    await expect(verified).toBeVisible();

    // A reload joins with the tab's token, without a new code, and the sender refuses a used link.
    await recipient.reload();
    await expect(recipient.getByText("This link has already been used")).toBeVisible();
    const joins = await messages(observed, "recipient", "join");
    expect(joins.map((join) => join.token)).toEqual([token, token]);
    expect((await mailTo(to)).filter((mail) => mail.Subject === "Your Fidant code")).toHaveLength(
      1,
    );
    await expectNotLogged([to, code, token, emailed.mark]);
  });

  test("an emailed link stops working with its sender, even if someone hosts its ID", async ({
    demo,
    observed,
    leaks,
    canary,
  }) => {
    const sender = await openSender(demo, makeFile(leaks, canary, 100_001));
    const name = makeName(leaks, canary, "Anna");
    const to = addressFor(canary, "Anna");
    const emailed = await addEmailed(leaks, sender, name, to);
    const recipient = await demo.open("recipient");
    await recipient.goto(emailed.link);
    await enterCode(recipient, await requestCode(recipient, to));
    await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible();
    await watchToken(leaks, recipient, emailed, name);
    await sender.close();
    await expect(recipient.getByText("The sender's page is closed")).toBeVisible();

    // The server forgot the link with the sender's socket, so a join without a token reaches
    // whoever hosts its ID now.
    const impostor = await demo.open("impostor");
    await impostor.goto("/");
    const attempt = canary.fork("attempt").bytes(16).toString("base64url");
    expect(await hostPlain(impostor, emailed.linkId, attempt)).toBe("joined");

    const joins = async (actor: string) => (await messages(observed, actor, "join")).length;
    const joined = await joins("recipient");
    await recipient.reload();
    await expect(recipient.getByText("This link no longer works")).toBeVisible();
    const fresh = await demo.open("fresh");
    await fresh.goto(emailed.link);
    await expect(fresh.getByText("This link no longer works")).toBeVisible();
    expect(await joins("recipient")).toBe(joined);
    expect(await joins("fresh")).toBe(0);
    const kept = await recipient.evaluate(
      (id) => sessionStorage.getItem(`token:${id}`),
      emailed.linkId,
    );
    expect(kept).toBeNull();
  });

  test("the code step survives a dropped connection and ends when the link stops working", async ({
    demo,
    observed,
    leaks,
    canary,
  }) => {
    const sender = await openSender(demo, makeFile(leaks, canary, 10));
    const name = makeName(leaks, canary, "Anna");
    const to = addressFor(canary, "Anna");
    const emailed = await addEmailed(leaks, sender, name, to);
    const recipient = await demo.open("recipient");
    await recipient.addInitScript(() => {
      const sockets: WebSocket[] = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...args: ConstructorParameters<typeof Native>) {
          super(...args);
          sockets.push(this);
        }
      };
      (window as unknown as { dropSockets: () => void }).dropSockets = () => {
        for (const socket of sockets) {
          socket.close();
        }
      };
    });
    await recipient.goto(emailed.link);
    const code = await requestCode(recipient, to);

    const gates = async () => (await messages(observed, "recipient", "gate")).length;
    const gatesBefore = await gates();
    await recipient.evaluate(() =>
      (window as unknown as { dropSockets: () => void }).dropSockets(),
    );
    await expect.poll(gates).toBeGreaterThan(gatesBefore);
    await expect(recipient.getByLabel("Code from the email")).toBeVisible();
    await enterCode(recipient, code);
    await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible();

    const late = await demo.open("late");
    await late.goto(emailed.link);
    await expect(late.getByRole("button", { name: "Send me a code" })).toBeVisible();
    await sender.close();
    await expect(recipient.getByText("The sender's page is closed")).toBeVisible();
    await late.getByRole("button", { name: "Send me a code" }).click();
    await expect(late.getByText("This link no longer works")).toBeVisible();
  });

  test("a reconnect stops an emailed link and hosts only the plain ones again", async ({
    demo,
    observed,
    leaks,
    canary,
  }) => {
    const sender = await openSender(demo, makeFile(leaks, canary, 10));
    const plainName = makeName(leaks, canary, "Erik");
    const plain = new URL(await addRecipient(leaks, sender, plainName)).pathname.slice(3);
    const name = makeName(leaks, canary, "Anna");
    const to = addressFor(canary, "Anna");
    const emailed = await addEmailed(leaks, sender, name, to);
    const hosted = async () => (await messages(observed, "sender", "host")).map((m) => m.links);
    const before = (await hosted()).length;

    await restartServer();
    await expect
      .poll(async () => (await hosted()).length, { timeout: 30_000 })
      .toBeGreaterThan(before);
    const links = (await hosted()).at(-1);
    expect(links).toContain(plain);
    expect(links).not.toContain(emailed.linkId);
    await expect(
      recipientRow(sender, name).getByText(
        `The link emailed to ${maskAddress(to)} stopped working`,
      ),
    ).toBeVisible();
    await expect(sender.getByRole("button", { name: `Copy link for ${name}` })).toHaveCount(0);
    await expect(sender.getByRole("button", { name: `Copy link for ${plainName}` })).toBeVisible();
  });

  test("a text from /secret can be emailed and shows after the code", async ({
    demo,
    leaks,
    canary,
  }) => {
    const text = `${base32Token(canary.fork("text"), 40)} åäö`;
    leaks.watchContent("text", text);
    const sender = await demo.open("sender");
    await sender.goto("/secret");
    await sender.getByLabel("Your secret").fill(text);
    const email = sender.getByLabel("Their email address");
    await expect(email).toHaveId("secret-recipient-email");
    const name = makeName(leaks, canary, "Anna");
    const to = addressFor(canary, "Anna");
    await email.fill(to);
    await expect(sender.locator("#secret-email-notice")).toContainText(
      "anyone who can read that mailbox could receive the secret.",
    );
    const emailed = await addEmailed(leaks, sender, name, to);

    const recipient = await demo.open("recipient");
    await recipient.goto(emailed.link);
    await enterCode(recipient, await requestCode(recipient, to));
    await expect(
      recipient.getByRole("heading", { name: "You've been sent a secret" }),
    ).toBeVisible();
    await recipient.getByRole("button", { name: "Show", exact: true }).click();
    await expect(
      recipient.getByRole("region", { name: "The secret", exact: true }),
    ).toHaveJSProperty("textContent", text);
    await expect(delivered(sender, name)).toBeAttached();
  });
});

// The default stack runs Mailpit, so the branch without mail runs only where Mailpit is missing.
harness(
  "the send page offers an email field exactly when the server can send mail",
  async ({ actor, observed }) => {
    const { page } = await actor("sender");
    await page.goto("/send");
    const hello = async () => await messages(observed, "sender", "hello", "frame-received");
    await expect.poll(async () => (await hello()).length).toBe(1);
    const mail = (await hello())[0]?.mail;
    expect(mail).toBe(Boolean(process.env.SIGILL_E2E_MAILPIT));
    await expect(page.getByLabel("Their email address")).toHaveCount(mail ? 1 : 0);
  },
);
