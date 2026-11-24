import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { type AddressInfo, connect as tcpConnect } from "node:net";
import { after, before, test } from "node:test";
import {
  CONNECTION_PATHS,
  ERROR_CODES,
  type LogFields,
  MAX_RELAY_DATA,
  parseServerMessage,
  REFUSE_REASONS,
  type ServerMessage,
  UPGRADE_REJECT_REASONS,
} from "@sigill/protocol";
import { WebSocket as WsClient } from "ws";
import { attachSignaling, clientAddress, HEARTBEAT_MS } from "./signaling.ts";

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

/** Opens a WebSocket to /signal, checks its hello and queues the messages after it. */
async function connect(url = `ws://localhost:${port}/signal`, mail = false): Promise<Client> {
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
  assert.deepEqual(await client.next(), { t: "hello", mail });
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

/** Joins a fresh guest to a link with a fresh attempt ID and waits until both ends hear of it. */
async function joinAs(link: string, host: Client): Promise<Client & { attempt: string }> {
  const guest = await connect();
  const attempt = randomBytes(16).toString("base64url");
  guest.send({ t: "join", link, attempt });
  assert.deepEqual(await guest.next(), { t: "joined", link, attempt, iceServers: [] });
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [] });
  return Object.assign(guest, { attempt });
}

test("says hello first with whether the server can email links", async (t) => {
  const mailing = createServer();
  const mailingSignaling = attachSignaling(mailing, { log: () => {}, mail: async () => {} });
  t.after(() => {
    mailingSignaling.close();
    mailing.close();
  });
  await new Promise<void>((done) => mailing.listen(0, done));
  await connect(`ws://localhost:${(mailing.address() as AddressInfo).port}/signal`, true);
  await connect();
});

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
  guest.send({ t: "join", link: linkId(), attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "unknown" });
});

test("refuses a second concurrent guest as busy and frees the link when the first leaves", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const first = await joinAs(link, host);
  const second = await connect();
  second.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await second.next(), { t: "refused", reason: "busy" });

  first.socket.close();
  assert.deepEqual(await host.next(), { t: "left", link });
  // A refused guest may try again once the link is free.
  const attempt = linkId();
  second.send({ t: "join", link, attempt });
  assert.deepEqual(await second.next(), { t: "joined", link, attempt, iceServers: [] });
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [] });
});

test("forwards the sender's refusal to the guest and unbinds it", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const guest = await joinAs(link, host);
  host.send({ t: "refuse", link, attempt: guest.attempt, reason: "used" });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "used" });
  guest.send({ t: "relay", link, data: "bGF0ZQ" });
  assert.deepEqual(await guest.next(), { t: "error", code: "not-on-link" });
  // The link is free again for the next opener.
  await joinAs(link, host);
});

test("ignores a refusal of an earlier attempt once another guest is bound", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const first = await joinAs(link, host);
  first.socket.close();
  assert.deepEqual(await host.next(), { t: "left", link });
  const second = await joinAs(link, host);
  const before = logLines.length;
  host.send({ t: "refuse", link, attempt: first.attempt, reason: "used" });
  // Had the refusal reached the second guest, it would arrive before this relay.
  host.send({ t: "relay", link, data: "c3RpbGw" });
  assert.deepEqual(await second.next(), { t: "relay", link, data: "c3RpbGw" });
  second.send({ t: "relay", link, data: "Ym91bmQ" });
  assert.deepEqual(await host.next(), { t: "relay", link, data: "Ym91bmQ" });
  assert.ok(!logLines.slice(before).some((line) => line.event === "refused"));
});

test("ignores a refusal when no guest is bound", async () => {
  const link = linkId();
  const host = await hostFor(link);
  host.send({ t: "refuse", link, attempt: linkId(), reason: "busy" });
  // The refusal gets no reply, so the next message's answer is the first one.
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  // The link is still open to the next opener.
  await joinAs(link, host);
});

test("tells the guest when the host goes away and frees its links", async () => {
  const link = linkId();
  const host = await hostFor(link);
  const guest = await joinAs(link, host);
  host.socket.close();
  assert.deepEqual(await guest.next(), { t: "host-gone" });

  const late = await connect();
  late.send({ t: "join", link, attempt: linkId() });
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
  stranger.send({ t: "refuse", link, attempt: linkId(), reason: "used" });
  assert.deepEqual(await stranger.next(), { t: "error", code: "not-on-link" });
  stranger.send({ t: "path", link, path: "relay" });
  assert.deepEqual(await stranger.next(), { t: "error", code: "not-on-link" });
  host.send({ t: "join", link: linkId(), attempt: linkId() });
  assert.deepEqual(await host.next(), { t: "error", code: "wrong-role" });
  const guest = await joinAs(link, host);
  guest.send({ t: "host", links: [linkId()] });
  assert.deepEqual(await guest.next(), { t: "error", code: "wrong-role" });
  guest.send({ t: "join", link: linkId(), attempt: linkId() });
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

function upgradeStatus(
  path: string,
  headers: Record<string, string> = {},
  to: { host: string; port: number } = { host: "localhost", port },
): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({
      ...to,
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
  host.send({ t: "refuse", link, attempt: guest.attempt, reason: "busy" });
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
    assert.ok(!text.includes(guest.attempt.slice(0, 6)), `attempt ID leaked into the log: ${text}`);
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
  const attempt = linkId();
  guest.on("open", () => guest.send(JSON.stringify({ t: "join", link, attempt })));
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [] });
  const joinedAt = performance.now();
  assert.deepEqual(await host.next(), { t: "left", link });
  assert.ok(performance.now() - joinedAt < 200, "the silent guest outlived two heartbeats");
});

test("keys clients by address, trusting X-Forwarded-For only from loopback", () => {
  assert.equal(clientAddress("203.0.113.7", undefined), "203.0.113.7");
  assert.equal(clientAddress("::ffff:203.0.113.7", undefined), "203.0.113.7");
  assert.equal(clientAddress("203.0.113.7", "198.51.100.1"), "203.0.113.7");
  assert.equal(clientAddress("127.0.0.1", undefined), "127.0.0.1");
  assert.equal(clientAddress("127.0.0.1", "198.51.100.1"), "198.51.100.1");
  assert.equal(clientAddress("::1", "198.51.100.1"), "198.51.100.1");
  assert.equal(clientAddress("::ffff:127.0.0.1", "198.51.100.1"), "198.51.100.1");
  assert.equal(clientAddress("127.0.0.1", "10.0.0.1, 198.51.100.1"), "198.51.100.1");
  assert.equal(clientAddress("127.0.0.1", ["10.0.0.1", "198.51.100.1"]), "198.51.100.1");
  assert.equal(clientAddress("127.0.0.1", "::ffff:198.51.100.1"), "198.51.100.1");
  assert.equal(clientAddress("127.0.0.1", "not-an-ip"), "127.0.0.1");
  assert.equal(clientAddress("2001:db8:1:2:3:4:5:6", undefined), "2001:db8:1:2::/64");
  assert.equal(clientAddress("2001:DB8:1:2::9", undefined), "2001:db8:1:2::/64");
  assert.equal(clientAddress("2001:db8::1", undefined), "2001:db8:0:0::/64");
  assert.equal(clientAddress("fe80::1%en0", undefined), "fe80:0:0:0::/64");
  assert.equal(clientAddress("::1", undefined), "0:0:0:0::/64");
  assert.equal(clientAddress("127.0.0.1", "2001:db8:1:2::9"), "2001:db8:1:2::/64");
});

/**
 * Starts a second signaling server with lowered limits on 127.0.0.1, so every client in the test
 * counts against the same address.
 */
async function limitedServer(
  t: { after(fn: () => void): void },
  limits: { sockets?: number; socketsPerAddress?: number },
): Promise<{ host: string; port: number; server: Server }> {
  const limited = createServer();
  const limitedSignaling = attachSignaling(limited, { log: () => {}, limits });
  t.after(() => {
    limitedSignaling.close();
    limited.close();
  });
  await new Promise<void>((done) => limited.listen(0, "127.0.0.1", done));
  return { host: "127.0.0.1", port: (limited.address() as AddressInfo).port, server: limited };
}

/** Retries an upgrade until the server has noticed a close and freed the slot. */
async function upgradeAfterClose(
  to: { host: string; port: number },
  headers: Record<string, string> = {},
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await upgradeStatus("/signal", headers, to);
    if (status === 101) {
      return status;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  return 0;
}

test("rejects upgrades with 503 once the server holds its total of sockets", async (t) => {
  const limited = await limitedServer(t, { sockets: 2 });
  const url = `ws://127.0.0.1:${limited.port}/signal`;
  const first = await connect(url);
  await connect(url);
  const other = { "x-forwarded-for": "198.51.100.1" };
  assert.equal(await upgradeStatus("/signal", other, limited), 503);
  first.socket.close();
  await first.closed;
  assert.equal(await upgradeAfterClose(limited, other), 101);
});

test("rejects upgrades with 429 once one address holds its share of sockets", async (t) => {
  const limited = await limitedServer(t, { socketsPerAddress: 2 });
  const url = `ws://127.0.0.1:${limited.port}/signal`;
  const first = await connect(url);
  await connect(url);
  assert.equal(await upgradeStatus("/signal", {}, limited), 429);
  const proxied = { "x-forwarded-for": "198.51.100.1" };
  assert.equal(await upgradeStatus("/signal", proxied, limited), 101);
  first.socket.close();
  await first.closed;
  assert.equal(await upgradeAfterClose(limited), 101);
});

/** A signaling server with a low message limit and a short window, and the events it logs. */
async function rateLimitedServer(t: { after(fn: () => void): void }) {
  const events: string[] = [];
  const limited = createServer();
  const limitedSignaling = attachSignaling(limited, {
    log: (event) => events.push(event),
    heartbeatMs: 20,
    limits: { messagesPerWindow: 5 },
  });
  t.after(() => {
    limitedSignaling.close();
    limited.close();
  });
  await new Promise<void>((done) => limited.listen(0, done));
  return { events, url: `ws://localhost:${(limited.address() as AddressInfo).port}/signal` };
}

test("closes a socket with 1008 once it sends too many messages and logs it once", async (t) => {
  const { events, url } = await rateLimitedServer(t);
  const client = await connect(url);
  for (let i = 0; i < 50; i += 1) {
    client.send({ t: "relay", link: linkId(), data: "flood" });
  }
  assert.equal(await client.closed, 1008);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(events.filter((event) => event === "rate-limited").length, 1);
});

test("keeps a socket under the message limit open across window resets", async (t) => {
  const { events, url } = await rateLimitedServer(t);
  const client = await connect(url);
  for (let round = 0; round < 3; round += 1) {
    for (let i = 0; i < 4; i += 1) {
      client.send({ t: "relay", link: linkId(), data: "sync" });
    }
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(await client.next(), { t: "error", code: "not-on-link" });
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.equal(client.socket.readyState, WebSocket.OPEN);
  assert.ok(!events.includes("rate-limited"));
});

/**
 * Hosts a link on a server with a low buffer limit, joins a ws guest, and returns a function that
 * relays large messages to the guest until `relay-dropped` is logged or `rounds` run out.
 */
async function bufferedRelay(t: { after(fn: () => void): void }) {
  const events: string[] = [];
  const limited = createServer();
  const limitedSignaling = attachSignaling(limited, {
    log: (event) => events.push(event),
    limits: { bufferedBytes: 64 * 1024, messagesPerWindow: 100_000 },
  });
  t.after(() => {
    limitedSignaling.close();
    limited.close();
  });
  await new Promise<void>((done) => limited.listen(0, done));
  const url = `ws://localhost:${(limited.address() as AddressInfo).port}/signal`;
  const link = linkId();
  const host = await connect(url);
  host.send({ t: "host", links: [link] });
  const guest = new WsClient(url);
  t.after(() => guest.terminate());
  let received = 0;
  guest.on("message", () => {
    received += 1;
  });
  const attempt = linkId();
  guest.on("open", () => guest.send(JSON.stringify({ t: "join", link, attempt })));
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [] });
  const data = "A".repeat(MAX_RELAY_DATA);
  return {
    events,
    host,
    guest,
    received: () => received,
    async flood(rounds: number) {
      for (let round = 0; round < rounds && !events.includes("relay-dropped"); round += 1) {
        for (let i = 0; i < 20; i += 1) {
          host.send({ t: "relay", link, data });
        }
        await new Promise((done) => setTimeout(done, 5));
      }
    },
  };
}

test("drops relays to a socket that stops reading and keeps the sender open", async (t) => {
  const relay = await bufferedRelay(t);
  relay.guest.pause();
  await relay.flood(500);
  assert.ok(relay.events.includes("relay-dropped"), "nothing was dropped");
  assert.equal(relay.host.socket.readyState, WebSocket.OPEN);
});

test("drops nothing to a socket that keeps reading", async (t) => {
  const relay = await bufferedRelay(t);
  await relay.flood(10);
  // The guest's hello and joined ack, then 200 relays.
  for (let wait = 0; wait < 200 && relay.received() < 202; wait += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(relay.received(), 202);
  assert.ok(!relay.events.includes("relay-dropped"));
});

const rawUpgrade = (path: string) =>
  `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
  `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`;

test("survives clients that reset during a rejected upgrade", async (t) => {
  const limited = await limitedServer(t, { socketsPerAddress: 1 });
  const crashes: Error[] = [];
  const onCrash = (error: Error) => crashes.push(error);
  process.on("uncaughtException", onCrash);
  t.after(() => process.off("uncaughtException", onCrash));
  await connect(`ws://127.0.0.1:${limited.port}/signal`);
  for (let i = 0; i < 10; i += 1) {
    for (const path of ["/nope", "/signal"]) {
      const socket = tcpConnect(limited);
      socket.on("error", () => {});
      socket.write(rawUpgrade(path));
      socket.resetAndDestroy();
    }
  }
  await new Promise((done) => setTimeout(done, 100));
  assert.deepEqual(crashes, []);
  assert.equal(await upgradeStatus("/signal", { "x-forwarded-for": "198.51.100.1" }, limited), 101);
});

test("closes the server side of a rejected upgrade the client never ends", async (t) => {
  const limited = await limitedServer(t, { socketsPerAddress: 1 });
  await connect(`ws://127.0.0.1:${limited.port}/signal`);
  const connections = () =>
    new Promise<number>((done, fail) =>
      limited.server.getConnections((error, count) => (error ? fail(error) : done(count))),
    );
  for (const path of ["/nope", "/signal"]) {
    // A client that gets its answer but never sends its own FIN.
    const socket = tcpConnect({ host: limited.host, port: limited.port, allowHalfOpen: true });
    socket.on("error", () => {});
    const answered = new Promise((done) => socket.once("data", done));
    socket.resume();
    socket.write(rawUpgrade(path));
    try {
      await answered;
      // Only the open WebSocket may remain once the server has dropped its side.
      const deadline = Date.now() + 1000;
      while ((await connections()) > 1) {
        assert.ok(Date.now() < deadline, `${path} stayed open on the server`);
        await new Promise((done) => setTimeout(done, 10));
      }
    } finally {
      socket.destroy();
    }
  }
});
