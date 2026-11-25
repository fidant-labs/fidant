import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

// docs/transfer-paths.md is the audit baseline for every transfer path. These checks make a
// new signaling message, log event or log field, or a moved file, fail until the doc follows.
const root = new URL("../../../", import.meta.url);
const doc = readFileSync(new URL("docs/transfer-paths.md", root), "utf8");
const source = readFileSync(new URL("signaling.ts", import.meta.url), "utf8");

/** The string members of `export type <name> = | "a" | "b";`. */
function members(name: string): string[] {
  const block = source.match(new RegExp(`export type ${name} =([^;]*);`))?.[1] ?? "";
  return [...block.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] as string);
}

test("the doc names every signaling message type", () => {
  const types = new Set([...source.matchAll(/\bt: "([a-z-]+)"/g)].map((m) => m[1] as string));
  assert.ok(types.size > 10);
  for (const t of types) {
    assert.ok(doc.includes(`\`${t}\``), `docs/transfer-paths.md doesn't name the \`${t}\` message`);
  }
});

test("the doc names every log event and log field", () => {
  const events = members("LogEvent");
  const fields = [
    ...(source.match(/export type LogFields = \{([^}]*)\}/)?.[1] ?? "").matchAll(/(\w+)\?:/g),
  ].map((m) => m[1] as string);
  assert.ok(events.length > 10 && fields.length > 3);
  for (const name of [...events, ...fields]) {
    assert.ok(doc.includes(name), `docs/transfer-paths.md doesn't name the log \`${name}\``);
  }
});

test("every file the doc names exists", () => {
  const paths = [...doc.matchAll(/`((?:apps|packages|docs|\.github|\.claude)\/[^`\s]+\.\w+)`/g)];
  assert.ok(paths.length > 10);
  for (const [, path] of paths) {
    assert.ok(existsSync(new URL(path as string, root)), `docs/transfer-paths.md names ${path}`);
  }
});
