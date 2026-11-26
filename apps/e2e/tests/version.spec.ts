import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import {
  type Actor,
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
import type { CanaryFile } from "../src/leaks/canary.ts";

// Each page gets the other's version marker (apps/web/src/lib/peer.ts) resealed one version off, as a page of another release would send it.

type Keys = ReturnType<typeof signalsOf>;
type Payload = Awaited<ReturnType<Keys["open"]>>;
type Side = "s" | "r";

const MARKER = /^fidant-v(\d+)$/;

/** The version a relayed signal names if it is a version marker. */
function markerVersion(payload: Payload): number | undefined {
  const candidate = payload.kind === "ice" ? (payload.candidate as Record<string, unknown>) : null;
  const fragment = candidate?.candidate === "" ? String(candidate.usernameFragment) : "";
  const digits = MARKER.exec(fragment)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

const marker = (version: number): Payload => ({
  kind: "ice",
  candidate: {
    candidate: "",
    sdpMid: null,
    sdpMLineIndex: null,
    usernameFragment: `fidant-v${version}`,
  },
});

/** Passes what the server sends `page` through one chain, in order, resealing the other side's marker `shift` versions on. */
async function shiftMarkers(page: Page, side: Side, shift: number) {
  const other: Side = side === "s" ? "r" : "s";
  let keys: Keys | undefined;
  let attempt = "";
  let chain = Promise.resolve();
  const seen: number[] = [];
  const sent: string[] = [];
  const failures: string[] = [];
  const edit = async (message: Signal, at: string): Promise<Signal> => {
    if (message.t !== "relay" || !keys) {
      return message;
    }
    const version = markerVersion(await keys.open(at, other, message.data));
    if (version === undefined) {
      return message;
    }
    seen.push(version);
    return { ...message, data: await keys.seal(at, other, marker(version + shift)) };
  };
  await tamperSignal(page, (message, toServer, toPage) => {
    attempt = message.attempt ?? attempt;
    const at = attempt;
    if (toServer) {
      if (message.t === "relay" && keys) {
        void keys.open(at, side, message.data).then(({ kind }) => sent.push(kind));
      }
      return message;
    }
    chain = chain
      .then(() => edit(message, at))
      .then(toPage, (error: unknown) => {
        failures.push(String(error));
      });
    return undefined;
  });
  return {
    start(link: string) {
      keys = signalsOf(link);
    },
    /** The versions the other side's markers named, as the page would have read them. */
    seen,
    /** The kinds of the relayed signals the page sent. */
    sent,
    failures,
  };
}

/** Init script: every decrypt takes 300 ms longer, as on a slow device, so `left` comes while a relayed signal is still being opened. */
function slowDecrypt() {
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  Object.assign(crypto.subtle, {
    async decrypt(...args: Parameters<SubtleCrypto["decrypt"]>) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return decrypt(...args);
    },
  });
}

/** Drops the first relayed signal `page` sends and keeps it, opened, as `first`. */
async function dropFirst(page: Page, side: Side) {
  let keys: Keys | undefined;
  let attempt = "";
  let first: Promise<Payload> | undefined;
  await tamperSignal(page, (message, toServer) => {
    attempt = message.attempt ?? attempt;
    if (!toServer || message.t !== "relay" || first || !keys) {
      return message;
    }
    first = keys.open(attempt, side, message.data);
    return undefined;
  });
  return {
    start(link: string) {
      keys = signalsOf(link);
    },
    first: () => first,
  };
}

/** An actor whose downloads arrive as Blob downloads, as on a browser without a save dialog. */
async function blobActor(actor: (name: string) => Promise<Actor>, name: string): Promise<Page> {
  const { context, page } = await actor(name);
  await context.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  return page;
}

/** Opens a bare signaling socket in `page` that joins `link` as `attempt`, resolving once the server paired it. */
async function joinBare(page: Page, name: string, linkId: string, attempt: string): Promise<void> {
  await page.evaluate(
    ({ name, linkId, attempt }) =>
      new Promise<void>((resolve) => {
        const url = new URL("/signal", location.href);
        url.protocol = "wss:";
        const ws = new WebSocket(url);
        const seen: string[] = [];
        Object.assign(globalThis, { [name]: { ws, seen } });
        ws.onopen = () => ws.send(JSON.stringify({ t: "join", link: linkId, attempt }));
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data) as { t: string; reason?: string };
          seen.push(message.reason ? `${message.t}:${message.reason}` : message.t);
          if (message.t === "joined") {
            resolve();
          }
        };
      }),
    { name, linkId, attempt },
  );
}

const sendBare = (page: Page, name: string, linkId: string, data: string) =>
  page.evaluate(
    ({ name, linkId, data }) => {
      const { ws } = (globalThis as never)[name] as { ws: WebSocket };
      ws.send(JSON.stringify({ t: "relay", link: linkId, data }));
    },
    { name, linkId, data },
  );

const seenBare = (page: Page, name: string) =>
  page.evaluate((name) => ((globalThis as never)[name] as { seen: string[] }).seen, name);

const bareAttempt = () => randomBytes(16).toString("base64url");

/** Loads the send page with `file` chosen. */
async function openSend(page: Page, file: CanaryFile): Promise<void> {
  await page.goto("/send");
  await chooseFile(page, { name: file.name, mimeType: file.mime, buffer: file.bytes });
}

/** Adds a recipient with a plain link and returns the link, with its secret watched. */
async function addRecipient(leaks: Leaks, sender: Page, name: string): Promise<string> {
  const who = sender.getByLabel("Who is it for?");
  await who.fill(name);
  await who.press("Enter");
  const link = (await sender.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
  leaks.watchKey(`link secret for ${name}`, new URL(link).hash.slice(1));
  return link;
}

test.describe("pages of different versions", () => {
  test("an older sender's page: both pages say the sender's must reload", async ({
    actor,
    leaks,
    canary,
  }) => {
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 1000 }));
    const sender = await blobActor(actor, "sender");
    await sender.addInitScript(slowDecrypt);
    const senderSide = await shiftMarkers(sender, "s", 1);
    await openSend(sender, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    senderSide.start(link);
    const recipient = await blobActor(actor, "recipient");
    const recipientSide = await shiftMarkers(recipient, "r", -1);
    recipientSide.start(link);
    await recipient.goto(link);

    await expect(
      recipient.getByRole("heading", { name: "The sender's page is out of date" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      recipient.getByText(
        "Nothing is wrong with the file. Ask the sender to reload their page and send you a new link.",
      ),
    ).toBeVisible();
    await expect(
      recipientRow(sender, name).getByText(
        `${name}'s link was opened on a newer version of Fidant. To send through a new link, reload this page and add ${name} again. Reloading clears every link on this page.`,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(recipient.getByText(/couldn't read/)).toHaveCount(0);
    await expect(recipient.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(recipient.getByRole("button", { name: "Download" })).toHaveCount(0);

    expect(senderSide.seen, "the recipient's marker").toHaveLength(1);
    expect(recipientSide.seen, "the sender's marker").toEqual(senderSide.seen);
    expect(senderSide.sent, "the sender's signals").toContain("ice");
    expect(senderSide.sent, "the sender's signals").not.toContain("offer");
    expect([...senderSide.failures, ...recipientSide.failures]).toEqual([]);
  });

  test("an older recipient's page: both pages say the recipient's must reload", async ({
    actor,
    leaks,
    canary,
  }) => {
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 1000 }));
    const sender = await blobActor(actor, "sender");
    await sender.addInitScript(slowDecrypt);
    const senderSide = await shiftMarkers(sender, "s", -1);
    await openSend(sender, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    senderSide.start(link);
    const recipient = await blobActor(actor, "recipient");
    const recipientSide = await shiftMarkers(recipient, "r", 1);
    recipientSide.start(link);
    await recipient.goto(link);

    await expect(recipient.getByRole("heading", { name: "This page is out of date" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(recipient.getByText("Reload the page to receive the file.")).toBeVisible();
    await expect(
      recipientRow(sender, name).getByText(
        `${name}'s link was opened on an older version of Fidant. Nothing is wrong with the file. Ask them to reload that page.`,
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(recipient.getByText(/couldn't read/)).toHaveCount(0);
    await expect(recipient.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(recipient.getByRole("button", { name: "Download" })).toHaveCount(0);

    expect(senderSide.seen, "the recipient's marker").toHaveLength(1);
    expect(recipientSide.seen, "the sender's marker").toEqual(senderSide.seen);
    expect(senderSide.sent, "the sender's signals").toContain("ice");
    expect(senderSide.sent, "the sender's signals").not.toContain("offer");
    expect(recipientSide.sent, "the recipient's signals").toContain("commit");
    expect(recipientSide.sent, "the recipient's signals").not.toContain("answer");
    expect([...senderSide.failures, ...recipientSide.failures]).toEqual([]);
  });

  test("a joiner that forges a version marker is unbound at the join deadline", async ({
    actor,
    leaks,
    canary,
  }) => {
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 1000 }));
    const sender = await blobActor(actor, "sender");
    await openSend(sender, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const { linkId, seal } = signalsOf(link);
    const { page } = await actor("forger");
    await page.goto("/");
    const attempt = bareAttempt();
    await joinBare(page, "forger", linkId, attempt);
    await page.evaluate(({ linkId }) => Object.assign(globalThis, { forgerLink: linkId }), {
      linkId,
    });
    await sendBare(page, "forger", linkId, await seal(attempt, "r", marker(4)));

    await expect(recipientRow(sender, name).getByText(/newer version of Fidant/)).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(() => seenBare(page, "forger"), { timeout: 30_000 })
      .toContain("refused:drop");
  });

  test("a join right after a left that waits on a signal is not refused as busy", async ({
    actor,
    leaks,
    canary,
  }) => {
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 1000 }));
    const sender = await blobActor(actor, "sender");
    await sender.addInitScript(slowDecrypt);
    await openSend(sender, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    const { linkId, seal } = signalsOf(link);
    const { page } = await actor("forger");
    await page.goto("/");
    const first = bareAttempt();
    await joinBare(page, "first", linkId, first);
    await page.evaluate(({ linkId }) => Object.assign(globalThis, { firstLink: linkId }), {
      linkId,
    });
    await sendBare(page, "first", linkId, await seal(first, "r", marker(3)));
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const { ws } = (globalThis as unknown as { first: { ws: WebSocket } }).first;
          ws.onclose = () => resolve();
          ws.close();
        }),
    );
    await joinBare(page, "second", linkId, bareAttempt());
    await page.waitForTimeout(1500);
    expect(await seenBare(page, "second")).not.toContain("refused:busy");
  });

  test("a page from before the version check still sends", async ({ actor, leaks, canary }) => {
    const file = leaks.watch(canaryFile(canary.fork("file"), { size: 100_001 }));
    const sender = await blobActor(actor, "sender");
    const senderSide = await dropFirst(sender, "s");
    await openSend(sender, file);
    const name = makeName(leaks, canary, "Anna");
    const link = await addRecipient(leaks, sender, name);
    senderSide.start(link);
    const recipient = await blobActor(actor, "recipient");
    const recipientSide = await dropFirst(recipient, "r");
    recipientSide.start(link);
    await recipient.goto(link);

    const downloading = recipient.waitForEvent("download", { timeout: 30_000 });
    await recipient.getByRole("button", { name: "Download" }).click({ timeout: 30_000 });
    await expect(recipient.getByText("this is exactly the file that was sent")).toBeVisible({
      timeout: 30_000,
    });
    const saved = await downloading;
    expect(Buffer.compare(await readFile(await saved.path()), file.bytes)).toBe(0);
    await expect(delivered(sender, name)).toBeAttached();

    for (const [label, dropped] of [
      ["the sender's", senderSide],
      ["the recipient's", recipientSide],
    ] as const) {
      const first = await dropped.first();
      expect(first && markerVersion(first), `${label} first signal is its marker`).toBeGreaterThan(
        0,
      );
    }
  });
});
