import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { otherRun, projectName } from "./networks.ts";

const own = "/work/a/apps/e2e/networks/compose.yaml";
const theirs = "/work/b/apps/e2e/networks/compose.yaml";

test("the project name is the one compose.yaml sets", () => {
  const compose = readFileSync(new URL("../../networks/compose.yaml", import.meta.url), "utf8");
  assert.equal(/^name: (\S+)$/m.exec(compose)?.[1], projectName);
});

test("nothing up: no other run", () => {
  assert.equal(otherRun([], own), undefined);
});

test("this checkout's leftovers are not another run", () => {
  assert.equal(otherRun([{ Name: "fidant-e2e", ConfigFiles: own }], own), undefined);
});

test("this checkout's leftovers with the CI cache file are not another run", () => {
  const files = `${own},/work/a/apps/e2e/networks/compose.gha-cache.yaml`;
  assert.equal(otherRun([{ Name: "fidant-e2e", ConfigFiles: files }], own), undefined);
});

test("another checkout's compose project is another run", () => {
  const projects = [
    { Name: "unrelated", ConfigFiles: "/elsewhere/compose.yaml" },
    { Name: "fidant-e2e", ConfigFiles: theirs },
  ];
  assert.equal(otherRun(projects, own), theirs);
});

test("a project with no compose file listed is another run", () => {
  assert.equal(otherRun([{ Name: "fidant-e2e", ConfigFiles: "" }], own), "an unknown checkout");
});

test("another project name is not a run", () => {
  assert.equal(otherRun([{ Name: "unrelated", ConfigFiles: theirs }], own), undefined);
});
