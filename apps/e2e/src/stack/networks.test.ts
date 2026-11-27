import assert from "node:assert/strict";
import { test } from "node:test";
import { otherRun } from "./networks.ts";

const own = {
  composeFile: "/work/a/apps/e2e/networks/compose.yaml",
  checkout: "/work/a",
};
const theirs = "/work/b/apps/e2e/networks/compose.yaml";

test("nothing up: no other run", () => {
  assert.equal(otherRun([], undefined, own), undefined);
});

test("this checkout's leftovers are not another run", () => {
  const projects = [{ Name: "fidant-e2e", ConfigFiles: own.composeFile }];
  assert.equal(otherRun(projects, "/work/a", own), undefined);
});

test("this checkout's leftovers with the CI cache file are not another run", () => {
  const files = `${own.composeFile},/work/a/apps/e2e/networks/compose.gha-cache.yaml`;
  assert.equal(otherRun([{ Name: "fidant-e2e", ConfigFiles: files }], undefined, own), undefined);
});

test("another checkout's compose project is another run", () => {
  const projects = [
    { Name: "unrelated", ConfigFiles: "/elsewhere/compose.yaml" },
    { Name: "fidant-e2e", ConfigFiles: theirs },
  ];
  assert.equal(otherRun(projects, undefined, own), theirs);
});

test("another project name is not a run", () => {
  assert.equal(otherRun([{ Name: "unrelated", ConfigFiles: theirs }], undefined, own), undefined);
});

test("another checkout's server container is another run", () => {
  assert.equal(otherRun([], "/work/b", own), "/work/b");
});

test("a server container without a label is another run", () => {
  assert.match(otherRun([], "", own) ?? "", /without a checkout label/);
});
