import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deleteSavedMail, saveMail } from "./mail.ts";

test("saves each message Mailpit holds once and deletes only the saved ones", async (t) => {
  const messages: Record<string, string> = {
    A1: "Subject: one\r\n\r\nfirst\r\n",
    B2: "Subject: two\r\n\r\nsecond\r\n",
  };
  const fetched: string[] = [];
  const deleted: string[][] = [];
  const mailpit = createServer(async (request, response) => {
    const raw = /^\/api\/v1\/message\/(\w+)\/raw$/.exec(request.url ?? "");
    if (request.method === "GET" && request.url === "/api/v1/messages?limit=500") {
      response.end(JSON.stringify({ messages: Object.keys(messages).map((ID) => ({ ID })) }));
    } else if (request.method === "GET" && raw?.[1] && messages[raw[1]]) {
      fetched.push(raw[1]);
      response.end(messages[raw[1]]);
    } else if (request.method === "DELETE" && request.url === "/api/v1/messages") {
      const body = (await request.toArray()).join("");
      deleted.push((JSON.parse(body) as { IDs: string[] }).IDs.toSorted());
      response.end("ok");
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => mailpit.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "sigill-e2e-mail-test-"));
  t.after(async () => {
    delete process.env.SIGILL_E2E_MAILPIT;
    mailpit.close();
    await rm(dir, { recursive: true, force: true });
  });
  process.env.SIGILL_E2E_MAILPIT = `http://127.0.0.1:${(mailpit.address() as AddressInfo).port}`;
  const mailDir = join(dir, "mail");
  await mkdir(mailDir);
  await writeFile(join(mailDir, "A1.eml"), "saved before");

  const paths = await saveMail(dir);

  assert.deepEqual(paths.toSorted(), [join(mailDir, "A1.eml"), join(mailDir, "B2.eml")]);
  assert.deepEqual(fetched, ["B2"]);
  assert.equal(await readFile(join(mailDir, "A1.eml"), "utf8"), "saved before");
  assert.equal(await readFile(join(mailDir, "B2.eml"), "utf8"), messages.B2);

  messages.C3 = "Subject: late\r\n\r\nthird\r\n";
  await deleteSavedMail(dir);
  assert.deepEqual(deleted, [["A1", "B2"]]);

  delete process.env.SIGILL_E2E_MAILPIT;
  await deleteSavedMail(dir);
  assert.deepEqual(await saveMail(join(dir, "other")), []);
  assert.deepEqual(deleted, [["A1", "B2"]]);
  assert.deepEqual(fetched, ["B2"]);
});
