import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { signalName, signals, siteNames } from "./config.ts";

const code = readFileSync(new URL("../edge/site.js", import.meta.url), "utf8");
// CloudFront runs functions in strict mode.
const site = runInNewContext(`"use strict";\n${code}\n;({ handler, PAGES })`, Object.create(null));
const handler = site.handler as (event: unknown) => unknown;
const pages = [...(site.PAGES as string[])];

type Fields = Record<string, { value: string; multiValue?: { value: string }[] }>;
type Request = { method: string; uri: string; headers: Fields; querystring: Fields };
type Response = { statusCode: number; statusDescription?: string; headers: Fields };

function fields(values: Record<string, string | undefined>): Fields {
  return Object.fromEntries(
    Object.entries(values).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, { value }]],
    ),
  );
}

function viewer(target: string, headers: Record<string, string | undefined> = {}) {
  const cut = target.indexOf("?");
  const raw = cut < 0 ? undefined : target.slice(cut + 1);
  return {
    method: "GET",
    uri: cut < 0 ? target : target.slice(0, cut),
    querystring: {},
    headers: fields({ host: "fidant.se", ...headers }),
    cookies: {},
    rawQueryString: () => raw,
  };
}

/** The function's answer to the request event, through JSON, which drops the other realm's prototypes. */
function onRequest(
  target: string,
  headers: Record<string, string | undefined> = {},
): Request & Response {
  const event = {
    version: "1.0",
    context: { eventType: "viewer-request" },
    request: viewer(target, headers),
  };
  return JSON.parse(JSON.stringify(handler(event)));
}

function onResponse(request: unknown, statusCode = 200, headers: Fields = {}): Response {
  const event = {
    version: "1.0",
    context: { eventType: "viewer-response" },
    request,
    response: { statusCode, statusDescription: "OK", headers },
  };
  return JSON.parse(JSON.stringify(handler(event)));
}

const values = (headers: Fields) =>
  Object.fromEntries(Object.entries(headers).map(([name, field]) => [name, field.value]));

const caddyHsts =
  /\(hsts\) \{\n\theader Strict-Transport-Security "([^"]+)"\n\}/.exec(
    readFileSync(new URL("../box/user-data.sh", import.meta.url), "utf8"),
  )?.[1] ?? "";

const securityHeaders = {
  "content-security-policy": `default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self' wss://${signalName(signals[0]?.id ?? "")}`,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": caddyHsts,
};

test("the box's Caddyfile still names the HSTS the function sends", () => {
  assert.equal(caddyHsts, "max-age=31536000; includeSubDomains");
});

test("every other host goes to https://fidant.se with the same path and query, and HSTS", () => {
  for (const host of [...siteNames.filter((name) => name !== "fidant.se"), "d1.cloudfront.net"]) {
    for (const [target, location] of [
      ["/", "https://fidant.se/"],
      ["/how?x=a%2Fb&y", "https://fidant.se/how?x=a%2Fb&y"],
      ["/r/abc", "https://fidant.se/r/abc"],
      ["/x?", "https://fidant.se/x?"],
      ["/%E0", "https://fidant.se/%E0"],
    ]) {
      const answer = onRequest(target as string, { host });
      assert.equal(answer.statusCode, 301, `${host}${target}`);
      assert.deepEqual(
        values(answer.headers),
        { ...securityHeaders, location },
        `${host}${target}`,
      );
    }
  }
  const noHost = onRequest("/send", { host: undefined });
  assert.equal(noHost.headers.location?.value, "https://fidant.se/send");
  assert.equal(onRequest("/send", { host: "FIDANT.SE" }).uri, "/pages/send/index.html");
});

test("a page's path gets its file under pages/, and the Swedish ones are under pages/sv/", () => {
  for (const [target, uri] of [
    ["/", "/pages/index.html"],
    ["/send", "/pages/send/index.html"],
    ["/how/traces?x=1", "/pages/how/traces/index.html"],
    ["/sv", "/pages/sv/index.html"],
    ["/sv/sa-fungerar-det/lamnas-kvar", "/pages/sv/sa-fungerar-det/lamnas-kvar/index.html"],
    ["/se%6Ed", "/pages/send/index.html"],
  ] as const) {
    const answer = onRequest(target);
    assert.equal(answer.uri, uri, target);
    assert.equal(answer.headers["x-fidant-page"]?.value, "page", target);
  }
});

test("a moved path or a page's path with a slash is redirected, with its query", () => {
  for (const [target, location] of [
    ["/technical", "/how"],
    ["/technical/?a=1&b=x%2Fy", "/how?a=1&b=x%2Fy"],
    ["/send/", "/send"],
    ["/send/?", "/send"],
    ["/sv/", "/sv"],
    ["/send/.", "/send"],
  ] as const) {
    const answer = onRequest(target);
    assert.equal(answer.statusCode, 301, target);
    assert.deepEqual(values(answer.headers), { ...securityHeaders, location }, target);
  }
});

test("a path under /r/ gets the receive copy in the browser's language", () => {
  for (const [target, lang, uri] of [
    ["/r/abc", "sv-SE,sv;q=0.9", "/index.receive.sv.html"],
    ["/r/abc", "SV", "/index.receive.sv.html"],
    ["/r/abc", "en-US,sv;q=0.9", "/index.receive.en.html"],
    ["/r/abc", "svx", "/index.receive.en.html"],
    ["/r/a.b", "", "/index.receive.en.html"],
    ["/r/", undefined, "/index.receive.en.html"],
  ] as const) {
    const answer = onRequest(target, lang === undefined ? {} : { "accept-language": lang });
    assert.equal(answer.uri, uri, `${target} ${lang}`);
    assert.equal(answer.headers["x-fidant-page"]?.value, "receive", target);
  }
});

test("a file with an extension other than .html passes by its resolved path", () => {
  for (const [target, uri] of [
    ["/assets/app.js", "/assets/app.js"],
    ["/assets//app.js", "/assets/app.js"],
    ["/a/..%2ffavicon.svg", "/favicon.svg"],
    ["/favicon.svg/", "/favicon.svg"],
    ["/a%20b.txt", "/a%20b.txt"],
    ["/%2e%2e/secret.txt", "/secret.txt"],
    ["/a/../robots.txt", "/robots.txt"],
    ["/a\\..\\llms.txt", "/llms.txt"],
    ["/x.", "/x."],
  ] as const) {
    const answer = onRequest(target);
    assert.equal(answer.uri, uri, target);
    assert.equal(answer.headers["x-fidant-page"]?.value, "file", target);
  }
});

test("every other path gets the 404 page, the Swedish one under /sv", () => {
  for (const [target, uri] of [
    ["/nope", "/pages/404.html"],
    ["/Send", "/pages/404.html"],
    ["/index.html", "/pages/404.html"],
    ["/SEND.HTML", "/pages/404.html"],
    ["/pages/about/index.html", "/pages/404.html"],
    ["/index.receive.en.html", "/pages/404.html"],
    ["/relay-status", "/pages/404.html"],
    ["/signal", "/pages/404.html"],
    ["//about/", "/pages/404.html"],
    ["/x/..%2fabout", "/pages/404.html"],
    ["/assets/..%2findex.html", "/pages/404.html"],
    ["/.env", "/pages/404.html"],
    ["/sv/nope", "/pages/sv/404.html"],
    ["/sv//om/", "/pages/sv/404.html"],
    ["/svx", "/pages/404.html"],
  ] as const) {
    const answer = onRequest(target);
    assert.equal(answer.uri, uri, target);
    assert.equal(answer.headers["x-fidant-page"]?.value, "404", target);
  }
});

test("a malformed path gets 400 and one above the root 404, both with the headers", () => {
  for (const [target, status] of [
    ["/%E0%A4%A", 400],
    ["/%", 400],
    ["/..%2fsecret.txt", 404],
    ["/assets/..%2f..%2fsecret.txt", 404],
  ] as const) {
    const answer = onRequest(target);
    assert.equal(answer.statusCode, status, target);
    assert.deepEqual(values(answer.headers), securityHeaders, target);
  }
});

const targets = [
  ...pages,
  ...pages.map((page) => `${page}/`),
  "/r/",
  "/r/x/",
  "/assets/",
  "/assets/x.js/",
  "/.",
  "/a/..",
  "/%2e/",
  "//",
  "/x/..%2f",
];

test("never hands the origin / or a path ending in /, which would list the bucket", () => {
  for (const target of targets) {
    const answer = onRequest(target);
    if (answer.uri !== undefined) {
      assert.match(answer.uri, /^\/.*[^/]$/, target);
    }
  }
});

test("the forwarded request carries only the function's own x-fidant-page", () => {
  const answer = onRequest("/nope", { "x-fidant-page": "page" });
  assert.deepEqual(answer.headers["x-fidant-page"], { value: "404" });
});

test("the answer gets the headers, a 404 status and a type, whichever request the event carries", () => {
  for (const [target, status, type, extra] of [
    ["/", 200, "text/html; charset=utf-8", {}],
    ["/nope", 404, "text/html; charset=utf-8", {}],
    ["/sv/nope", 404, "text/html; charset=utf-8", {}],
    ["/assets/app.js", 200, "text/javascript; charset=utf-8", {}],
    ["/favicon.svg", 200, "image/svg+xml", {}],
    ["/FAVICON.SVG", 200, "application/octet-stream", {}],
    ["/x.bin", 200, "application/octet-stream", {}],
    [
      "/r/abc",
      200,
      "text/html; charset=utf-8",
      { vary: "accept-language", "x-robots-tag": "noindex" },
    ],
  ] as const) {
    for (const request of [onRequest(target), viewer(target)]) {
      const answer = onResponse(request, 200, fields({ "cache-control": "no-cache" }));
      assert.equal(answer.statusCode, status, target);
      assert.deepEqual(
        values(answer.headers),
        { "cache-control": "no-cache", ...securityHeaders, "content-type": type, ...extra },
        target,
      );
    }
  }
});

test("a visitor's x-fidant-page cannot change what a file is served as", () => {
  for (const sent of ["404", "receive", "page"]) {
    const answer = onResponse(
      viewer("/assets/app-abc.js", { "x-fidant-page": sent }),
      200,
      fields({ "cache-control": "no-cache" }),
    );
    assert.equal(answer.statusCode, 200, sent);
    assert.deepEqual(
      values(answer.headers),
      {
        "cache-control": "no-cache",
        ...securityHeaders,
        "content-type": "text/javascript; charset=utf-8",
      },
      sent,
    );
  }
});

test("a visitor's x-fidant-page cannot turn a path that decides 404 into a file", () => {
  for (const sent of ["file", "404"]) {
    const answer = onResponse(viewer("/nope", { "x-fidant-page": sent }), 200, {});
    assert.equal(answer.statusCode, 404, sent);
  }
});

test("a visitor's x-fidant-page cannot change the answer for a page or a receive path", () => {
  for (const target of ["/send", "/r/x"]) {
    const plain = onResponse(viewer(target), 200, fields({ vary: "accept-encoding" }));
    for (const sent of ["file", "404", "receive", "page"]) {
      const answer = onResponse(
        viewer(target, { "x-fidant-page": sent }),
        200,
        fields({ vary: "accept-encoding" }),
      );
      assert.deepEqual(answer, plain, `${target} ${sent}`);
    }
  }
  assert.equal(onResponse(viewer("/send"), 200).statusCode, 200);
  assert.equal(onResponse(viewer("/r/x"), 200).headers["x-robots-tag"]?.value, "noindex");
});

test("/relay-secret/ passes only a relay id, unchanged, and anything else is a 404 with the headers", () => {
  const passed = onRequest("/relay-secret/sto");
  assert.equal(passed.uri, "/relay-secret/sto");
  assert.equal(passed.headers["x-fidant-page"], undefined);
  assert.equal(onRequest("/relay-secret/abcdefghijklmnop").uri, "/relay-secret/abcdefghijklmnop");
  for (const target of [
    "/relay-secret/%2e%2e/signal",
    "/relay-secret/..\\signal",
    "/relay-secret/STO",
    "/relay-secret/sto/x",
    "/relay-secret/",
    "/relay-secret/a",
    "/relay-secret/abcdefghijklmnopq",
    "/relay-secret/1sto",
    "/relay-secret/-sto",
    "//relay-secret/sto",
    "/./relay-secret/sto",
    "/a/../relay-secret/sto",
    "/a/../relay-secret/x.js",
    "/%72elay-secret/sto",
    "/%72elay-secret/sto/x",
    "/./relay-secret//..",
    "/%72elay-secret//../sto",
    "/./relay-secret/%2e%2e",
    "/./relay-secret/.%2e/x.js",
    "//relay-secret//../x/sto",
    "/%2e%2e/relay-secret/sto",
    "/relay-secret%2fsto",
    "/relay-secret%2Fsto",
    "/relay-secret\\sto",
    "\\relay-secret/sto",
    "/x/%2e%2e%2frelay-secret/sto",
    "/how/relay-secret/x",
  ]) {
    const answer = onRequest(target);
    assert.equal(answer.statusCode, 404, target);
    assert.deepEqual(values(answer.headers), securityHeaders, target);
  }
  const www = onRequest("/relay-secret/sto", { host: "www.fidant.se" });
  assert.equal(www.statusCode, 301);
  assert.equal(www.headers.location?.value, "https://fidant.se/relay-secret/sto");
});

test("a 304 stays 304, and a receive copy keeps the origin's own vary", () => {
  assert.equal(onResponse(onRequest("/nope"), 304).statusCode, 304);
  const answer = onResponse(onRequest("/r/x"), 200, fields({ vary: "accept-encoding" }));
  assert.equal(answer.headers.vary?.value, "accept-encoding, accept-language");
});

const shorthand = /(?:^|[^$])\{\s*[A-Za-z_]\w*\s*[,}]|,\s*[A-Za-z_]\w*\s*\}/;

test("the shorthand pattern catches object shorthand and lets a regex quantifier pass", () => {
  for (const shorthandCode of ["f({ a, b })", "f({ a })", "f({ a: 1, b })", "f({ b, a: 1 })"]) {
    assert.match(shorthandCode, shorthand, shorthandCode);
  }
  assert.doesNotMatch("/^[a-z]{1,15}$/.test(x) && /a{2}/", shorthand);
});

test("the file fits CloudFront's 10 KB and keeps to what cloudfront-js-2.0 runs", () => {
  assert.ok(Buffer.byteLength(code) < 10 * 1024);
  const source = code.replace(/\/\/.*$/gm, "");
  for (const [what, pattern] of [
    ["??", /\?\?/],
    ["?.", /\?\.(?!\d)/],
    ["spread or rest", /\.\.\./],
    ["for...of", /\bfor\s*\([^)]*\bof\b/],
    ["destructuring", /\b(?:const|let|var)\s*[{[]/],
    ["default parameters", /function\s*\w*\([^)]*=/],
    ["shorthand properties", shorthand],
    ["optional catch binding", /catch\s*\{/],
    ["classes", /\bclass\s/],
    ["Set or Map", /\b(?:Set|Map)\b/],
    ["modules", /\b(?:require|import|export)\b/],
    ["logs", /\bconsole\b/],
  ] as const) {
    assert.doesNotMatch(source, pattern, what);
  }
});
