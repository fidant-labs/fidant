import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { canaryFile, canaryKey, SeededRandom } from "./canary.ts";
import { fileSecrets, keySecrets, type Secret } from "./needles.ts";
import { exemptTest, readRegistry, registerSecrets } from "./registry.ts";

const random = SeededRandom.fromLabel("registry test");
let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fidant-registry-test-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The secrets with the test name that `readRegistry` adds to each label. */
const named = (test: string, secrets: Secret[]) =>
  secrets.map((secret) => {
    const copy = { ...secret, label: `${secret.label} [${test}]` };
    return "bytes" in copy ? { ...copy, bytes: Buffer.from(copy.bytes) } : copy;
  });

test("reads back every secret, tagged with its test, and skips exempt tests", async () => {
  const file = fileSecrets("file#1", canaryFile(random.fork("file"), { size: 150_001 }));
  // An emailed link's secret keeps where it may appear, so the sweep allows it there too.
  const allowed = { link: "L", frames: ["sent email"], mail: { to: "a@example.com", notice: "N" } };
  const key = keySecrets("fragment", canaryKey(random.fork("key")).text).map((secret) => ({
    ...secret,
    allowed,
  }));
  const leaky = keySecrets("deliberate", canaryKey(random.fork("leaky")).bytes);
  registerSecrets(dir, "test-a", file);
  registerSecrets(dir, "test-b", key);
  registerSecrets(dir, "test-c", leaky);
  exemptTest(dir, "test-c");

  const { secrets, exempt } = await readRegistry(dir);
  assert.deepEqual(secrets, [...named("test-a", file), ...named("test-b", key)]);
  assert.deepEqual([...exempt], ["test-c"]);
  assert.ok(file.some((secret) => "size" in secret));
  assert.ok(file.some((secret) => "caseInsensitive" in secret && secret.window === 12));
  assert.deepEqual(await readdir(dir), [`${process.pid}.jsonl`]);
});
