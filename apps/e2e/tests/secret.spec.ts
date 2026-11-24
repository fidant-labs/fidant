import type { Download, Page } from "@playwright/test";
import { type Actor, expect, type Leaks, test } from "../src/fixtures.ts";
import { base32Token, type SeededRandom } from "../src/leaks/canary.ts";

/** A watched text, unique to this run, long enough that any 16 bytes of it count. */
function makeText(leaks: Leaks, canary: SeededRandom): string {
  const random = canary.fork("text");
  const text = `${base32Token(random, 40)}\n${base32Token(random, 40)} åäö €`;
  leaks.watchContent("text", text);
  return text;
}

/** A watched person's name, unique to this run. */
function makeName(leaks: Leaks, canary: SeededRandom, first: string): string {
  const name = `${first}-${base32Token(canary.fork(`name ${first}`), 8)}`;
  leaks.watchText(`name ${first}`, name);
  return name;
}

/** Fills the text and the sender's name on /secret, adds a recipient and returns their link, with its secret watched. */
async function share(leaks: Leaks, sender: Page, text: string, from: string, name: string) {
  await sender.getByLabel("Your text").fill(text);
  if (from) {
    await sender.locator("#secret-from").fill(from);
  }
  await sender.locator("#secret-recipient-name").fill(name);
  await sender.getByRole("button", { name: "Add", exact: true }).click();
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  const secret = new URL(link).hash.slice(1);
  expect(secret, `link secret for ${name}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
  leaks.watchKey(`link secret for ${name}`, secret);
  return link;
}

/** Opens `link` as the recipient, with the clipboard allowed and save pickers and downloads counted. */
async function openRecipient(actor: (name: string) => Promise<Actor>, link: string) {
  const { context, page } = await actor("recipient");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(link).origin,
  });
  await context.addInitScript(() => {
    const g = globalThis as {
      showSaveFilePicker?: (...args: unknown[]) => unknown;
      pickerCalls?: number;
    };
    const picker = g.showSaveFilePicker;
    g.pickerCalls = 0;
    if (picker) {
      g.showSaveFilePicker = (...args) => {
        g.pickerCalls = (g.pickerCalls ?? 0) + 1;
        return Reflect.apply(picker, globalThis, args);
      };
    }
  });
  const downloads: Download[] = [];
  page.on("download", (download) => downloads.push(download));
  await page.goto(link);
  return { page, downloads };
}

const recipientRow = (sender: Page, name: string) =>
  sender.getByRole("list", { name: "Recipients" }).getByRole("listitem").filter({ hasText: name });

const delivered = (sender: Page, name: string) =>
  recipientRow(sender, name).getByText(`Delivered through ${name}'s link`);

test("a text goes from /secret to the recipient, who shows and copies it", async ({
  actor,
  leaks,
  canary,
}) => {
  const text = makeText(leaks, canary);
  const from = makeName(leaks, canary, "David");
  const name = makeName(leaks, canary, "Anna");

  const { page: sender } = await actor("sender");
  await sender.goto("/send");
  const entry = sender.locator("header nav").getByRole("link", { name: "Share a secret" });
  await entry.click();
  await expect(sender).toHaveURL(/\/secret$/);
  await expect(sender).toHaveTitle("Share a secret – Fidant");
  await expect(entry).toHaveAttribute("aria-current", "page");
  const field = sender.getByLabel("Your text");
  await expect(field).toHaveId("secret-text");
  await expect(field).toHaveJSProperty("spellcheck", false);
  await expect(field).toHaveJSProperty("translate", false);
  for (const [attribute, value] of [
    ["autocomplete", "off"],
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
    ["maxlength", "10000"],
  ] as const) {
    await expect(field).toHaveAttribute(attribute, value);
  }
  const link = await share(leaks, sender, text, from, name);

  const { page, downloads } = await openRecipient(actor, link);
  await expect(page.getByRole("heading", { name: `${from} sent you a text` })).toBeFocused();
  await expect(page.getByText("Name typed by the sender, not verified.")).toBeVisible();
  const show = page.getByRole("button", { name: "Show", exact: true });
  await expect(show).toBeVisible();
  await expect(page.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("secret.txt");
  await show.click();

  const shown = page.getByRole("textbox", { name: "The text" });
  await expect(shown).toHaveValue(text);
  await expect(shown).toHaveJSProperty("spellcheck", false);
  await expect(shown).toHaveJSProperty("translate", false);
  await expect(shown).toHaveJSProperty("readOnly", true);
  await expect(page.locator("body")).not.toContainText("secret.txt");

  // The canary repeats under --repeat-each, so a clipboard left by an earlier run would pass.
  await page.evaluate(() => navigator.clipboard.writeText("not the text"));
  await page.getByRole("button", { name: "Copy text" }).click();
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);

  const details = page.locator("details").filter({ hasText: "Technical details" });
  await details.getByText("Technical details").click();
  await expect(details.getByText("Encryption", { exact: true })).toBeVisible();
  await expect(details).not.toContainText("SHA-256");
  await expect(details).not.toContainText("Size");
  await expect(details).not.toContainText("bytes");

  await expect(delivered(sender, name)).toBeVisible();
  expect(await page.evaluate(() => (globalThis as { pickerCalls?: number }).pickerCalls)).toBe(0);
  expect(downloads).toEqual([]);
});

test("declining a text keeps the link working", async ({ actor, leaks, canary }) => {
  const text = makeText(leaks, canary);
  const name = makeName(leaks, canary, "Erik");
  const { page: sender } = await actor("sender");
  await sender.goto("/secret");
  const link = await share(leaks, sender, text, "", name);

  const { page } = await openRecipient(actor, link);
  const offer = page.getByRole("heading", { name: "You've been sent a text" });
  await expect(offer).toBeFocused();
  await expect(page.getByText("Name typed by the sender, not verified.")).toHaveCount(0);
  await page.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByRole("heading", { name: "You declined the text" })).toBeFocused();
  await expect(
    recipientRow(sender, name).getByText(
      `${name}'s link was opened and the text was declined. The link still works.`,
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "Show the text again" }).click();
  await expect(offer).toBeVisible();
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "The text" })).toHaveValue(text);
  await expect(delivered(sender, name)).toBeVisible();
});
