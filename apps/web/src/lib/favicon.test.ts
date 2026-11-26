import assert from "node:assert/strict";
import { test } from "node:test";
import { faviconHref, overallStatus } from "./favicon.ts";

test("an open transfer outranks a finished one, and a finished one outranks none", () => {
  assert.equal(overallStatus(["idle", "idle", "idle"]), "idle");
  assert.equal(overallStatus(["idle", "done", "idle"]), "done");
  assert.equal(overallStatus(["done", "idle", "active"]), "active");
});

test("status icons are inline, so a change of status asks the server for nothing", () => {
  assert.equal(faviconHref("idle"), "/favicon.svg");
  const active = faviconHref("active");
  const done = faviconHref("done");
  for (const href of [active, done]) {
    assert.match(href, /^data:image\/svg\+xml,/);
    assert.ok(decodeURIComponent(href).endsWith("</svg>"));
  }
  assert.notEqual(active, done);
});
