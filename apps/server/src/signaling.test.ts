import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  CONNECTION_PATHS,
  ERROR_CODES,
  type LogFields,
  parseServerMessage,
  REFUSE_REASONS,
  type ServerMessage,
  UPGRADE_REJECT_REASONS,
} from "@sigill/protocol";
import { WebSocket as WsClient } from "ws";
import { attachSignaling, HEARTBEAT_MS } from "./signaling.ts";

const logLines: { event: string; fields: LogFields | undefined }[] = [];
const server = createServer((_req, res) => res.writeHead(404).end());
const signaling = attachSignaling(server, {
  log: (event, fields) => logLines.push({ event, fields }),
});
let port = 0;
const clients: Client[] = [];

before(async () => {
  await new Promise<void>((done) => server.listen(0, done));
  port = (server.address() as AddressInfo).port;
});
after(() => {
  for (const client of clients) {
    client.socket.close();
  }
  signaling.close();
  server.close();
});

let counter = 0;
/** A fresh, valid link ID (22 base64url characters). */
function linkId(): string {
  counter += 1;
  return `link${String(counter).padStart(18, "0")}`;
}

/** How long next() waits, so a missing message fails the test instead of hanging it. */
const NEXT_TIMEOUT_MS = 2000;

type Client = {
  socket: WebSocket;
  send(message: unknown): void;
  next(): Promise<ServerMessage>;
  closed: Promise<number>;
};

/** Opens a WebSocket to /signal and queues the messages it receives. */
async function connect(url = `ws://localhost:${port}/signal`): Promise<Client> {
  const socket = new WebSocket(url);
  const queue: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const message = parseServerMessage(String(event.data));
    assert.ok(message, `server sent an invalid message: ${event.data}`);
    const waiter = waiting.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });
  const closed = new Promise<number>((done) =>
    socket.addEventListener("close", (event) => done(event.code)),
  );
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done());
    socket.addEventListener("error", () => fail(new Error("connect failed")));
  });
  const client: Client = {
    socket,
    send: (message) => socket.send(typeof message === "string" ? message : JSON.stringify(message)),
    next: () => {
      const message = queue.shift();
      if (message) {
        return Promise.resolve(message);
      }
      return new Promise((done, fail) => {
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(waiter), 1);
          fail(new Error(`no message within ${NEXT_TIMEOUT_MS} ms`));
        }, NEXT_TIMEOUT_MS);
        const waiter = (m: ServerMessage) => {
          clearTimeout(timer);
          done(m);
        };
        waiting.push(waiter);
      });
    },
    closed,
  };
  clients.push(client);
  return client;
}

/** Connects a host for the given links and waits until the server has registered them. */
async function hostFor(...links: string[]): Promise<Client> {
  const host = await connect();
  host.send({ t: "host", links });
  // Messages on one socket are handled in order, so a round trip proves the host is registered.
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  return host;
}

async function joinAs(link: string, host: Client): Promise<Client> {
  const guest = await connect();
  guest.send({ t: "join", link });
  assert.deepEqual(await host.next(), { t: "joined", link });
  return guest;
}

test("relays messages between host and guest in both directions", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const guest = await joinAs(link, host);
  host.send({ t: "relay", link, data: "b2ZmZXI" });
  assert.deepEqual(await guest.next(), { t: "relay", link, data: "b2ZmZXI" });
  guest.send({ t: "relay", link, data: "YW5zd2Vy" });
  assert.deepEqual(await host.next(), { t: "relay", link, data: "YW5zd2Vy" });
});

test("refuses a join for a link nobody hosts", async () => {
  const guest = await connect();
  guest.send({ t: "join", link: linkId() });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "unknown" });
});

test("refuses a second concurrent guest as busy and frees the link when the first leaves", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const first = await joinAs(link, host);
  const second = await connect();
  second.send({ t: "join", link });
  assert.deepEqual(await second.next(), { t: "refused", reason: "busy" });

  first.socket.close();
  assert.deepEqual(await host.next(), { t: "left", link });
  // A refused guest may try again once the link is free.
  second.send({ t: "join", link });
  assert.deepEqual(await host.next(), { t: "joined", link });
});

test("forwards the sender's refusal to the guest and unbinds it", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const guest = await joinAs(link, host);
  host.send({ t: "refuse", link, reason: "used" });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "used" });
  guest.send({ t: "relay", link, data: "bGF0ZQ" });
  assert.deepEqual(await guest.next(), { t: "error", code: "not-on-link" });
  // The link is free again for the next opener.
  await joinAs(link, host);
});

test("tells the guest when the host goes away and frees its links", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const guest = await joinAs(link, host);
  host.socket.close();
  assert.deepEqual(await guest.next(), { t: "host-gone" });

  const late = await connect();
  late.send({ t: "join", link });
  assert.deepEqual(await late.next(), { t: "refused", reason: "unknown" });
  // Another sender may now host the same link.
  await hostFor(link);
});

test("keeps the guest bound when the host re-sends an unchanged list", async () => {
  const link = linkId();
  const other = linkId();
  const host = await hostFor(link, other);
  const guest = await joinAs(link, host);
  host.send({ t: "host", links: [link, other] });
  host.send({ t: "host", links: [other, link] });
  // Had the guest been told host-gone, that would arrive before this relay.
  host.send({ t: "relay", link, data: "c3RpbGw" });
  assert.deepEqual(await guest.next(), { t: "relay", link, data: "c3RpbGw" });
  guest.send({ t: "relay", link, data: "Ym91bmQ" });
  assert.deepEqual(await host.next(), { t: "relay", link, data: "Ym91bmQ" });
});

test("tells the guest when the host drops its link from the list", async () => {
  const kept = linkId();
  const dropped = linkId();
  const host = await hostFor(kept, dropped);
  const guest = await joinAs(dropped, host);
  host.send({ t: "host", links: [kept] });
  assert.deepEqual(await guest.next(), { t: "host-gone" });
});

test("rejects hosting a link another socket already hosts", async () => {
  const link = linkId();
  await hostFor(link);
  const rival = await connect();
  rival.send({ t: "host", links: [linkId(), link] });
  assert.deepEqual(await rival.next(), { t: "error", code: "already-hosted" });
});

test("rejects messages from a socket that is not on the link or has the wrong role", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const stranger = await connect();
  stranger.send({ t: "relay", link, data: "eA" });
  assert.deepEqual(await stranger.next(), { t: "error", code: "not-on-link" });
  stranger.send({ t: "refuse", link, reason: "used" });
  assert.deepEqual(await stranger.next(), { t: "error", code: "not-on-link" });
  stranger.send({ t: "path", link, path: "relay" });
  assert.deepEqual(await stranger.next(), { t: "error", code: "not-on-link" });
  host.send({ t: "join", link: linkId() });
  assert.deepEqual(await host.next(), { t: "error", code: "wrong-role" });
  const guest = await joinAs(link, host);
  guest.send({ t: "host", links: [linkId()] });
  assert.deepEqual(await guest.next(), { t: "error", code: "wrong-role" });
  guest.send({ t: "join", link: linkId() });
  assert.deepEqual(await guest.next(), { t: "error", code: "already-joined" });
  guest.send({ t: "path", link, path: "direct" });
  assert.deepEqual(await guest.next(), { t: "error", code: "not-on-link" });
});

test("logs the path a host reports with nothing else", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const before = logLines.length;
  host.send({ t: "path", link, path: "relay" });
  // A message that answers proves the path report was handled first.
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  assert.deepEqual(logLines.slice(before, before + 1), [
    { event: "path", fields: { path: "relay" } },
  ]);
});

test("closes the socket with 1008 on an invalid message", async () => {
  for (const raw of ["not json", JSON.stringify({ t: "join", link: "short" })]) {
    const client = await connect();
    client.send(raw);
    assert.deepEqual(await client.next(), { t: "error", code: "bad-message" });
    assert.equal(await client.closed, 1008);
  }
  const binary = await connect();
  binary.socket.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual(await binary.next(), { t: "error", code: "bad-message" });
  assert.equal(await binary.closed, 1008);
});

function upgradeStatus(path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({
      host: "localhost",
      port,
      path,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
        ...headers,
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      done(res.statusCode ?? 0);
    });
    req.on("response", (res) => {
      res.resume();
      done(res.statusCode ?? 0);
    });
    req.on("error", fail);
    req.end();
  });
}

test("accepts upgrades only on /signal from the same origin", async () => {
  assert.equal(await upgradeStatus("/signal"), 101);
  assert.equal(await upgradeStatus("/signal", { origin: `http://localhost:${port}` }), 101);
  assert.equal(await upgradeStatus("/other"), 404);
  assert.equal(await upgradeStatus("/signal", { origin: "https://evil.example" }), 403);
  assert.equal(await upgradeStatus("/signal", { origin: "null" }), 403);
});

test("logs only allowlisted fields and never relay payloads", async () => {
  const marker = "MARKERc2VjcmV0LXBheWxvYWQ";
  const link = linkId();
  const host = await hostFor(link);
  const guest = await joinAs(link, host);
  host.send({ t: "relay", link, data: marker });
  assert.deepEqual(await guest.next(), { t: "relay", link, data: marker });
  guest.send({ t: "relay", link, data: marker });
  assert.deepEqual(await host.next(), { t: "relay", link, data: marker });
  host.send({ t: "path", link, path: "stun" });
  host.send({ t: "refuse", link, reason: "busy" });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "busy" });
  const bad = await connect();
  bad.send(`{"t":"relay","data":"${marker}"}`);
  await bad.closed;

  const allowed = new Set(["link", "links", "bytes", "reason", "code", "port", "path"]);
  const logReasons: readonly unknown[] = [...REFUSE_REASONS, ...UPGRADE_REJECT_REASONS];
  const errorCodes: readonly unknown[] = ERROR_CODES;
  const connectionPaths: readonly unknown[] = CONNECTION_PATHS;
  assert.ok(logLines.some((line) => line.event === "relay"));
  assert.ok(logLines.some((line) => line.event === "path"));
  for (const line of logLines) {
    const text = JSON.stringify(line);
    assert.ok(!text.includes(marker), `payload leaked into the log: ${text}`);
    assert.ok(!text.includes(link), `full link ID leaked into the log: ${text}`);
    for (const [key, value] of Object.entries(line.fields ?? {})) {
      assert.ok(allowed.has(key), `field ${key} is not allowlisted`);
      if (key === "link") {
        assert.match(String(value), /^[A-Za-z0-9_-]{6}$/);
      }
      if (key === "reason") {
        assert.ok(logReasons.includes(value), `unknown reason ${value}`);
      }
      if (key === "code") {
        assert.ok(errorCodes.includes(value), `unknown code ${value}`);
      }
      if (key === "path") {
        assert.ok(connectionPaths.includes(value), `unknown path ${value}`);
      }
    }
  }
});

test("heartbeat lets the panel promise a dropped connection is noticed within a minute", () => {
  assert.ok(
    2 * HEARTBEAT_MS <= 60_000,
    "server-facts.ts promises a dropped connection is noticed within a minute",
  );
});

test("terminates a guest that never answers pings and tells the host it left", async (t) => {
  const quickServer = createServer();
  const quickSignaling = attachSignaling(quickServer, { log: () => {}, heartbeatMs: 20 });
  t.after(() => {
    quickSignaling.close();
    quickServer.close();
  });
  await new Promise<void>((done) => quickServer.listen(0, done));
  const url = `ws://localhost:${(quickServer.address() as AddressInfo).port}/signal`;

  const link = linkId();
  const host = await connect(url);
  host.send({ t: "host", links: [link] });
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });

  const guest = new WsClient(url, { autoPong: false });
  guest.on("open", () => guest.send(JSON.stringify({ t: "join", link })));
  assert.deepEqual(await host.next(), { t: "joined", link });
  const joinedAt = performance.now();
  assert.deepEqual(await host.next(), { t: "left", link });
  assert.ok(performance.now() - joinedAt < 200, "the silent guest outlived two heartbeats");
});
