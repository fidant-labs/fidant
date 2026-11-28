import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type Actor,
  breakableRoute,
  type CuttableSignal,
  canaryFile,
  chooseFile,
  cuttableSignal,
  delivered,
  expect,
  makeName,
  type Observed,
  test,
} from "../src/fixtures.ts";
import { readPeerConnections, recordPeerConnections } from "../src/ice.ts";
import { serverStderrLog, serverStdoutLog } from "../src/paths.ts";

// Decision 0033: a page whose signaling socket drops mid-transfer, while the server still holds
// the old socket open, connects again, takes its side of the attempt back with its resume token,
// and the route that dropped with it is recovered by the ICE restart of decision 0031 on the same
// connection. The socket is cut in Playwright's route, so the server sees nothing until the new
// socket presents the token; the route drop is simulated in the pages (`breakableRoute`).

const sha256Hex = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const verifiedText = "this is exactly the file that was sent";
/** About 43 CHUNKs; the sender holds its frames from the 10th on, so the file is in flight. */
const size = 2 * 1024 * 1024 + 1;

type Message = Record<string, unknown> & { t: string };

/** Parsed signaling messages that `actor` sent or received, in order. */
async function frames(
  observed: (name: string) => Observed,
  actor: string,
  direction: "frame-sent" | "frame-received",
): Promise<Message[]> {
  return (await observed(actor).records()).flatMap((record) =>
    record.type === direction && !record.base64 ? [JSON.parse(record.payload) as Message] : [],
  );
}

const ofType = (messages: Message[], t: string) => messages.filter((message) => message.t === t);

const variants = [
  { lost: "recipient", stallFirst: false },
  { lost: "sender", stallFirst: false },
  // The recipient's connection stalls before its page sees the socket close (decision 0033).
  { lost: "recipient", stallFirst: true },
] as const;
for (const { lost, stallFirst } of variants) {
  const order = stallFirst ? " whose route stalls before it sees the close" : "";
  test(`a ${lost} page${order} that loses its signaling socket mid-transfer takes its attempt back`, async ({
    actor,
    observed,
    leaks,
    canary,
  }) => {
    const file = leaks.watch(canaryFile(canary.fork("file"), { size }));
    const name = makeName(leaks, canary, "Anna");
    const pageErrors: string[] = [];
    const open = async (who: string): Promise<Actor> => {
      const opened = await actor(who);
      // Also removes showSaveFilePicker, so the file arrives as a download.
      await recordPeerConnections(opened.context);
      await opened.context.addInitScript(breakableRoute);
      opened.page.on("pageerror", (error) => pageErrors.push(`${who}: ${error.message}`));
      return opened;
    };
    const sockets: Record<string, CuttableSignal> = {};

    const sender = await open("sender");
    if (lost === "sender") {
      sockets.sender = await cuttableSignal(sender.page);
    }
    await sender.page.goto("/send");
    await sender.page.evaluate(() => {
      (globalThis as { holdAt?: number }).holdAt = 10;
    });
    await chooseFile(sender.page, { name: file.name, mimeType: file.mime, buffer: file.bytes });
    const who = sender.page.getByLabel("Who is it for?");
    await who.fill(name);
    await who.press("Enter");
    const link =
      (await sender.page.getByLabel(`Link for ${name}`, { exact: true }).textContent()) ?? "";
    leaks.watchKey("link secret", new URL(link).hash.slice(1));

    const recipient = await open("recipient");
    if (lost === "recipient") {
      sockets.recipient = await cuttableSignal(recipient.page);
    }
    await recipient.page.goto(link);
    const downloading = recipient.page.waitForEvent("download", { timeout: 30_000 });
    const downloadButton = recipient.page.getByRole("button", { name: "Download" });
    await expect(downloadButton).toBeVisible();

    // The channel opened and the sender reported its path: both pages hold a resume token.
    const tokens = async (actorName: string) =>
      ofType(await frames(observed, actorName, "frame-received"), "resume").filter(
        (message) => typeof message.token === "string",
      );
    await expect.poll(async () => (await tokens("sender")).length).toBe(1);
    await expect.poll(async () => (await tokens("recipient")).length).toBe(1);

    await downloadButton.click();
    const held = () => sender.page.evaluate(() => (globalThis as { held?: boolean }).held === true);
    await expect.poll(held).toBe(true);
    // Not a label query with evaluateAll: Playwright's Firefox crashes the page on that.
    const received = () =>
      recipient.page.evaluate(() => document.querySelector("progress")?.value ?? 0);
    await expect.poll(received).toBeGreaterThan(0);
    expect(await received(), "still in flight").toBeLessThan(size);

    const cut = sockets[lost];
    if (!cut) {
      throw new Error(`no cuttable socket for the ${lost}`);
    }
    const dropRoute = () =>
      Promise.all(
        [sender.page, recipient.page].map((page) =>
          page.evaluate(() => (globalThis as { dropRoute?: () => void }).dropRoute?.()),
        ),
      );
    if (stallFirst) {
      // The socket is dead but looks open: the route drops, the stall's `join` goes onto it and is
      // swallowed, and only then does the page see the close.
      const swallowedJoins = () => cut.swallowed().filter((t) => t === "join").length;
      cut.silence();
      await dropRoute();
      await expect.poll(swallowedJoins, { timeout: 25_000 }).toBe(1);
    }
    await cut.cut();
    const cutAt = Date.now();
    if (stallFirst) {
      // The only stall is the one whose `join` was swallowed.
    } else if (lost === "recipient") {
      // The route drops with the socket: the recipient stalls while it has none, and asks again
      // once it took its attempt back.
      await dropRoute();
    } else {
      // A sender that changed networks gets its socket back before the recipient's browser
      // notices the route is gone (decision 0033, A2 and A7).
      await expect.poll(async () => (await tokens("sender")).length).toBe(2);
      await dropRoute();
    }

    // The server ended the old socket when the new one took over, not at its heartbeat.
    await expect.poll(cut.serverClosedAt, { timeout: 5_000 }).toBeDefined();
    expect((cut.serverClosedAt() ?? 0) - cutAt, "old socket ended within").toBeLessThan(5_000);

    await expect(recipient.page.getByText(verifiedText)).toBeVisible({ timeout: 20_000 });
    const download = await downloading;
    expect(sha256Hex(await readFile(await download.path()))).toBe(sha256Hex(file.bytes));
    await expect(recipient.page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(recipient.page.getByText("The sender's page is closed")).toHaveCount(0);
    await expect(delivered(sender.page, name)).toBeAttached();
    await expect(
      sender.page.getByText(`The transfer through ${name}'s link was interrupted`),
    ).toHaveCount(0);
    expect(pageErrors, "uncaught page errors").toEqual([]);

    const sent = {
      sender: await frames(observed, "sender", "frame-sent"),
      recipient: await frames(observed, "recipient", "frame-sent"),
    };
    const got = {
      sender: await frames(observed, "sender", "frame-received"),
      recipient: await frames(observed, "recipient", "frame-received"),
    };
    // Only the page that lost its socket resumed, once, and the server gave it a new token.
    const other = lost === "sender" ? "recipient" : "sender";
    expect(ofType(sent[lost], "resume"), `${lost} resume frames`).toHaveLength(1);
    expect(ofType(sent[other], "resume"), `${other} resume frames`).toHaveLength(0);
    expect(await tokens(lost), `${lost} tokens`).toHaveLength(2);
    expect(await tokens(other), `${other} tokens`).toHaveLength(1);
    // Neither page saw the other go: no host-gone, and the sender's only `left` is the recipient
    // leaving with the file, after the restart's `joined`.
    expect(ofType(got.recipient, "host-gone"), "host-gone").toHaveLength(0);
    const lefts = got.sender.flatMap((message, index) => (message.t === "left" ? [index] : []));
    expect(lefts.length, "left").toBeLessThanOrEqual(1);
    expect(lefts[0] ?? Infinity, "left after the restart").toBeGreaterThan(
      got.sender.findLastIndex((message) => message.t === "joined"),
    );

    // One attempt: every join, joined and resume names the same one.
    const joins = ofType(sent.recipient, "join");
    expect(joins.length, "the recipient joined again after the drop").toBeGreaterThanOrEqual(2);
    if (stallFirst) {
      // The swallowed `join` does not count: the resume answer must send one more.
      const kinds = sent.recipient.flatMap((m) =>
        m.t === "resume" || m.t === "join" ? [m.t] : [],
      );
      expect(kinds.lastIndexOf("join"), "a join after the resume").toBeGreaterThan(
        kinds.indexOf("resume"),
      );
    }
    const attempts = new Set(
      [
        ...joins,
        ...ofType(got.recipient, "joined"),
        ...ofType(got.sender, "joined"),
        ...ofType(got.recipient, "resume"),
        ...ofType(got.sender, "resume"),
        ...ofType(sent[lost], "resume"),
      ].map((message) => message.attempt),
    );
    expect([...attempts], "attempt IDs").toHaveLength(1);

    for (const [whose, page] of [
      ["sender", sender.page],
      ["recipient", recipient.page],
    ] as const) {
      // One connection per page, which got a new ICE password: the restart, not a new attempt.
      const connections = await readPeerConnections(page);
      expect(connections.length, `${whose} peer connections`).toBe(1);
      const events = connections[0]?.events ?? [];
      const before = events.find((event) => event.state === "connected")?.pwd;
      const after = events.at(-1);
      expect(
        events.some((event) => event.state === "disconnected"),
        `${whose} dropped`,
      ).toBe(true);
      expect(before, `${whose} ICE password before the drop`).toBeTruthy();
      expect(after?.state, `${whose} ends connected`).toBe("connected");
      expect(after?.pwd, `${whose} ICE password after the drop`).toBeTruthy();
      expect(after?.pwd, `${whose} ICE password after the drop`).not.toBe(before);
    }

    // Each resume token is a key that only the `resume` frames about its link may carry, and the
    // server never logs it.
    const values = [...got.sender, ...got.recipient].flatMap((message) =>
      message.t === "resume" && typeof message.token === "string"
        ? [{ token: message.token, link: String(message.link) }]
        : [],
    );
    expect(values).toHaveLength(3);
    const logs = (
      await Promise.all([serverStdoutLog, serverStderrLog].map((path) => readFile(path, "utf8")))
    ).join("\n");
    for (const [index, { token, link: id }] of values.entries()) {
      expect(token).toMatch(/^[\w-]{22}$/);
      leaks.watchKey(`resume token ${index}`, token, "K", {
        link: id,
        frames: ["received resume", "sent resume"],
      });
      expect(logs.includes(token), `resume token ${index} in the server log`).toBe(false);
    }
  });
}
