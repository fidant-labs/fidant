import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

// The stack's Mailpit API. Read on each call: global setup sets it after this module loads.
const api = () => process.env.SIGILL_E2E_MAILPIT;

async function call(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${api()}${path}`, init);
  if (!response.ok) {
    throw new Error(`Mailpit answered ${response.status} to ${init?.method ?? "GET"} ${path}.`);
  }
  return response;
}

async function saved(mailDir: string): Promise<string[]> {
  const names = await readdir(mailDir).catch(() => []);
  return names.filter((name) => name.endsWith(".eml")).map((name) => join(mailDir, name));
}

/**
 * Saves the raw source of every message Mailpit holds as `<dir>/mail/<ID>.eml`, skipping those
 * already saved there, and returns the paths of all messages saved there. The source includes the
 * envelope as Mailpit records it (Return-Path, Received and, for recipients not in To or Cc, Bcc).
 * Without Mailpit it saves nothing.
 */
export async function saveMail(dir: string): Promise<string[]> {
  const mailDir = join(dir, "mail");
  if (api()) {
    // Mailpit keeps at most 500 messages by default.
    const list = (await (await call("/api/v1/messages?limit=500")).json()) as {
      messages: { ID: string }[];
    };
    for (const { ID } of list.messages) {
      const path = join(mailDir, `${ID}.eml`);
      if (!existsSync(path)) {
        const raw = await call(`/api/v1/message/${ID}/raw`);
        await mkdir(mailDir, { recursive: true });
        await writeFile(path, Buffer.from(await raw.arrayBuffer()));
      }
    }
  }
  return saved(mailDir);
}

/** Deletes the messages saved in `<dir>/mail/` from Mailpit. Mail that came later stays. */
export async function deleteSavedMail(dir: string): Promise<void> {
  const IDs = (await saved(join(dir, "mail"))).map((path) => basename(path, ".eml"));
  if (api() && IDs.length > 0) {
    await call("/api/v1/messages", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ IDs }),
    });
  }
}

/** A message as Mailpit's API gives it: `Text` is the decoded plain-text body. */
export interface Message {
  ID: string;
  Subject: string;
  Text: string;
  HTML: string;
}

/** The messages Mailpit holds for `to`, newest first. */
export async function mailTo(to: string): Promise<Message[]> {
  const query = encodeURIComponent(`to:"${to}"`);
  const { messages } = (await (await call(`/api/v1/search?query=${query}`)).json()) as {
    messages: { ID: string }[];
  };
  return Promise.all(
    messages.map(async ({ ID }) => (await (await call(`/api/v1/message/${ID}`)).json()) as Message),
  );
}

/** Puts a message into Mailpit through its send API, for a deliberate leak. Returns its ID. */
export async function injectMail(message: {
  to: string;
  subject: string;
  text: string;
}): Promise<string> {
  const response = await call("/api/v1/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      From: { Email: "noreply@example.com" },
      To: [{ Email: message.to }],
      Subject: message.subject,
      Text: message.text,
    }),
  });
  return ((await response.json()) as { ID: string }).ID;
}
