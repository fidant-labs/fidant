// The first demo end to end: a sender page sends one file to named recipients,
// each recipient on their own link and in their own browser context. Leak
// checks run after every test in the `sigill` fixture (fixtures.ts).

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, type Sigill, test } from "./fixtures.ts";

const MiB = 1024 * 1024;

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const randomTag = () => randomBytes(4).toString("hex");

type TestFile = { name: string; buffer: Buffer; sha256: string };

/** A random file, with its name, checksum and byte samples marked secret. */
function makeFile(sigill: Sigill, size: number): TestFile {
  const file = { name: `report-${randomTag()}.bin`, buffer: randomBytes(size), sha256: "" };
  file.sha256 = sha256Hex(file.buffer);
  sigill.forbid("file name", file.name);
  sigill.forbid("file SHA-256", file.sha256);
  const sample = file.buffer.subarray(Math.floor(size / 2), Math.floor(size / 2) + 30);
  // Inside a longer base64 stream the sample can start at any of three byte
  // offsets from a 3-byte group boundary, and only whole groups encode the
  // same way everywhere. So forbid, for each offset, the sample from there on,
  // cut to whole groups: one of the three always appears verbatim.
  for (const offset of [0, 1, 2]) {
    const groups = Math.floor((sample.length - offset) / 3);
    const aligned = sample.subarray(offset, offset + groups * 3);
    sigill.forbid(`file bytes (base64, offset ${offset})`, aligned.toString("base64"));
    sigill.forbid(`file bytes (base64url, offset ${offset})`, aligned.toString("base64url"));
  }
  return file;
}

/** Opens the sender page, types the sender's name if given, and chooses the file. */
async function openSender(sigill: Sigill, file: TestFile, from = ""): Promise<Page> {
  const page = await sigill.openPage();
  await page.goto(sigill.baseURL);
  if (from) {
    sigill.forbid("sender name", from);
    await page.getByLabel("Your name").fill(from);
  }
  await page.getByLabel("Choose a file").setInputFiles({
    name: file.name,
    mimeType: "application/octet-stream",
    buffer: file.buffer,
  });
  await page.getByText("Technical details").click();
  await expect(page.getByText(file.sha256)).toBeVisible();
  return page;
}

/** Adds a recipient on the sender page and returns their link. */
async function addRecipient(sigill: Sigill, sender: Page, name: string): Promise<string> {
  sigill.forbid(`recipient name ${name}`, name);
  await sender.getByLabel("Who is it for?").fill(name);
  await sender.getByRole("button", { name: "Add", exact: true }).click();
  const link = (await sender.getByLabel(`Link for ${name}`).textContent()) ?? "";
  const secret = new URL(link).hash.slice(1);
  expect(secret, `link secret for ${name}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
  sigill.forbid(`link secret for ${name}`, secret);
  return link;
}

const recipientRow = (sender: Page, name: string) =>
  sender.getByRole("list", { name: "Recipients" }).getByRole("listitem").filter({ hasText: name });

/** Opens a link, checks the offer, downloads and returns the bytes the download started by itself. */
async function receive(sigill: Sigill, link: string, file: TestFile, sizeText: string, from = "") {
  const page = await sigill.openPage();
  await page.goto(link);
  const heading = from ? `${from} wants to send you a file` : "You've been sent a file";
  await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  await expect(page.getByText("Name typed by the sender, not verified.")).toHaveCount(from ? 1 : 0);
  await expect(page.getByText(file.name)).toBeVisible();
  await expect(page.getByText(sizeText, { exact: true })).toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.getByText(`${file.buffer.length.toLocaleString("en-US")} bytes`)).toBeVisible();
  const downloading = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Download" }).click();
  await expect(page.getByText("this is exactly the file that was sent")).toBeVisible({
    timeout: 60_000,
  });
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(file.name);
  return { page, bytes: await readFile(await download.path()) };
}

test("delivers a file to two recipients with a verified checksum", async ({ sigill }) => {
  // Odd size so the last chunk is partial and padding is exercised.
  const file = makeFile(sigill, 8 * MiB + 321);
  const from = `David-${randomTag()}`;
  const sender = await openSender(sigill, file, from);
  const names = [`Anna-${randomTag()}`, `Erik-${randomTag()}`];
  const links: string[] = [];
  for (const name of names) links.push(await addRecipient(sigill, sender, name));

  const received = await Promise.all(
    links.map((link) => receive(sigill, link, file, "8.4 MB", from)),
  );
  for (const { bytes } of received) expect(sha256Hex(bytes)).toBe(file.sha256);

  for (const name of names) {
    await expect(recipientRow(sender, name).getByText(`${name} has the file`)).toBeVisible();
  }
});

test("refuses used, unknown and malformed links", async ({ sigill }) => {
  const file = makeFile(sigill, 100_000);
  const sender = await openSender(sigill, file);
  const name = `Anna-${randomTag()}`;
  const link = await addRecipient(sigill, sender, name);

  const first = await receive(sigill, link, file, "100 KB");
  expect(sha256Hex(first.bytes)).toBe(file.sha256);
  await expect(recipientRow(sender, name).getByText(`${name} has the file`)).toBeVisible();
  await first.page.context().close();

  const reopened = await sigill.openPage();
  await reopened.goto(link);
  await expect(reopened.getByText("This link has already been used")).toBeVisible();

  // Well formed, but no sender hosts it: the server refuses.
  const unlistedSecret = randomBytes(32).toString("base64url");
  sigill.forbid("unlisted link secret", unlistedSecret);
  const unlisted = await sigill.openPage();
  await unlisted.goto(
    `${sigill.baseURL}/r/${randomBytes(16).toString("base64url")}#${unlistedSecret}`,
  );
  await expect(unlisted.getByText("This link isn't active")).toBeVisible();

  const malformed = await sigill.openPage();
  await malformed.goto(`${sigill.baseURL}/r/not-a-link#nope`);
  await expect(malformed.getByText("This link doesn't work")).toBeVisible();
});

test("a declined offer puts the recipient back to waiting", async ({ sigill }) => {
  const file = makeFile(sigill, 100_000);
  const sender = await openSender(sigill, file);
  const name = `Erik-${randomTag()}`;
  const link = await addRecipient(sigill, sender, name);

  const recipient = await sigill.openPage();
  await recipient.goto(link);
  await expect(recipientRow(sender, name).getByText(`${name} has opened the link`)).toBeVisible();
  await recipient.getByRole("button", { name: "Decline" }).click();
  await expect(recipient.getByText("You declined the file")).toBeVisible();
  await expect(
    recipientRow(sender, name).getByText(`Waiting for ${name} to open the link`),
  ).toBeVisible();
});

test("a waiting recipient sees when the sender goes offline", async ({ sigill }) => {
  const file = makeFile(sigill, 100_000);
  const sender = await openSender(sigill, file);
  const link = await addRecipient(sigill, sender, `Anna-${randomTag()}`);

  const recipient = await sigill.openPage();
  await recipient.goto(link);
  await expect(recipient.getByRole("button", { name: "Download" })).toBeVisible();
  await sender.close();
  await expect(recipient.getByText("The sender's page is closed")).toBeVisible();
});
