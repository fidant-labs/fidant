// cloudfront-js-2.0 has no ??, ?., spread, destructuring, default parameters, for...of, Set or Map.

const SITE = "fidant.se";
// CloudFront's undocumented regex limits stopped this file at 512 characters, so it uses none; at 256 its costliest measured path took 52 % of the budget.
const MAX_URI = 128;
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const HEX = `${DIGITS}abcdefABCDEF`;
const WORD = `${LOWER}${LOWER.toUpperCase()}${DIGITS}_`;
const MOVED = { "/technical": "/how" };
const PAGES = [
  "/",
  "/send",
  "/secret",
  "/how",
  "/how/file",
  "/how/encryption",
  "/how/link",
  "/how/connect",
  "/how/direct",
  "/how/relay",
  "/how/transfer",
  "/how/verification",
  "/how/masking",
  "/how/traces",
  "/how/protection",
  "/how/tech",
  "/about",
  "/privacy",
  "/security",
  "/terms",
  "/sv",
  "/sv/skicka",
  "/sv/hemlighet",
  "/sv/sa-fungerar-det",
  "/sv/sa-fungerar-det/filen",
  "/sv/sa-fungerar-det/kryptering",
  "/sv/sa-fungerar-det/lanken",
  "/sv/sa-fungerar-det/anslutning",
  "/sv/sa-fungerar-det/direkt",
  "/sv/sa-fungerar-det/relaet",
  "/sv/sa-fungerar-det/overforing",
  "/sv/sa-fungerar-det/kontroll",
  "/sv/sa-fungerar-det/maskering",
  "/sv/sa-fungerar-det/lamnas-kvar",
  "/sv/sa-fungerar-det/skydd",
  "/sv/sa-fungerar-det/ordlista",
  "/sv/om",
  "/sv/integritet",
  "/sv/sakerhet",
  "/sv/villkor",
];
const RELAY_SECRET = "/relay-secret/";
const KINDS = ["receive", "page"];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};
const HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self' wss://sto.signal.fidant.se",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function only(text, allowed) {
  for (let i = 0; i < text.length; i++) {
    if (allowed.indexOf(text.charAt(i)) < 0) {
      return false;
    }
  }
  return true;
}

function slashes(text) {
  return text.split("\\").join("/");
}

// serveStatic reads the path through the URL parser, which resolves dot segments before decoding.
function urlPath(uri) {
  const parts = slashes(uri).split("/").slice(1);
  const out = [];
  parts.forEach((part, i) => {
    const dots = part.toLowerCase().split("%2e").join(".");
    if (dots === "." || dots === "..") {
      if (dots === "..") {
        out.pop();
      }
      if (i === parts.length - 1) {
        out.push("");
      }
    } else {
      out.push(part);
    }
  });
  return `/${out.join("/")}`;
}

// serveStatic picks the rule by the decoded path, and the file by that path's path.resolve.
function decide(uri) {
  let pathname;
  try {
    pathname = decodeURIComponent(urlPath(uri));
  } catch (_) {
    return { kind: "400" };
  }
  const file = [];
  const segments = pathname.split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === "..") {
      if (file.length === 0) {
        return { kind: "outside" };
      }
      file.pop();
    } else if (segment !== "" && segment !== ".") {
      file.push(segment);
    }
  }
  if (pathname.startsWith("/r/")) {
    return { kind: "receive" };
  }
  const name = file.length > 0 ? file[file.length - 1] : "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  if (ext !== "" && ext.toLowerCase() !== ".html") {
    return { kind: "file", uri: `/${file.map(encodeURIComponent).join("/")}`, ext: ext };
  }
  // Every page and moved path is lowercase words joined by hyphens, so the list gives serveStatic's rule but for //.
  const bare = pathname.length > 1 && pathname.slice(-1) === "/" ? pathname.slice(0, -1) : pathname;
  const target = MOVED[bare] || bare;
  if (PAGES.includes(target) && (bare !== "/" || pathname === "/")) {
    if (target !== pathname) {
      return { kind: "moved", location: target };
    }
    return {
      kind: "page",
      uri: target === "/" ? "/pages/index.html" : `/pages${target}/index.html`,
    };
  }
  return {
    kind: "404",
    uri:
      pathname === "/sv" || pathname.startsWith("/sv/") ? "/pages/sv/404.html" : "/pages/404.html",
  };
}

function query(request, keepEmpty) {
  const raw = request.rawQueryString();
  return raw || (keepEmpty && raw === "") ? `?${raw}` : "";
}

function withHeaders(headers) {
  Object.keys(HEADERS).forEach((name) => {
    headers[name] = { value: HEADERS[name] };
  });
  return headers;
}

function generated(statusCode, location) {
  const headers = withHeaders({});
  if (location) {
    headers.location = { value: location };
  }
  return { statusCode: statusCode, headers: headers };
}

// CloudFront picks the behaviour from a normalised path and AWS gives no order for its steps.
function underRelaySecret(uri) {
  const parts = uri.split("%");
  let plain = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const hex = parts[i].slice(0, 2);
    plain +=
      hex.length === 2 && only(hex, HEX)
        ? String.fromCharCode(parseInt(hex, 16)) + parts[i].slice(2)
        : `%${parts[i]}`;
  }
  return slashes(plain).includes(RELAY_SECRET);
}

function relayId(uri) {
  const id = uri.slice(RELAY_SECRET.length);
  return (
    uri.startsWith(RELAY_SECRET) &&
    id.length >= 2 &&
    id.length <= 16 &&
    only(id.charAt(0), LOWER) &&
    only(id, LOWER + DIGITS)
  );
}

function viewerRequest(request) {
  if (request.uri.length > MAX_URI) {
    return generated(414);
  }
  const host = request.headers.host ? request.headers.host.value.toLowerCase() : "";
  if (host !== SITE) {
    return generated(301, `https://${SITE}${request.uri}${query(request, true)}`);
  }
  if (underRelaySecret(request.uri)) {
    return relayId(request.uri) ? request : generated(404);
  }
  const decision = decide(request.uri);
  if (decision.kind === "400") {
    return generated(400);
  }
  if (decision.kind === "outside") {
    return generated(404);
  }
  if (decision.kind === "moved") {
    return generated(301, decision.location + query(request, false));
  }
  if (decision.kind === "receive") {
    const lang = request.headers["accept-language"];
    const next = lang ? lang.value.charAt(2) : "";
    const sv =
      lang !== undefined &&
      lang.value.slice(0, 2).toLowerCase() === "sv" &&
      (next === "" || WORD.indexOf(next) < 0);
    decision.uri = sv ? "/index.receive.sv.html" : "/index.receive.en.html";
  }
  request.headers["x-fidant-page"] = { value: decision.kind };
  request.uri = decision.uri;
  return request;
}

// AWS doesn't say whether this event carries the viewer's request or the rewritten one.
function viewerResponse(request, response) {
  if (request.uri.length > MAX_URI) {
    return response;
  }
  const decision = decide(request.uri);
  const sent = request.headers["x-fidant-page"];
  const kind =
    decision.kind === "404" && sent && KINDS.includes(sent.value) ? sent.value : decision.kind;
  if (kind === "404" && response.statusCode === 200) {
    response.statusCode = 404;
    response.statusDescription = "Not Found";
  }
  const headers = withHeaders(response.headers);
  const type = kind === "file" ? TYPES[decision.ext] : TYPES[".html"];
  headers["content-type"] = { value: type || "application/octet-stream" };
  if (kind === "receive") {
    const vary = headers.vary ? `${headers.vary.value}, accept-language` : "accept-language";
    headers.vary = { value: vary };
    headers["x-robots-tag"] = { value: "noindex" };
  }
  return response;
}

// biome-ignore lint/correctness/noUnusedVariables: CloudFront calls handler
function handler(event) {
  if (event.context.eventType === "viewer-response") {
    return viewerResponse(event.request, event.response);
  }
  return viewerRequest(event.request);
}
