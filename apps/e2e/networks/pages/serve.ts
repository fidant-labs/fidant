import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { createServer, request } from "node:https";
import { edgeAnswer, viewerRequest } from "../../src/edge.ts";

const root = "/pages";
const alb = "198.51.100.50";

function cut(res: ServerResponse) {
  if (res.headersSent) {
    res.destroy();
  } else {
    res.writeHead(502).end();
  }
}

createServer(
  { cert: readFileSync("/etc/pages/tls.crt"), key: readFileSync("/etc/pages/tls.key") },
  (req, res) => {
    const target = req.url ?? "/";
    const method = req.method ?? "GET";
    const host = req.headers.host ?? "";
    const passed = viewerRequest({ method, host, target });
    if (
      (method === "GET" || method === "HEAD") &&
      !("statusCode" in passed) &&
      passed.uri.startsWith("/relay-secret/")
    ) {
      request(
        { host: alb, port: 443, path: passed.uri, method, rejectUnauthorized: false },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.on("error", () => cut(res));
          upstream.pipe(res);
        },
      )
        .on("error", () => cut(res))
        .end();
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([name, value]) =>
        typeof value === "string" ? [[name, value]] : [],
      ),
    );
    edgeAnswer(root, { method, host, target, headers }).then(
      (answer) => res.writeHead(answer.status, answer.headers).end(answer.body),
      () => res.writeHead(500).end(),
    );
  },
).listen(443);
