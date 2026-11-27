import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";

const dir = new URL("../../../.github/workflows/", import.meta.url);
const parse = (name: string): Record<string, unknown> => {
  const doc = load(readFileSync(new URL(name, dir), "utf8"));
  assert.ok(doc && typeof doc === "object", `${name}: not a mapping`);
  return doc as Record<string, unknown>;
};
const safeEvents = ["push", "pull_request", "schedule", "workflow_dispatch"];
const reviewCondition = [
  "github.event.pull_request.head.repo.full_name == github.repository &&",
  `contains(fromJSON('[633855,12341157]'), github.event.pull_request.user.id) &&`,
  "github.event.pull_request.draft == false",
].join(" ");

test("every workflow runs only on push, pull_request, schedule or workflow_dispatch, except release-jobs.yml, which runs only when release.yml calls it", () => {
  const names = readdirSync(dir).filter((n) => /\.ya?ml$/.test(n));
  assert.ok(names.length > 0);
  for (const name of names) {
    const on = parse(name).on;
    assert.ok(
      on && typeof on === "object" && !Array.isArray(on),
      `${name}: on is not a mapping of events`,
    );
    if (name === "release-jobs.yml") {
      assert.deepEqual(Object.keys(on), ["workflow_call"]);
      continue;
    }
    for (const event of Object.keys(on)) {
      assert.ok(safeEvents.includes(event), `${name}: ${event}`);
    }
    if (name !== "release.yml") {
      assert.doesNotMatch(readFileSync(new URL(name, dir), "utf8"), /release-jobs\.yml/, name);
    }
  }
});

test("the Claude review runs only for maintainers' pull requests from this repository", () => {
  const jobs = Object.entries(
    (parse("claude-review.yml").jobs ?? {}) as Record<string, { if?: unknown }>,
  );
  assert.ok(jobs.length > 0);
  for (const [id, job] of jobs) {
    const condition = typeof job.if === "string" ? job.if.replace(/\s+/g, " ").trim() : job.if;
    assert.equal(condition, reviewCondition, `job ${id}`);
  }
});
