import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  BLOB_TYPE,
  BlobSink,
  canPickSaveFile,
  createSink,
  FileSystemSink,
  isPickerCancel,
  type SaveWritable,
  type ShowSaveFilePicker,
} from "./sink.ts";

test("BlobSink keeps every byte in order across folds", async () => {
  const sink = new BlobSink(1000);
  const chunks = [10, 999, 1, 1500, 0, 3000, 7].map((n) => new Uint8Array(randomBytes(n)));
  for (const chunk of chunks) await sink.write(chunk);
  const blob = await sink.close();
  const expected = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    expected.set(chunk, offset);
    offset += chunk.length;
  }
  assert.equal(blob.type, BLOB_TYPE);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), expected);
});

test("BlobSink of nothing is an empty Blob", async () => {
  const blob = await new BlobSink().close();
  assert.equal(blob.size, 0);
});

test("BlobSink refuses writes after close or abort", async () => {
  const closed = new BlobSink();
  await closed.close();
  await assert.rejects(closed.write(new Uint8Array(1)));
  const aborted = new BlobSink();
  await aborted.write(new Uint8Array(10));
  await aborted.abort();
  await aborted.abort();
  await assert.rejects(aborted.write(new Uint8Array(1)));
  await assert.rejects(aborted.close());
});

function fakeWritable() {
  const log: string[] = [];
  const writable: SaveWritable = {
    async write(data) {
      log.push(`write ${data.length}`);
    },
    async close() {
      log.push("close");
    },
    async abort() {
      log.push("abort");
    },
  };
  return { log, writable };
}

test("FileSystemSink writes through and aborts only while open", async () => {
  const done = fakeWritable();
  const sink = new FileSystemSink(done.writable);
  await sink.write(new Uint8Array(5));
  assert.equal(await sink.close(), undefined);
  await sink.abort();
  assert.deepEqual(done.log, ["write 5", "close"]);

  const failed = fakeWritable();
  const other = new FileSystemSink(failed.writable);
  await other.write(new Uint8Array(3));
  await other.abort();
  await other.abort();
  await assert.rejects(other.write(new Uint8Array(1)));
  assert.deepEqual(failed.log, ["write 3", "abort"]);
});

test("createSink falls back to a BlobSink without showSaveFilePicker", async () => {
  assert.equal(canPickSaveFile(), false);
  assert.ok((await createSink("a.bin")) instanceof BlobSink);
});

test("createSink opens the save picker synchronously", async (t) => {
  const g = globalThis as { showSaveFilePicker?: ShowSaveFilePicker };
  t.after(() => {
    delete g.showSaveFilePicker;
  });
  const names: Array<string | undefined> = [];
  const fake = fakeWritable();
  g.showSaveFilePicker = async (options) => {
    names.push(options?.suggestedName);
    return { createWritable: async () => fake.writable };
  };
  assert.equal(canPickSaveFile(), true);
  const pending = createSink("report.bin");
  assert.deepEqual(names, ["report.bin"]);
  assert.ok((await pending) instanceof FileSystemSink);

  g.showSaveFilePicker = async () => {
    throw new DOMException("The user aborted a request.", "AbortError");
  };
  const cancelled = await createSink("x").catch((error: unknown) => error);
  assert.equal(isPickerCancel(cancelled), true);
});
