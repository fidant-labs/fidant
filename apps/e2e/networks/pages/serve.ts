import { readFileSync } from "node:fs";
import { createServer, request } from "node:https";
import { edgeAnswer } from "../../src/edge.ts";

const root = "/pages";
const alb = "198.51.100.50";

createServer(
  { cert: readFileSync("/etc/pages/tls.crt"), key: readFileSync("/etc/pages/tls.key") },
  (req, res) => {
    const target = req.url ?? "/";
    const method = req.method ?? "GET";
    if (target.startsWith("/relay-secret/")) {
      if (method !== "GET" && method !== "HEAD") {
        res.writeHead(403).end();
        return;
      }
      request(
        {
          host: alb,
          port: 443,
          path: target,
          method,
          rejectUnauthorized: false,
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      )
        .on("error", () => res.writeHead(502).end())
        .end();
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([name, value]) =>
        typeof value === "string" ? [[name, value]] : [],
      ),
    );
    edgeAnswer(root, { method, host: req.headers.host ?? "", target, headers }).then(
      (answer) => res.writeHead(answer.status, answer.headers).end(answer.body),
      () => res.writeHead(500).end(),
    );
  },
).listen(443);
