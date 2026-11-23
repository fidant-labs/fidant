import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { primaryDomain, siteNames } from "./config.ts";

type Request = {
  uri: string;
  headers: { host?: { value: string } };
  rawQueryString: () => string | undefined;
};
type Handler = (event: { request: Request }) => unknown;

const handler = runInNewContext(
  `${readFileSync(new URL("redirect.js", import.meta.url), "utf8")}\nhandler`,
) as Handler;

function requestFor(host: string | undefined, uri = "/", query?: string): Request {
  return {
    uri,
    headers: host === undefined ? {} : { host: { value: host } },
    rawQueryString: () => query,
  };
}

function locationFor(host: string | undefined, uri = "/", query?: string): string {
  const response = handler({ request: requestFor(host, uri, query) }) as {
    statusCode: number;
    headers: { location: { value: string } };
  };
  assert.equal(response.statusCode, 301);
  return response.headers.location.value;
}

test("passes requests for the primary domain through unchanged", () => {
  const request = requestFor(primaryDomain, "/index.html");
  assert.equal(handler({ request }), request);
});

test("sends every other site name to the primary domain, keeping the path", () => {
  for (const name of siteNames.filter((name) => name !== primaryDomain)) {
    assert.deepEqual(JSON.parse(JSON.stringify(handler({ request: requestFor(name, "/a/b") }))), {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: `https://${primaryDomain}/a/b` } },
    });
  }
});

test("keeps the query string exactly as the viewer sent it", () => {
  assert.equal(locationFor("www.fidant.se", "/", "a=1&b=%20x"), "https://fidant.se/?a=1&b=%20x");
});

test("leaves no dangling question mark when the query string is empty", () => {
  assert.equal(locationFor("fidant.eu", "/", ""), "https://fidant.se/");
  assert.equal(locationFor("fidant.eu", "/", undefined), "https://fidant.se/");
});

test("redirects a request without a Host header", () => {
  assert.equal(locationFor(undefined), "https://fidant.se/");
});
