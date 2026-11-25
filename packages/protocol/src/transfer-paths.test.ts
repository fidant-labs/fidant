import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { LOG_EVENTS } from "./signaling.ts";

// "Every path and its traces" in docs/how-fidant-works.md is the audit baseline for every transfer
// path. These checks make a new signaling message, log event or log field, or a moved file, fail
// until the doc follows.
const root = new URL("../../../", import.meta.url);
const doc = readFileSync(new URL("docs/how-fidant-works.md", root), "utf8");
const source = readFileSync(new URL("signaling.ts", import.meta.url), "utf8");

/** The text from the `### heading` up to the next heading, or the end. */
function section(heading: string): string {
  const start = doc.indexOf(`\n### ${heading}\n`);
  assert.ok(start >= 0, `docs/how-fidant-works.md has no "### ${heading}" section`);
  const end = doc.indexOf("\n#", start + 1);
  return doc.slice(start, end < 0 ? undefined : end);
}

/** Whether `text` has a table row that starts with `name` in backticks. */
function hasRow(text: string, name: string): boolean {
  return new RegExp(`^\\| \`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` +\\|`, "m").test(text);
}

test("the doc has a table row for every signaling message type", () => {
  const messages = section("Every signaling message");
  const types = new Set([...source.matchAll(/\bt: "([a-z-]+)"/g)].map((m) => m[1] as string));
  assert.ok(types.size > 10);
  for (const t of types) {
    assert.ok(hasRow(messages, t), `the messages table has no row for \`${t}\``);
  }
});

test("the doc has a table row for every log event and lists every log field", () => {
  const log = section("Every server log line");
  const fields = [
    ...(source.match(/export type LogFields = \{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+)\??:/g),
  ].map((m) => m[1] as string);
  assert.ok(fields.length > 3);
  for (const e of LOG_EVENTS) {
    assert.ok(hasRow(log, e), `the log table has no row for \`${e}\``);
  }
  const line = log.split("\n").find((l) => l.startsWith("Fields:")) ?? "";
  assert.ok(line, "the log section has no Fields: line");
  for (const f of fields) {
    assert.ok(line.includes(`\`${f}\``), `the Fields: line doesn't name \`${f}\``);
  }
});

test("every file the doc names exists", () => {
  const paths = [...doc.matchAll(/`((?:apps|packages|docs|\.github|\.claude)\/[^`\s]+\.\w+)`/g)];
  assert.ok(paths.length > 10);
  for (const [, path] of paths) {
    assert.ok(existsSync(new URL(path as string, root)), `docs/how-fidant-works.md names ${path}`);
  }
});
