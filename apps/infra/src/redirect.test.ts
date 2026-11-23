import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { primaryDomain, siteNames } from "./config.ts";

type Request = { uri: string; headers: { host?: { value: string } } };
type Handler = (event: { request: Request }) => unknown;

const handler = runInNewContext(
  `${readFileSync(new URL("redirect.js", import.meta.url), "utf8")}\nhandler`,
) as Handler;

function redirectFor(host: string | undefined, uri = "/"): unknown {
  return JSON.parse(JSON.stringify(handler({ request: requestFor(host, uri) })));
}

function requestFor(host: string | undefined, uri = "/"): Request {
  return { uri, headers: host === undefined ? {} : { host: { value: host } } };
}

test("passes requests for the primary domain through unchanged", () => {
  const request = requestFor(primaryDomain, "/index.html");
  assert.equal(handler({ request }), request);
});

test("sends every other site name to the primary domain, keeping the path", () => {
  for (const name of siteNames.filter((name) => name !== primaryDomain)) {
    assert.deepEqual(redirectFor(name, "/a/b"), {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: `https://${primaryDomain}/a/b` } },
    });
  }
});

test("redirects a request without a Host header", () => {
  const response = redirectFor(undefined) as { statusCode: number };
  assert.equal(response.statusCode, 301);
});
