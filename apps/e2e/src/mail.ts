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
