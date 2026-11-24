import type { Download, Page } from "@playwright/test";
import {
  type Actor,
  breakableSender,
  delivered,
  expect,
  type Leaks,
  makeName,
  recipientRow,
  test,
} from "../src/fixtures.ts";
import { base32Token, type SeededRandom } from "../src/leaks/canary.ts";

/** A watched text, unique to this run, long enough that any 16 bytes of it count. */
function makeText(leaks: Leaks, canary: SeededRandom): string {
  const random = canary.fork("text");
  const text = `${base32Token(random, 40)}\n${base32Token(random, 40)} åäö €`;
  leaks.watchContent("text", text);
  return text;
}

/** Fills the text and the sender's name on /secret, adds a recipient and returns their link, with its secret watched. */
async function share(leaks: Leaks, sender: Page, text: string, from: string, name: string) {
  await sender.getByLabel("Your text").fill(text);
  await expect(sender.getByLabel("Your text")).toHaveAttribute("writingsuggestions", "false");
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

test("a text goes from /secret to the recipient, who shows and copies it", async ({
  actor,
  leaks,
  canary,
}) => {
  const body = makeText(leaks, canary);
  // Starts with a byte order mark, which Blob.text() would drop on the recipient's side.
  const text = `\uFEFF${body}`;
  leaks.watchContent("text with its byte order mark", text);
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
  ] as const) {
    await expect(field).toHaveAttribute(attribute, value);
  }
  const link = await share(leaks, sender, text, from, name);
  await expect(field).toHaveJSProperty("value", text);

  const { page, downloads } = await openRecipient(actor, link);
  await expect(page.getByRole("heading", { name: `${from} sent you a text` })).toBeFocused();
  await expect(page.getByText("Name typed by the sender, not verified.")).toBeVisible();
  const show = page.getByRole("button", { name: "Show", exact: true });
  await expect(show).toBeVisible();
  await expect(page.getByRole("button", { name: "Download" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("secret.txt");
  await show.click();

  const shown = page.getByRole("region", { name: "The text", exact: true });
  await expect(shown).toHaveJSProperty("textContent", text);
  await expect(shown).toHaveJSProperty("translate", false);
  await expect(shown).toHaveAttribute("tabindex", "0");
  // Browsers save form controls' values with the session, so none may hold the text.
  const [firstLine = body] = body.split("\n");
  const values = await page
    .locator("input, textarea, select")
    .evaluateAll((controls) => controls.map((control) => (control as HTMLInputElement).value));
  expect(values.filter((value) => value.includes(firstLine))).toEqual([]);
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

test("a pasted text over 10,000 characters stays whole and can't be shared until shortened", async ({
  actor,
  leaks,
  canary,
}) => {
  const long = base32Token(canary.fork("long text"), 12_000);
  leaks.watchContent("long text", long);
  const { page: sender } = await actor("sender");
  await sender.goto("/secret");
  const field = sender.getByLabel("Your text");
  const error = sender.locator("#secret-text-error");
  const live = error.locator("[role=status]");
  const add = sender.getByRole("button", { name: "Add", exact: true });
  await expect(live).toBeAttached();
  await expect(live).toBeEmpty();

  await field.focus();
  // The editing path a paste takes; maxlength used to cut it here without a word.
  await sender.keyboard.insertText(long);
  await expect(field).toHaveValue(long);
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(error).toHaveText("12,000 of 10,000 characters. Shorten the text to share it.");
  await expect(live).toHaveText("Shorten the text to share it.");
  await expect(field).toHaveAccessibleDescription(
    "12,000 of 10,000 characters. Shorten the text to share it. Up to 10,000 characters.",
  );
  await expect(add).toBeDisabled();
  await expect(sender.locator("#secret-recipient-name")).toBeDisabled();
  await expect(sender.locator("#secret-recipient-hint")).toHaveText(
    "Shorten the text to share it.",
  );
  await expect(sender.getByText("Write or paste the text first.")).toHaveCount(0);

  await field.fill(long.slice(0, 10_000));
  await expect(field).toHaveAttribute("aria-invalid", "false");
  await expect(error).toBeEmpty();
  await expect(field).toHaveAccessibleDescription("Up to 10,000 characters.");
  await expect(add).toBeEnabled();
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
  await expect(page.getByRole("region", { name: "The text", exact: true })).toHaveJSProperty(
    "textContent",
    text,
  );
  await expect(delivered(sender, name)).toBeVisible();
});

test("a recipient sees the text wording when the sender closes the page during the offer", async ({
  actor,
  leaks,
  canary,
}) => {
  const text = makeText(leaks, canary);
  const name = makeName(leaks, canary, "Greta");
  const { page: sender } = await actor("sender");
  await sender.goto("/secret");
  const link = await share(leaks, sender, text, "", name);

  const { page } = await openRecipient(actor, link);
  await expect(page.getByRole("button", { name: "Show", exact: true })).toBeVisible();
  await sender.close();
  await expect(page.getByText("The sender's page is closed")).toBeVisible();
  await expect(page.getByText("The text comes straight from their browser")).toBeVisible();
  await expect(page.getByText("The file comes straight from their browser")).toHaveCount(0);
});

test("a recipient sees the text wording when the connection to the sender drops during the offer", async ({
  actor,
  leaks,
  canary,
}) => {
  const text = makeText(leaks, canary);
  const name = makeName(leaks, canary, "Ida");
  const { page: sender } = await actor("sender");
  await sender.addInitScript(breakableSender);
  await sender.goto("/secret");
  const link = await share(leaks, sender, text, "", name);

  const { page } = await openRecipient(actor, link);
  await expect(page.getByRole("button", { name: "Show", exact: true })).toBeVisible();
  await sender.evaluate(() => (globalThis as { cut?: () => void }).cut?.());
  await expect(page.getByText("The connection to the sender was lost")).toBeVisible();
  await expect(page.getByText("The text wasn't shown.", { exact: true })).toBeVisible();
  await expect(page.getByText("Nothing was saved.")).toHaveCount(0);
});

test("a connection too small to carry a text in one chunk fails the card and sends nothing", async ({
  actor,
  leaks,
  canary,
}) => {
  const text = makeText(leaks, canary);
  const name = makeName(leaks, canary, "Hugo");
  const { page: sender } = await actor("sender");
  await sender.addInitScript(() => {
    const g = globalThis as { sent?: number };
    g.sent = 0;
    Object.defineProperty(RTCSctpTransport.prototype, "maxMessageSize", { get: () => 32_831 });
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (this: RTCDataChannel, ...args: unknown[]) {
      g.sent = (g.sent ?? 0) + 1;
      Reflect.apply(send, this, args);
    } as RTCDataChannel["send"];
  });
  await sender.goto("/secret");
  const link = await share(leaks, sender, text, "", name);

  const { page } = await openRecipient(actor, link);
  await expect(
    recipientRow(sender, name).getByText(
      `The text wasn't sent through ${name}'s link, because its length would have shown on this connection. The link still works.`,
    ),
  ).toBeVisible();
  expect(await sender.evaluate(() => (globalThis as { sent?: number }).sent)).toBe(0);
  await expect(page.getByRole("button", { name: "Show", exact: true })).toHaveCount(0);
});

test("a sender who loses the server sees the text wording", async ({ actor }) => {
  const { page: sender } = await actor("sender");
  await sender.addInitScript(() => {
    const g = globalThis as {
      serverOpen?: boolean;
      opensAfterDrop?: number;
      dropServer?: () => void;
    };
    const sockets: WebSocket[] = [];
    let dropped = false;
    g.opensAfterDrop = 0;
    globalThis.WebSocket = class extends globalThis.WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
        // Closed here, not on open: an open would let the page clear its lost-server timer.
        if (dropped) {
          this.close();
        }
        this.addEventListener("open", () => {
          if (dropped) {
            g.opensAfterDrop = (g.opensAfterDrop ?? 0) + 1;
          } else {
            g.serverOpen = true;
          }
        });
      }
    };
    g.dropServer = () => {
      dropped = true;
      for (const socket of sockets) {
        socket.close();
      }
    };
  });
  await sender.goto("/secret");
  await sender.waitForFunction(() => (globalThis as { serverOpen?: boolean }).serverOpen === true);
  await sender.evaluate(() => (globalThis as { dropServer?: () => void }).dropServer?.());
  // The page waits LOST_AFTER_MS (10 s) before it says so.
  await expect(sender.getByRole("alert")).toHaveText(
    "Lost the connection to the server. Trying to reconnect… Texts already on their way can finish. Nobody new can connect until it's back, so keep this page open.",
    { timeout: 20_000 },
  );
  await expect(sender.getByText("Files already on their way")).toHaveCount(0);
  expect(
    await sender.evaluate(() => (globalThis as { opensAfterDrop?: number }).opensAfterDrop),
  ).toBe(0);
});

test("a recipient whose browser can't read the received text is told so, with nothing to copy", async ({
  actor,
  leaks,
  canary,
}) => {
  const text = makeText(leaks, canary);
  const name = makeName(leaks, canary, "Jon");
  const { page: sender } = await actor("sender");
  await sender.goto("/secret");
  const link = await share(leaks, sender, text, "", name);

  const { page } = await openRecipient(actor, link);
  const show = page.getByRole("button", { name: "Show", exact: true });
  await expect(show).toBeVisible();
  // decodeText is the only Blob.arrayBuffer() caller on the recipient's side.
  await page.evaluate(() => {
    Blob.prototype.arrayBuffer = () => Promise.reject(new Error("unreadable"));
  });
  await show.click();
  await expect(page.getByRole("heading", { name: "The text couldn't be shown" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Copy text" })).toHaveCount(0);
  await expect(delivered(sender, name)).toBeVisible();
});
