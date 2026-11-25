import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../i18n/en.ts";
import { sv } from "../i18n/sv.ts";
import { CHOICES, type Choice, holds, tracesFor } from "./traces.ts";

const choices: Choice[] = CHOICES.what.flatMap((what) =>
  CHOICES.link.flatMap((link) => CHOICES.route.map((route) => ({ what, link, route }))),
);
const places = en.technical.explorer.places;

test("holds reads alternatives split by commas and options split by spaces", () => {
  const choice: Choice = { what: "secret", link: "email", route: "relay" };
  assert.ok(holds("", choice));
  assert.ok(holds("email relay", choice));
  assert.ok(holds("direct,relay", choice));
  assert.ok(!holds("email direct", choice));
  assert.ok(!holds("file", choice));
});

test("every when names only real options, the same in Swedish", () => {
  const options = new Set<string>(Object.values(CHOICES).flat());
  for (const [id, place] of Object.entries(places)) {
    const whens = place.lines.map(([when]) => when);
    for (const option of whens.flatMap((when) => when.split(/[ ,]/)).filter(Boolean)) {
      assert.ok(options.has(option), `${id}: ${option}`);
    }
    const swedish = sv.technical.explorer.places[id as keyof typeof places];
    assert.deepEqual(
      swedish.lines.map(([when]) => when),
      whens,
      id,
    );
  }
});

test("each path shows exactly the places it uses", () => {
  for (const choice of choices) {
    const used = (id: keyof typeof places) => tracesFor(places[id].lines, choice).length > 0;
    const path = JSON.stringify(choice);
    // Every path touches both browsers, our server, its proxy, its log, the STUN relay and the networks.
    for (const id of [
      "sender",
      "recipient",
      "server",
      "proxy",
      "log",
      "relay",
      "networks",
    ] as const) {
      assert.ok(used(id), `${path}: ${id}`);
    }
    assert.equal(used("mail"), choice.link === "email", `${path}: mail`);
    assert.equal(used("channel"), choice.link === "self", `${path}: channel`);
  }
});
