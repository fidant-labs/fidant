import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { otherRun, projectName, waitForOtherRun } from "./networks.ts";

const own = "/work/a/apps/e2e/networks/compose.yaml";
const theirs = "/work/b/apps/e2e/networks/compose.yaml";
const running = { Name: "fidant-e2e", Status: "running(9)", ConfigFiles: theirs };
const stopped = { Name: "fidant-e2e", Status: "exited(9)", ConfigFiles: theirs };

test("the project name is the one compose.yaml sets", () => {
  const compose = readFileSync(new URL("../../networks/compose.yaml", import.meta.url), "utf8");
  assert.equal(/^name: (\S+)$/m.exec(compose)?.[1], projectName);
});

test("nothing up: no other run", () => {
  assert.equal(otherRun([], own), undefined);
});

test("this checkout's leftovers are not another run", () => {
  assert.equal(otherRun([{ ...running, ConfigFiles: own }], own), undefined);
});

test("this checkout's leftovers with the CI cache file are not another run", () => {
  const files = `${own},/work/a/apps/e2e/networks/compose.gha-cache.yaml`;
  assert.equal(otherRun([{ ...running, ConfigFiles: files }], own), undefined);
});

test("another checkout's compose project is another run", () => {
  const projects = [{ Name: "unrelated", Status: "running(1)", ConfigFiles: own }, running];
  assert.deepEqual(otherRun(projects, own), { file: theirs, stopped: false });
});

test("another checkout's stopped project is a run that no longer runs", () => {
  assert.deepEqual(otherRun([stopped], own), { file: theirs, stopped: true });
});

test("a project whose containers are still being created is not stopped", () => {
  const created = { ...running, Status: "created(9)" };
  assert.deepEqual(otherRun([created], own), { file: theirs, stopped: false });
});

test("a project partly stopped still runs", () => {
  const partly = { ...running, Status: "running(2), exited(7)" };
  assert.deepEqual(otherRun([partly], own), { file: theirs, stopped: false });
});

test("a project with no compose file listed is another run", () => {
  assert.equal(otherRun([{ ...running, ConfigFiles: "" }], own)?.file, "an unknown checkout");
});

test("another project name is not a run", () => {
  assert.equal(otherRun([{ ...running, Name: "unrelated" }], own), undefined);
});

// The real compose file is this checkout's, so `theirs` is never it.
const fast = { intervalMs: 1, logEveryMs: 0 };

test("the wait returns at once, saying nothing, when no other run is up", async () => {
  const lines: string[] = [];
  await waitForOtherRun({ ...fast, list: () => [], log: (line) => lines.push(line) });
  assert.deepEqual(lines, []);
});

test("the wait says what it waits for, and starts once the other run ends", async () => {
  const lists = [[running], [running], []];
  const lines: string[] = [];
  await waitForOtherRun({
    ...fast,
    list: () => lists.shift() ?? [],
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^Waiting for another pnpm e2e:networks run, from \/work\/b\//);
  assert.match(lines[2] ?? "", /^The other pnpm e2e:networks run ended after \d+ s; starting\.$/);
});

test("the wait fails on a run that left only stopped containers on two checks", async () => {
  const lists = [[running], [stopped], [stopped]];
  await assert.rejects(
    waitForOtherRun({ ...fast, list: () => lists.shift() ?? [running], log: () => {} }),
    /left stopped containers, on two checks.*docker compose -p fidant-e2e down/,
  );
  assert.deepEqual(lists, []);
});

test("the wait goes on through one check of stopped containers, as in a teardown", async () => {
  const lists = [[running], [stopped], []];
  await waitForOtherRun({ ...fast, list: () => lists.shift() ?? [running], log: () => {} });
  assert.deepEqual(lists, []);
});

test("the wait logs once per logEveryMs, not once per check", async () => {
  const lists = [[running], [running], [running], [running], []];
  const lines: string[] = [];
  await waitForOtherRun({
    intervalMs: 1,
    logEveryMs: 60_000,
    list: () => lists.shift() ?? [],
    log: (line) => lines.push(line),
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /^Waiting for another/);
  assert.match(lines[1] ?? "", /^The other pnpm e2e:networks run ended/);
});

test("the wait gives up on a run that outlasts the timeout", async () => {
  await assert.rejects(
    waitForOtherRun({ ...fast, timeoutMs: 0, list: () => [running], log: () => {} }),
    /still runs after 0 min of waiting/,
  );
});
