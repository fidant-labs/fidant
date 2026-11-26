import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { maskAddress } from "@sigill/protocol";
import {
  canaryFile,
  chooseFile,
  delivered,
  expect,
  type Leaks,
  makeName,
  recipientRow,
  test,
} from "../src/fixtures.ts";
import { type Signal, signalsOf, tamperSignal } from "../src/interpose.ts";
import { base32Token } from "../src/leaks/canary.ts";
import { mailTo } from "../src/mail.ts";

// Firefox connects to the certificate a variant spelling names, which Chromium and WebKit refuse.

test.skip(!process.env.SIGILL_E2E_MAILPIT, "needs Mailpit");

/** Adds `name` with the address `to` and a safety number, waits for the notice and returns the emailed link, with its secrets watched where decision 0012 lets them appear. */
async function addEmailed(leaks: Leaks, sender: Page, name: string, to: string): Promise<string> {
  await sender.getByLabel("Who is it for?").fill(name);
  await sender.getByLabel("Email the link for me (less private)").check();
  const address = sender.getByLabel("Their email address");
  await address.fill(to);
  await address.press("Enter");
  await expect(
    recipientRow(sender, name).getByText(`Email sent to ${maskAddress(to)}`),
  ).toBeVisible();
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  const url = new URL(link);
  const [, mark = "", secret = ""] = /^#e\.([\w-]{22})\.([\w-]{43})$/.exec(url.hash) ?? [];
  await expect.poll(async () => (await mailTo(to)).length).toBe(1);
  const [notice] = await mailTo(to);
  const linkId = url.pathname.slice("/r/".length);
  const mail = { to, notice: notice?.ID ?? "" };
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
  return link;
}

/** Asks for the code on the recipient page and enters it from the one code mail to `to`. */
async function confirmEmail(page: Page, to: string): Promise<void> {
  await page.getByRole("button", { name: "Send me a code" }).click();
  const codeMail = async () =>
    (await mailTo(to)).filter((mail) => mail.Subject === "Your Fidant code");
  await expect.poll(async () => (await codeMail()).length).toBe(1);
  const code = /Your code: (\d{6})/.exec((await codeMail())[0]?.Text ?? "")?.[1] ?? "";
  await page.getByLabel("Code from the email").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
}

for (const variant of ["a=Fingerprint:sha-256", "a=fingerprint sha-256"]) {
  test(`a sender refuses an answer with a second fingerprint line "${variant}"`, async ({
    actor,
    observed,
    leaks,
    canary,
  }) => {
    const other = randomBytes(32)
      .toString("hex")
      .toUpperCase()
      .replace(/..(?!$)/g, "$&:");
    let signals: ReturnType<typeof signalsOf> | undefined;
    let attempt = "";
    let added = false;
    let order = Promise.resolve();
    const { page: sender } = await actor("sender");
    await tamperSignal(sender, (message, sent, toPage) => {
      attempt = message.attempt ?? attempt;
      if (sent) {
        return message;
      }
      order = order.then(async () => {
        let out: Signal = message;
        const payload =
          message.t === "relay"
            ? await signals?.open(attempt, "r", message.data).catch(() => undefined)
            : undefined;
        if (signals && payload?.kind === "answer") {
          const sdp = String(payload.sdp);
          const edited = sdp.replace(
            /^a=fingerprint:sha-256 \S+\r\n/m,
            `$&${variant} ${other}\r\n`,
          );
          added = edited !== sdp;
          out = { ...message, data: await signals.seal(attempt, "r", { ...payload, sdp: edited }) };
        }
        toPage(out);
      });
      return undefined;
    });
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 10 }));
    await sender.goto("/send");
    await chooseFile(sender, { name: file.name, mimeType: file.mime, buffer: file.bytes });
    const name = makeName(leaks, canary, "Anna");
    const to = `anna-${base32Token(canary.fork("address"), 8).toLowerCase()}@example.com`;
    const link = await addEmailed(leaks, sender, name, to);
    signals = signalsOf(link);

    const { page: recipient } = await actor("recipient");
    let downloads = 0;
    recipient.on("download", () => downloads++);
    await recipient.goto(link);
    await confirmEmail(recipient, to);
    const warnings = async () =>
      (await observed("sender").records()).flatMap((r) => (r.type === "console" ? [r.text] : []));
    await expect
      .poll(warnings, { timeout: 10_000 })
      .toContain("sigill: sender dropped a connection: bad-signal");
    await expect(recipient.getByText("Couldn't connect to the sender's computer")).toBeVisible({
      timeout: 10_000,
    });
    await expect(recipient.getByRole("button", { name: "Download" })).toHaveCount(0);
    expect(downloads, "downloads").toBe(0);
    await expect(delivered(sender, name)).toHaveCount(0);
    expect(added, "added the line to the recipient's answer").toBe(true);
  });
}
