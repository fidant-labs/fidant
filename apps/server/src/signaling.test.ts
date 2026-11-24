import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { type AddressInfo, connect as tcpConnect } from "node:net";
import { after, before, test } from "node:test";
import {
  CODE_RESULTS,
  CONNECTION_PATHS,
  EMAILED_LINK_MARKER,
  ERROR_CODES,
  type LogFields,
  MAX_RELAY_DATA,
  parseServerMessage,
  REFUSE_REASONS,
  type ServerMessage,
  UPGRADE_REJECT_REASONS,
} from "@sigill/protocol";
import { WebSocket as WsClient } from "ws";
import type { Mail, Mailer } from "./mail.ts";
import { attachSignaling, clientAddress, HEARTBEAT_MS } from "./signaling.ts";

const logLines: { event: string; fields: LogFields | undefined }[] = [];
const RELAY = { urls: ["turn:relay.example:3478"], username: "1700000000", credential: "hmac" };
const server = createServer((_req, res) => res.writeHead(404).end());
const signaling = attachSignaling(server, {
  log: (event, fields) => logLines.push({ event, fields }),
  iceServers: (turn) => (turn ? [RELAY] : []),
  // Every test's sockets stay open until after(), and all come from one address.
  limits: { socketsPerAddress: 1000 },
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
  host.send({ t: "host", links, turn: true });
  // Messages on one socket are handled in order, so a round trip proves the host is registered.
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  return host;
}

/**
 * Joins a fresh guest to a link with a fresh attempt ID and waits until both ends hear of it,
 * with `turn` as the host's relay choice.
 */
async function joinAs(
  link: string,
  host: Client,
  turn = true,
): Promise<Client & { attempt: string }> {
  const guest = await connect();
  const attempt = randomBytes(16).toString("base64url");
  guest.send({ t: "join", link, attempt });
  const joined = { t: "joined", link, attempt, iceServers: turn ? [RELAY] : [], turn };
  assert.deepEqual(await guest.next(), joined);
  assert.deepEqual(await host.next(), joined);
  return Object.assign(guest, { attempt });
}

test("says hello first with whether the server can email links", async (t) => {
  await connect((await mailServer(t)).url, true);
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
  const joined = { t: "joined", link, attempt, iceServers: [RELAY], turn: true };
  assert.deepEqual(await second.next(), joined);
  assert.deepEqual(await host.next(), joined);
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
  host.send({ t: "host", links: [link, other], turn: true });
  host.send({ t: "host", links: [other, link], turn: true });
  // Had the guest been told host-gone, that would arrive before this relay.
  host.send({ t: "relay", link, data: "c3RpbGw" });
  assert.deepEqual(await guest.next(), { t: "relay", link, data: "c3RpbGw" });
  guest.send({ t: "relay", link, data: "Ym91bmQ" });
  assert.deepEqual(await host.next(), { t: "relay", link, data: "Ym91bmQ" });
});

test("echoes the host's relay choice at each join and keeps the guest bound when it changes", async () => {
  const bound = linkId();
  const fresh = linkId();
  const host = await hostFor(bound, fresh);
  const guest = await joinAs(bound, host);
  host.send({ t: "host", links: [bound, fresh], turn: false });
  // Had the guest been told host-gone, that would arrive before this relay.
  host.send({ t: "relay", link: bound, data: "c3RpbGw" });
  assert.deepEqual(await guest.next(), { t: "relay", link: bound, data: "c3RpbGw" });
  await joinAs(fresh, host, false);
  guest.send({ t: "relay", link: bound, data: "Ym91bmQ" });
  assert.deepEqual(await host.next(), { t: "relay", link: bound, data: "Ym91bmQ" });
});

test("leaves TURN out of joined when the host refuses it", async () => {
  const link = linkId();
  const host = await connect();
  host.send({ t: "host", links: [link], turn: false });
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  await joinAs(link, host, false);
});

test("tells the guest when the host drops its link from the list", async () => {
  const kept = linkId();
  const dropped = linkId();
  const host = await hostFor(kept, dropped);
  const guest = await joinAs(dropped, host);
  host.send({ t: "host", links: [kept], turn: true });
  assert.deepEqual(await guest.next(), { t: "host-gone" });
});

test("rejects hosting a link another socket already hosts", async () => {
  const link = linkId();
  await hostFor(link);
  const rival = await connect();
  rival.send({ t: "host", links: [linkId(), link], turn: true });
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
  guest.send({ t: "host", links: [linkId()], turn: true });
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
  const logReasons: readonly unknown[] = [
    ...REFUSE_REASONS,
    ...UPGRADE_REJECT_REASONS,
    ...CODE_RESULTS,
    "unverified",
  ];
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
  host.send({ t: "host", links: [link], turn: true });
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });

  const guest = new WsClient(url, { autoPong: false });
  const attempt = linkId();
  guest.on("open", () => guest.send(JSON.stringify({ t: "join", link, attempt })));
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [], turn: true });
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
  host.send({ t: "host", links: [link], turn: true });
  const guest = new WsClient(url);
  t.after(() => guest.terminate());
  let received = 0;
  guest.on("message", () => {
    received += 1;
  });
  const attempt = linkId();
  guest.on("open", () => guest.send(JSON.stringify({ t: "join", link, attempt })));
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [], turn: true });
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

const ORIGIN = "https://fidant.se";
const SECRET = randomBytes(32).toString("base64url");
const HOUR_MS = 60 * 60 * 1000;
const CODE_GAP_MS = 30 * 1000;
const CODE_MS = 10 * 60 * 1000;
const EMAILED_LINK_MS = 24 * HOUR_MS;

/** A signaling server on 127.0.0.1 that records each mail before `send` and keeps its log lines. */
async function mailServer(
  t: { after(fn: () => void): void },
  send: Mailer = async () => {},
  options: {
    heartbeatMs?: number;
    limits?: { noticesPerSocket?: number; noticesPerClient?: number; noticesPerRecipient?: number };
  } = {},
) {
  const mails: Mail[] = [];
  const lines: string[] = [];
  const mailing = createServer();
  const mailingSignaling = attachSignaling(mailing, {
    log: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
    mail: {
      origin: ORIGIN,
      send: (mail) => {
        mails.push(mail);
        return send(mail);
      },
    },
    ...options,
  });
  t.after(() => {
    mailingSignaling.close();
    mailing.close();
  });
  await new Promise<void>((done) => mailing.listen(0, "127.0.0.1", done));
  const url = `ws://127.0.0.1:${(mailing.address() as AddressInfo).port}/signal`;
  return { url, mails, lines, server: mailing };
}

/** Connects a host for the given links on a mail server. */
async function mailHost(url: string, ...links: string[]): Promise<Client> {
  const host = await connect(url, true);
  host.send({ t: "host", links, turn: true });
  return host;
}

type EmailFields = { to?: string; secret?: string; from?: string; lang?: string };

function emailMessage(link: string, fields: EmailFields = {}) {
  return {
    t: "email",
    link,
    to: "anna@example.se",
    secret: SECRET,
    from: "Bertil",
    lang: "sv",
    ...fields,
  };
}

/** Emails a hosted link's notice and checks it went out. */
async function emailLink(host: Client, link: string, fields: EmailFields = {}): Promise<void> {
  host.send(emailMessage(link, fields));
  assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
}

/** Asks where a link's code goes and returns the answer's masked address, or "". */
async function gateOf(guest: Client, link: string): Promise<string> {
  guest.send({ t: "gate", link });
  const answer = await guest.next();
  assert.ok(answer.t === "gate" && answer.link === link, `not a gate answer: ${answer.t}`);
  return answer.to;
}

/** Joins a guest to a link on a mail server, with a token if given, and returns its attempt ID. */
async function mailJoin(guest: Client, host: Client, link: string, token?: string) {
  const attempt = randomBytes(16).toString("base64url");
  guest.send({ t: "join", link, attempt, token });
  const joined = { t: "joined", link, attempt, iceServers: [], turn: true };
  assert.deepEqual(await guest.next(), joined);
  assert.deepEqual(await host.next(), joined);
  return attempt;
}

/** Checks the host was sent nothing more: its next message answers this round trip. */
async function heardNothing(host: Client): Promise<void> {
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
}

/** Asks for a code, checks the host hears `verifying`, and returns the code that was mailed. */
async function codeFor(guest: Client, host: Client, link: string, mails: Mail[]) {
  guest.send({ t: "send-code", link });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "sent" });
  assert.deepEqual(await host.next(), { t: "email", link, status: "verifying" });
  const mail = mails.at(-1);
  assert.ok(mail && "code" in mail, "no code was mailed");
  assert.match(mail.code, /^[0-9]{6}$/);
  return mail.code;
}

/** Enters a fresh right code, checks the host hears `verified`, and returns the token. */
async function tokenFor(guest: Client, host: Client, link: string, mails: Mail[]) {
  guest.send({ t: "code", link, code: await codeFor(guest, host, link, mails) });
  const answer = await guest.next();
  assert.ok(answer.t === "token" && answer.link === link, `not a token: ${answer.t}`);
  assert.match(answer.token, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(await host.next(), { t: "email", link, status: "verified" });
  return answer.token;
}

const wrongCode = (code: string) => (code === "000000" ? "111111" : "000000");

test("answers failed to an email when the server cannot send mail", async () => {
  const link = linkId();
  const host = await hostFor(link);
  host.send(emailMessage(link));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  host.send({ t: "host", links: [], turn: true });
  await heardNothing(host);
  await hostFor(link);
});

test("emails a hosted link's notice once and tells the host it was sent", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  host.send(emailMessage(link, { from: "" }));
  assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
  assert.deepEqual(mails, [
    {
      to: "anna@example.se",
      lang: "sv",
      from: "",
      url: `${ORIGIN}/r/${link}#${EMAILED_LINK_MARKER}${SECRET}`,
    },
  ]);
});

test("builds the emailed link from the configured origin, never the request's Host", async (t) => {
  const { url, mails, server: mailing } = await mailServer(t);
  const hostHeaders: (string | undefined)[] = [];
  mailing.prependListener("upgrade", (req) => hostHeaders.push(req.headers.host));
  const socket = new WsClient(url, { headers: { host: "evil.example" } });
  t.after(() => socket.terminate());
  const received: unknown[] = [];
  socket.on("message", (data) => received.push(JSON.parse(String(data))));
  await new Promise((done) => socket.once("open", done));
  const link = linkId();
  socket.send(JSON.stringify({ t: "host", links: [link], turn: true }));
  socket.send(JSON.stringify(emailMessage(link)));
  for (let wait = 0; wait < 200 && received.length < 2; wait += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.deepEqual(hostHeaders, ["evil.example"]);
  assert.deepEqual(received, [
    { t: "hello", mail: true },
    { t: "email", link, status: "sent" },
  ]);
  assert.deepEqual(
    mails.map((mail) => ("url" in mail ? mail.url : "")),
    [`${ORIGIN}/r/${link}#${EMAILED_LINK_MARKER}${SECRET}`],
  );
});

test("refuses an email from a guest or for a link this socket does not host", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  await mailHost(url, link);
  const stranger = await connect(url, true);
  stranger.send(emailMessage(link));
  assert.deepEqual(await stranger.next(), { t: "error", code: "not-on-link" });
  const guest = await connect(url, true);
  const attempt = linkId();
  guest.send({ t: "join", link, attempt });
  assert.deepEqual(await guest.next(), { t: "joined", link, attempt, iceServers: [], turn: true });
  guest.send(emailMessage(link));
  assert.deepEqual(await guest.next(), { t: "error", code: "wrong-role" });
  assert.deepEqual(mails, []);
});

test("refuses a second email for a bound link, even while the first is out", async (t) => {
  let finish = () => {};
  const { url, mails } = await mailServer(
    t,
    () =>
      new Promise<void>((done) => {
        finish = done;
      }),
  );
  const link = linkId();
  const host = await mailHost(url, link);
  host.send(emailMessage(link));
  host.send(emailMessage(link, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  finish();
  assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
  host.send(emailMessage(link, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  assert.deepEqual(
    mails.map((mail) => mail.to),
    ["anna@example.se"],
  );
});

test("keeps a link gated when its notice fails and refuses any later email for it", async (t) => {
  let fail = true;
  const { url, mails } = await mailServer(t, async () => {
    if (fail) {
      throw new Error("mail not sent");
    }
  });
  const link = linkId();
  const host = await mailHost(url, link);
  host.send(emailMessage(link));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  fail = false;
  host.send(emailMessage(link));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  const guest = await connect(url, true);
  assert.equal(await gateOf(guest, link), "a***@example.se");
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "a***@example.se" });
  await heardNothing(host);
  assert.equal(mails.length, 1);
  await codeFor(guest, host, link, mails);
});

test("spends a link whose email hit a notice cap, even after the hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t, async () => {}, {
    limits: { noticesPerRecipient: 1 },
  });
  const [first, capped, fresh] = [linkId(), linkId(), linkId()];
  const host = await mailHost(url, first, capped, fresh);
  await emailLink(host, first);
  host.send(emailMessage(capped));
  assert.deepEqual(await host.next(), { t: "email", link: capped, status: "limit" });
  t.mock.timers.tick(HOUR_MS);
  host.send(emailMessage(capped));
  assert.deepEqual(await host.next(), { t: "email", link: capped, status: "failed" });
  assert.equal(mails.length, 1);
  await emailLink(host, fresh);
  assert.equal(mails.length, 2);
});

test("refuses an email for a link that had a guest", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  const guest = await connect(url, true);
  await mailJoin(guest, host, link);
  guest.socket.close();
  assert.deepEqual(await host.next(), { t: "left", link });
  host.send(emailMessage(link));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  assert.deepEqual(mails, []);
});

test("keeps a link's binding when the host re-sends its set and refuses it once unhosted", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const other = linkId();
  const host = await mailHost(url, link, other);
  host.send(emailMessage(link));
  assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
  host.send({ t: "host", links: [other, link], turn: true });
  host.send(emailMessage(link, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  host.send({ t: "host", links: [other], turn: true });
  host.send({ t: "host", links: [link], turn: true });
  assert.deepEqual(await host.next(), { t: "error", code: "emailed" });
  host.send(emailMessage(link, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  await emailLink(host, other, { to: "bob@example.se" });
  assert.deepEqual(
    mails.map((mail) => mail.to),
    ["anna@example.se", "bob@example.se"],
  );
});

test("refuses a host message that carries an address", async (t) => {
  const { url } = await mailServer(t);
  const host = await connect(url, true);
  host.send({ t: "host", links: [linkId()], turn: true, to: "anna@example.se" });
  assert.deepEqual(await host.next(), { t: "error", code: "bad-message" });
  assert.equal(await host.closed, 1008);
});

test("forgets a link's binding when its host closes while the mail is out, and refuses its ID to other hosts", async (t) => {
  let failFirst: (error: Error) => void = () => {};
  const { url, mails } = await mailServer(
    t,
    () =>
      new Promise<void>((_, fail) => {
        failFirst = fail;
      }),
  );
  const link = linkId();
  const first = await mailHost(url, link);
  first.send(emailMessage(link));
  const guest = await connect(url, true);
  assert.equal(await gateOf(guest, link), "a***@example.se");
  first.socket.close();
  while ((await gateOf(guest, link)) !== "") {
    await new Promise((done) => setTimeout(done, 5));
  }

  const second = await connect(url, true);
  second.send({ t: "host", links: [linkId(), link], turn: true });
  assert.deepEqual(await second.next(), { t: "error", code: "emailed" });
  failFirst(new Error("mail not sent"));
  await heardNothing(second);
  assert.equal(mails.length, 1);
});

test("refuses an emailed link to every host for a day after it is unhosted, however long it was hosted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t, async () => {}, { heartbeatMs: 20 });
  const sleep = () => new Promise((done) => setTimeout(done, 50));
  const link = linkId();
  const first = await mailHost(url, link);
  await emailLink(first, link);
  t.mock.timers.tick(EMAILED_LINK_MS + 1);
  await sleep();
  first.send({ t: "host", links: [], turn: true });
  await heardNothing(first);
  const second = await connect(url, true);
  for (const host of [first, second]) {
    host.send({ t: "host", links: [link], turn: true });
    assert.deepEqual(await host.next(), { t: "error", code: "emailed" });
  }
  t.mock.timers.tick(EMAILED_LINK_MS - 1);
  await sleep();
  second.send({ t: "host", links: [link], turn: true });
  assert.deepEqual(await second.next(), { t: "error", code: "emailed" });
  t.mock.timers.tick(1);
  await sleep();
  second.send({ t: "host", links: [link], turn: true });
  await emailLink(second, link, { to: "bob@example.se" });
  assert.deepEqual(
    mails.map((mail) => mail.to),
    ["anna@example.se", "bob@example.se"],
  );
});

test("lets another socket host a link at once when it never became email-bound", async (t) => {
  const { url, mails } = await mailServer(t, async () => {}, {
    limits: { noticesPerRecipient: 1 },
  });
  const [sent, capped, guested, plain] = [linkId(), linkId(), linkId(), linkId()];
  const host = await mailHost(url, sent, capped, guested, plain);
  await emailLink(host, sent);
  host.send(emailMessage(capped));
  assert.deepEqual(await host.next(), { t: "email", link: capped, status: "limit" });
  await mailJoin(await connect(url, true), host, guested);
  host.send(emailMessage(guested, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: guested, status: "failed" });
  host.send({ t: "host", links: [sent], turn: true });
  await heardNothing(host);
  await heardNothing(await mailHost(url, capped, guested, plain));
  assert.equal(mails.length, 1);
});

test("caps one socket at 20 notices an hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t);
  const links = Array.from({ length: 20 }, linkId);
  const last = linkId();
  const host = await mailHost(url, ...links, last);
  for (const [i, link] of links.entries()) {
    host.send(emailMessage(link, { to: `r${i}@example.se` }));
    assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
  }
  host.send(emailMessage(last, { to: "last@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: last, status: "limit" });
  t.mock.timers.tick(HOUR_MS);
  const again = linkId();
  host.send({ t: "host", links: [...links, last, again], turn: true });
  host.send(emailMessage(again, { to: "last@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: again, status: "sent" });
});

test("caps one client address at 50 notices an hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t);
  let count = 0;
  for (const size of [20, 20, 10]) {
    const links = Array.from({ length: size }, linkId);
    const host = await mailHost(url, ...links);
    for (const link of links) {
      host.send(emailMessage(link, { to: `r${count}@example.se` }));
      assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
      count += 1;
    }
  }
  const [last, again] = [linkId(), linkId()];
  const host = await mailHost(url, last, again);
  host.send(emailMessage(last, { to: "last@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: last, status: "limit" });
  t.mock.timers.tick(HOUR_MS);
  host.send(emailMessage(again, { to: "last@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: again, status: "sent" });
});

test("caps one destination address at 5 notices an hour, in any case, across heartbeats", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t, async () => {}, { heartbeatMs: 20 });
  const addresses = [
    "anna@example.se",
    "ANNA@example.se",
    "Anna@Example.SE",
    "anna@EXAMPLE.se",
    "aNNa@example.se",
  ];
  const links = addresses.map(() => linkId());
  const [last, other] = [linkId(), linkId()];
  const host = await mailHost(url, ...links, last, other);
  for (const [i, link] of links.entries()) {
    host.send(emailMessage(link, { to: addresses[i] ?? "" }));
    assert.deepEqual(await host.next(), { t: "email", link, status: "sent" });
  }
  const sleep = () => new Promise((done) => setTimeout(done, 50));
  await sleep();
  host.send(emailMessage(last, { to: "ANNA@EXAMPLE.SE" }));
  assert.deepEqual(await host.next(), { t: "email", link: last, status: "limit" });
  host.send(emailMessage(other, { to: "bertil@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: other, status: "sent" });
  t.mock.timers.tick(HOUR_MS);
  await sleep();
  const again = linkId();
  host.send({ t: "host", links: [...links, last, other, again], turn: true });
  host.send(emailMessage(again, { to: "ANNA@EXAMPLE.SE" }));
  assert.deepEqual(await host.next(), { t: "email", link: again, status: "sent" });
});

test("counts a notice against no cap when another cap refuses it", async (t) => {
  const { url } = await mailServer(t, async () => {}, {
    limits: { noticesPerRecipient: 1, noticesPerClient: 2 },
  });
  const [first, refused, second] = [linkId(), linkId(), linkId()];
  const host = await mailHost(url, first, refused, second);
  host.send(emailMessage(first));
  assert.deepEqual(await host.next(), { t: "email", link: first, status: "sent" });
  host.send(emailMessage(refused));
  assert.deepEqual(await host.next(), { t: "email", link: refused, status: "limit" });
  host.send(emailMessage(second, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: second, status: "sent" });
});

test("never logs an emailed link's address, secret, URL or sender name", async (t) => {
  const secret = randomBytes(32).toString("base64url");
  const from = "Kanarie Namnsson";
  const { url, mails, lines } = await mailServer(
    t,
    async (mail) => {
      if (mail.to.startsWith("leaky")) {
        // An SMTP error that quotes everything it was given.
        throw new Error(`550 <${mail.to}> ${"url" in mail ? `${mail.url} ${mail.from}` : ""}`);
      }
    },
    { limits: { noticesPerRecipient: 1 } },
  );
  const [sent, limited, failed] = [linkId(), linkId(), linkId()];
  const host = await mailHost(url, sent, limited, failed);
  const canary = "Canary.Address@Example.se";
  host.send(emailMessage(sent, { to: canary, secret, from }));
  assert.deepEqual(await host.next(), { t: "email", link: sent, status: "sent" });
  host.send(emailMessage(sent, { to: canary, secret, from }));
  assert.deepEqual(await host.next(), { t: "email", link: sent, status: "failed" });
  host.send(emailMessage(limited, { to: canary.toLowerCase(), secret, from }));
  assert.deepEqual(await host.next(), { t: "email", link: limited, status: "limit" });
  host.send(emailMessage(failed, { to: "leaky.canary@example.se", secret, from }));
  assert.deepEqual(await host.next(), { t: "email", link: failed, status: "failed" });
  assert.equal(mails.length, 2);

  const emails = lines.filter((line) => line.includes('"event":"email"'));
  assert.deepEqual(
    emails.map((line) => JSON.parse(line).reason),
    [undefined, "failed", "limit", "failed"],
  );
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const needle of ["canary", "kanarie", "namnsson", secret.toLowerCase(), "fidant.se"]) {
      assert.ok(!lower.includes(needle), `${needle} leaked into the log: ${line}`);
    }
  }
  for (const line of emails) {
    assert.deepEqual(
      Object.keys(JSON.parse(line)).filter((key) => key !== "reason"),
      ["event", "link"],
    );
  }
});

test("answers a gate with an emailed link's masked address and nothing for other links", async (t) => {
  const { url } = await mailServer(t);
  const [emailed, plain] = [linkId(), linkId()];
  const host = await mailHost(url, emailed, plain);
  await emailLink(host, emailed);
  const guest = await connect(url, true);
  assert.equal(await gateOf(guest, emailed), "a***@example.se");
  assert.equal(await gateOf(guest, plain), "");
  assert.equal(await gateOf(guest, linkId()), "");
  guest.send({ t: "host", links: [linkId()], turn: true });
  assert.deepEqual(await guest.next(), { t: "error", code: "wrong-role" });
  for (const message of [
    { t: "gate", link: emailed },
    { t: "send-code", link: emailed },
    { t: "code", link: emailed, code: "123456" },
  ]) {
    host.send(message);
    assert.deepEqual(await host.next(), { t: "error", code: "wrong-role" });
  }
});

test("emails up to 5 codes per link, 30 seconds apart, in the link's language", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const [link, plain] = [linkId(), linkId()];
  const host = await mailHost(url, link, plain);
  await emailLink(host, link, { lang: "en" });
  const guest = await connect(url, true);
  const first = await codeFor(guest, host, link, mails);
  assert.deepEqual(mails.at(-1), { to: "anna@example.se", lang: "en", code: first });
  t.mock.timers.tick(CODE_GAP_MS - 1);
  guest.send({ t: "send-code", link });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "wait" });
  let last = first;
  for (let i = 1; i < 5; i += 1) {
    t.mock.timers.tick(i === 1 ? 1 : CODE_GAP_MS);
    last = await codeFor(guest, host, link, mails);
  }
  t.mock.timers.tick(CODE_GAP_MS);
  guest.send({ t: "send-code", link });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "limit" });
  assert.equal(mails.length, 6);
  // The newest code is the one that works.
  guest.send({ t: "code", link, code: last });
  assert.equal((await guest.next()).t, "token");
  guest.send({ t: "send-code", link: plain });
  assert.deepEqual(await guest.next(), { t: "code", link: plain, result: "failed" });
  guest.send({ t: "code", link: plain, code: "123456" });
  assert.deepEqual(await guest.next(), { t: "code", link: plain, result: "expired" });
});

test("caps codes to one address at 10 an hour, in any case, across links", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const addresses = ["anna@example.se", "ANNA@example.se", "anna@EXAMPLE.se"];
  const links = addresses.map(() => linkId());
  const host = await mailHost(url, ...links);
  for (const [i, link] of links.entries()) {
    await emailLink(host, link, { to: addresses[i] ?? "" });
  }
  const guest = await connect(url, true);
  const [first = "", second = "", third = ""] = links;
  for (let i = 0; i < 5; i += 1) {
    await codeFor(guest, host, first, mails);
    await codeFor(guest, host, second, mails);
    t.mock.timers.tick(CODE_GAP_MS);
  }
  guest.send({ t: "send-code", link: third });
  assert.deepEqual(await guest.next(), { t: "code", link: third, result: "wait" });
  t.mock.timers.tick(HOUR_MS);
  await codeFor(guest, host, third, mails);
});

test("kills a code after 5 wrong tries, after 10 minutes and once it is right", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  await emailLink(host, link);
  const guest = await connect(url, true);
  const tried = await codeFor(guest, host, link, mails);
  for (let i = 1; i < 5; i += 1) {
    guest.send({ t: "code", link, code: wrongCode(tried) });
    assert.deepEqual(await guest.next(), { t: "code", link, result: "wrong" });
  }
  guest.send({ t: "code", link, code: wrongCode(tried) });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "tries" });
  guest.send({ t: "code", link, code: tried });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });

  t.mock.timers.tick(CODE_GAP_MS);
  const late = await codeFor(guest, host, link, mails);
  t.mock.timers.tick(CODE_MS);
  guest.send({ t: "code", link, code: late });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });

  const right = await codeFor(guest, host, link, mails);
  t.mock.timers.tick(CODE_MS - 1);
  guest.send({ t: "code", link, code: right });
  const answer = await guest.next();
  assert.ok(answer.t === "token" && answer.link === link);
  assert.deepEqual(await host.next(), { t: "email", link, status: "verified" });
  guest.send({ t: "code", link, code: right });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });
});

test("lets a verified browser join its emailed link again, and no other link", async (t) => {
  const { url, mails } = await mailServer(t);
  const [link, other] = [linkId(), linkId()];
  const host = await mailHost(url, link, other);
  await emailLink(host, link);
  await emailLink(host, other, { to: "bob@example.se" });
  const guest = await connect(url, true);
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "a***@example.se" });
  const token = await tokenFor(guest, host, link, mails);
  guest.send({ t: "join", link: other, attempt: linkId(), token });
  assert.deepEqual(await guest.next(), { t: "gate", link: other, to: "b***@example.se" });
  guest.send({ t: "join", link, attempt: linkId(), token: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "a***@example.se" });
  await heardNothing(host);

  const attempt = await mailJoin(guest, host, link, token);
  // Gate before busy, so a browser without the token learns nothing about the bound guest.
  const second = await connect(url, true);
  second.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await second.next(), { t: "gate", link, to: "a***@example.se" });
  second.send({ t: "join", link, attempt: linkId(), token });
  assert.deepEqual(await second.next(), { t: "refused", reason: "busy" });

  host.send({ t: "refuse", link, attempt, reason: "busy" });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "busy" });
  await mailJoin(guest, host, link, token);
  // A reload after a decline or a drop is a new socket with the same token.
  guest.socket.close();
  assert.deepEqual(await host.next(), { t: "left", link });
  const reloaded = await connect(url, true);
  await mailJoin(reloaded, host, link, token);
  reloaded.socket.close();
  assert.deepEqual(await host.next(), { t: "left", link });
  await mailJoin(second, host, link, token);

  host.socket.close();
  assert.deepEqual(await second.next(), { t: "host-gone" });
  const late = await connect(url, true);
  late.send({ t: "join", link, attempt: linkId(), token });
  assert.deepEqual(await late.next(), { t: "refused", reason: "unknown" });
  assert.equal(await gateOf(late, link), "");
});

test("forgets an emailed link's codes and tokens when it is unhosted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  await emailLink(host, link);
  const guest = await connect(url, true);
  const token = await tokenFor(guest, host, link, mails);
  t.mock.timers.tick(CODE_GAP_MS);
  const code = await codeFor(guest, host, link, mails);
  host.send({ t: "host", links: [], turn: true });
  await heardNothing(host);
  guest.send({ t: "code", link, code });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });
  t.mock.timers.tick(EMAILED_LINK_MS);
  host.send({ t: "host", links: [link], turn: true });
  await emailLink(host, link);
  guest.send({ t: "join", link, attempt: linkId(), token });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "a***@example.se" });
});

test("never logs an emailed link's address, code or token", async (t) => {
  const { url, mails, lines } = await mailServer(t, async (mail) => {
    if ("code" in mail && mail.to.startsWith("leaky")) {
      // An SMTP error that quotes everything it was given.
      throw new Error(`550 <${mail.to}> ${mail.code}`);
    }
  });
  const [link, leaky] = [linkId(), linkId()];
  const host = await mailHost(url, link, leaky);
  const canary = "Canary.Address@Example.se";
  await emailLink(host, link, { to: canary });
  await emailLink(host, leaky, { to: "leaky.canary@example.se" });
  const guest = await connect(url, true);
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "C***@Example.se" });
  guest.send({ t: "send-code", link: leaky });
  assert.deepEqual(await guest.next(), { t: "code", link: leaky, result: "failed" });
  const code = await codeFor(guest, host, link, mails);
  guest.send({ t: "send-code", link });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "wait" });
  guest.send({ t: "code", link, code: wrongCode(code) });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "wrong" });
  guest.send({ t: "code", link, code });
  const answer = await guest.next();
  assert.ok(answer.t === "token");
  assert.deepEqual(await host.next(), { t: "email", link, status: "verified" });
  await mailJoin(guest, host, link, answer.token);

  const prefix = link.slice(0, 6);
  assert.deepEqual(
    lines
      .map((line) => JSON.parse(line))
      .filter((line) => ["code", "verified", "refused"].includes(line.event)),
    [
      { event: "refused", link: prefix, reason: "unverified" },
      { event: "code", link: leaky.slice(0, 6), reason: "failed" },
      { event: "code", link: prefix },
      { event: "code", link: prefix, reason: "wait" },
      { event: "code", link: prefix, reason: "wrong" },
      { event: "verified", link: prefix },
    ],
  );
  const codes = mails.flatMap((mail) => ("code" in mail ? [mail.code] : []));
  assert.equal(codes.length, 2);
  for (const line of lines) {
    const lower = line.toLowerCase();
    assert.ok(!lower.includes("canary"), `an address leaked into the log: ${line}`);
    assert.ok(!line.includes(answer.token), `the token leaked into the log: ${line}`);
    for (const value of codes) {
      assert.ok(!line.includes(value), `a code leaked into the log: ${line}`);
    }
  }
});
