import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { canaryFile, canaryKey, expect, test as harness, type Leaks } from "../src/fixtures.ts";
import { base32Token, type CanaryFile, type SeededRandom } from "../src/leaks/canary.ts";

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

/** A watched person's name, unique to this run. */
function makeName(leaks: Leaks, canary: SeededRandom, first: string): string {
  const name = `${first}-${base32Token(canary.fork(`name ${first}`), 8)}`;
  leaks.watchText(`name ${first}`, name);
  return name;
}

/** Opens the sender page, runs `init` in it before any page script, types the sender's name if given, and chooses the file. */
async function openSender(
  demo: Demo,
  file: CanaryFile,
  from = "",
  init?: () => void,
): Promise<Page> {
  const page = await demo.open("sender");
  if (init) {
    await page.addInitScript(init);
  }
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
  await sender.getByRole("button", { name: "Add", exact: true }).click();
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  const secret = new URL(link).hash.slice(1);
  expect(secret, `link secret for ${name}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
  leaks.watchKey(`link secret for ${name}`, secret);
  return link;
}

const recipientRow = (sender: Page, name: string) =>
  sender.getByRole("list", { name: "Recipients" }).getByRole("listitem").filter({ hasText: name });

const delivered = (sender: Page, name: string) =>
  recipientRow(sender, name).getByText(`Delivered through ${name}'s link`);

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
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download" }).click();
  await expect(page.getByText("this is exactly the file that was sent")).toBeVisible({
    timeout: 60_000,
  });
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(file.name);
  await expect(page.getByRole("heading", { name: "Download complete" })).toBeFocused();
  // The typed name is unverified, so it stays on the offer screen only.
  if (from) {
    await expect(page.getByText(from)).toHaveCount(0);
  }
  const again = page.waitForEvent("download");
  await page.getByRole("link", { name: "Save file" }).click();
  expect((await again).suggestedFilename()).toBe(file.name);
  return { page, bytes: await readFile(await download.path()) };
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
    await expect(delivered(sender, name)).toBeVisible();
  }
  const cards = names.map((name) => recipientRow(sender, name));
  for (const scope of [...cards, ...received.map(({ page }) => page)]) {
    await expect(scope.getByText("Direct connection", { exact: true })).toBeVisible();
    await scope.getByText("Why?", { exact: true }).click();
    await expect(scope.getByText("The file goes straight between the two devices.")).toBeVisible();
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
  await expect(delivered(sender, name)).toBeVisible();
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
      `${name}'s link was opened and the file declined. The link still works.`,
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

  await sender.keyboard.press("Enter");
  await expect(recipientRow(sender, erik)).toHaveCount(0);
  await expect(sender.getByLabel("Who is it for?")).toBeFocused();
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
  await page.getByRole("button", { name: "Add", exact: true }).click();
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

/** Lets a test cut the sender's peer connections (`cut()`) and stop its data channels sending (`stalled`). */
function breakableSender() {
  const g = globalThis as { cut?: () => void; stalled?: boolean };
  const peers: RTCPeerConnection[] = [];
  const Native = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      peers.push(this);
    }
  };
  g.cut = () => {
    for (const peer of peers) {
      peer.close();
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (this: RTCDataChannel, ...args: unknown[]) {
    if (!g.stalled) {
      Reflect.apply(send, this, args);
    }
  } as RTCDataChannel["send"];
}

test("a lost sender says whether the file may have been saved", async ({ demo, leaks, canary }) => {
  const file = makeFile(leaks, canary, 100_001);
  const sender = await openSender(demo, file, "", breakableSender);
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

  // Mid-download, the sender's page closes. The server says so at once, but the page waits for
  // the peer connection to drop, which Chromium notices only when ICE consent expires (about 15 s).
  const bo = await join("Bo", true);
  await sender.close();
  await expect(bo.getByText("The sender's page is closed")).toBeVisible({ timeout: 30_000 });
  await expect(bo.getByText("The file may not have been saved.")).toBeVisible();
});
