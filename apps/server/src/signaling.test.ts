import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import { type AddressInfo, BlockList, type Socket, connect as tcpConnect } from "node:net";
import { networkInterfaces } from "node:os";
import { after, before, test } from "node:test";
import {
  CODE_RESULTS,
  CONNECTION_PATHS,
  ERROR_CODES,
  type LogFields,
  MAX_RELAY_DATA,
  parseEmailedFragment,
  parseServerMessage,
  REFUSED_REASONS,
  type ServerMessage,
  UPGRADE_REJECT_REASONS,
} from "@sigill/protocol";
import { WebSocket as WsClient } from "ws";
import type { Mail, Mailer } from "./mail.ts";
import { attachSignaling, clientAddress, HEARTBEAT_MS, LIMITS } from "./signaling.ts";

const logLines: { event: string; fields: LogFields | undefined }[] = [];
const RELAY = { urls: ["turn:relay.example:3478"], username: "1700000000", credential: "hmac" };
const server = createServer((_req, res) => res.writeHead(404).end());
const signaling = attachSignaling(server, {
  log: (event, fields) => logLines.push({ event, fields }),
  iceServers: (turn) => (turn ? [RELAY] : []),
  // Every test's sockets stay open until after(), and all come from one address.
  limits: { socketsPerAddress: 1000 },
  // Past the warm-up window at once, so a link nobody hosts is `unknown`.
  startingMs: 0,
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

// One client asking for codes on its own links must not be able to lock an address out.
test("keeps a client's code cap below an address's", () => {
  assert.ok(LIMITS.codesPerClient < LIMITS.codesPerRecipient);
});

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

test("refuses a link nobody hosts as starting while the server warms up, then as unknown", async (t) => {
  const warming = createServer();
  const warmingSignaling = attachSignaling(warming, { log: () => {}, startingMs: 300 });
  t.after(() => {
    warmingSignaling.close();
    warming.close();
  });
  await new Promise<void>((done) => warming.listen(0, done));
  const url = `ws://localhost:${(warming.address() as AddressInfo).port}/signal`;

  const link = linkId();
  const guest = await connect(url);
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "refused", reason: "starting" });

  // A hosted link still pairs, and a link with a guest is still busy.
  const host = await connect(url);
  host.send({ t: "host", links: [link], turn: false });
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  const attempt = linkId();
  guest.send({ t: "join", link, attempt });
  assert.deepEqual(await host.next(), { t: "joined", link, attempt, iceServers: [], turn: false });
  const second = await connect(url);
  second.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await second.next(), { t: "refused", reason: "busy" });

  await new Promise((done) => setTimeout(done, 300));
  second.send({ t: "join", link: linkId(), attempt: linkId() });
  assert.deepEqual(await second.next(), { t: "refused", reason: "unknown" });
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

test("logs host only when the link list changes, so a relay toggle leaves no log line", async () => {
  const link = linkId();
  const before = logLines.length;
  const host = await hostFor(link);
  host.send({ t: "host", links: [link], turn: false });
  host.send({ t: "host", links: [link], turn: true });
  host.send({ t: "host", links: [link, linkId()], turn: true });
  host.send({ t: "relay", link: linkId(), data: "sync" });
  assert.deepEqual(await host.next(), { t: "error", code: "not-on-link" });
  assert.deepEqual(
    logLines
      .slice(before)
      .filter((line) => line.event === "host")
      .map((line) => line.fields),
    [{ links: 1 }, { links: 2 }],
  );
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

test("rejects hosting a link another socket already hosts but hosts the rest", async () => {
  const link = linkId();
  const fresh = linkId();
  const owner = await hostFor(link);
  const rival = await connect();
  rival.send({ t: "host", links: [fresh, link], turn: true });
  assert.deepEqual(await rival.next(), { t: "error", code: "already-hosted" });
  await joinAs(link, owner);
  await joinAs(fresh, rival);
});

test("keeps a reconnecting sender's other links hosted when another socket took one (SIG-233)", async () => {
  const [taken, kept, third] = [linkId(), linkId(), linkId()];
  const sender = await hostFor(taken, kept, third);
  sender.socket.close();
  await sender.closed;
  // Someone who knows one link ID hosts it as soon as the server has noticed the close.
  const other = await connect();
  for (;;) {
    other.send({ t: "host", links: [taken], turn: false });
    other.send({ t: "relay", link: linkId(), data: "sync" });
    const answer = await other.next();
    if (answer.t === "error" && answer.code === "not-on-link") {
      break;
    }
    assert.deepEqual(answer, { t: "error", code: "already-hosted" });
    assert.deepEqual(await other.next(), { t: "error", code: "not-on-link" });
    await new Promise((done) => setTimeout(done, 5));
  }
  // The send page sends its whole list again after a reconnect.
  const back = await connect();
  back.send({ t: "host", links: [taken, kept, third], turn: true });
  assert.deepEqual(await back.next(), { t: "error", code: "already-hosted" });
  await joinAs(kept, back);
  await joinAs(third, back);
  await joinAs(taken, other, false);
  // Once the other socket is gone, the same list hosts the taken link too.
  other.socket.close();
  await other.closed;
  for (;;) {
    back.send({ t: "host", links: [taken, kept, third], turn: true });
    back.send({ t: "relay", link: linkId(), data: "sync" });
    const answer = await back.next();
    if (answer.t === "error" && answer.code === "not-on-link") {
      break;
    }
    assert.deepEqual(answer, { t: "error", code: "already-hosted" });
    assert.deepEqual(await back.next(), { t: "error", code: "not-on-link" });
    await new Promise((done) => setTimeout(done, 5));
  }
  await joinAs(taken, back);
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
    ...REFUSED_REASONS,
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

test("close() closes every socket with 1012, so clients know the server is restarting", async (t) => {
  const closing = createServer();
  const closingSignaling = attachSignaling(closing, { log: () => {} });
  t.after(() => closing.close());
  await new Promise<void>((done) => closing.listen(0, done));
  const url = `ws://localhost:${(closing.address() as AddressInfo).port}/signal`;
  const host = await connect(url);
  const guest = await connect(url);
  closingSignaling.close();
  assert.deepEqual(await Promise.all([host.closed, guest.closed]), [1012, 1012]);
});

test("keys clients by address, trusting X-Forwarded-For only from loopback without proxies", () => {
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

test("trusts X-Forwarded-For from a configured range and from no other peer", () => {
  const proxies = new BlockList();
  proxies.addSubnet("10.0.1.0", 24, "ipv4");
  proxies.addSubnet("2001:db8:aa::", 48, "ipv6");
  assert.equal(clientAddress("10.0.1.5", "198.51.100.1", proxies), "198.51.100.1");
  assert.equal(clientAddress("::ffff:10.0.1.5", "198.51.100.1", proxies), "198.51.100.1");
  assert.equal(clientAddress("10.0.1.5", "203.0.113.9, 198.51.100.1", proxies), "198.51.100.1");
  assert.equal(clientAddress("2001:db8:aa::7", "198.51.100.1", proxies), "198.51.100.1");
  assert.equal(clientAddress("10.0.1.5", "2001:db8:1:2::9", proxies), "2001:db8:1:2::/64");
  assert.equal(clientAddress("10.0.2.5", "198.51.100.1", proxies), "10.0.2.5");
  assert.equal(clientAddress("203.0.113.7", "198.51.100.1", proxies), "203.0.113.7");
  assert.equal(clientAddress("10.0.1.5", "not-an-ip", proxies), "10.0.1.5");
  assert.equal(clientAddress("10.0.1.5", undefined, proxies), "10.0.1.5");
  assert.equal(clientAddress("127.0.0.1", "198.51.100.1", proxies), "198.51.100.1");
  assert.equal(clientAddress(undefined, "198.51.100.1", proxies), "");
});

/**
 * Starts a second signaling server with lowered limits, on 127.0.0.1 unless `extra.host` names
 * another address, so every client in the test counts against the same address.
 */
async function limitedServer(
  t: { after(fn: () => void): void },
  limits: { sockets?: number; socketsPerAddress?: number },
  extra: { host?: string; proxies?: BlockList; siteOrigin?: string } = {},
): Promise<{ host: string; port: number; server: Server }> {
  const host = extra.host ?? "127.0.0.1";
  const limited = createServer();
  const limitedSignaling = attachSignaling(limited, {
    log: () => {},
    limits,
    proxies: extra.proxies,
    siteOrigin: extra.siteOrigin,
  });
  t.after(() => {
    limitedSignaling.close();
    limited.close();
  });
  await new Promise<void>((done) => limited.listen(0, host, done));
  return { host, port: (limited.address() as AddressInfo).port, server: limited };
}

test("also accepts upgrades from the configured site origin", async (t) => {
  const site = await limitedServer(t, {}, { siteOrigin: "https://fidant.se" });
  const ok = (origin?: string) => upgradeStatus("/signal", origin ? { origin } : {}, site);
  assert.equal(await ok(), 101);
  assert.equal(await ok("https://fidant.se"), 101);
  assert.equal(await ok(`http://127.0.0.1:${site.port}`), 101);
  for (const origin of [
    "http://fidant.se",
    "https://fidant.se.evil.example",
    "https://fidant.se:8443",
    "https://www.fidant.se",
    "https://evil.example",
    "null",
  ]) {
    assert.equal(await ok(origin), 403, origin);
  }
  assert.equal(await upgradeStatus("/signal", { origin: "https://fidant.se" }), 403);
});

test("counts a socket behind a configured proxy against the forwarded address", async (t) => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((a) => a?.family === "IPv4" && !a.internal)?.address;
  if (!lan) {
    t.skip("no LAN address");
    return;
  }
  const proxies = new BlockList();
  proxies.addAddress(lan, "ipv4");
  const trusting = await limitedServer(t, { socketsPerAddress: 1 }, { host: lan, proxies });
  const plain = await limitedServer(t, { socketsPerAddress: 1 }, { host: lan });
  const forwarded = { "x-forwarded-for": "198.51.100.1" };
  await connect(`ws://${lan}:${trusting.port}/signal`);
  assert.equal(await upgradeStatus("/signal", {}, trusting), 429);
  assert.equal(await upgradeStatus("/signal", forwarded, trusting), 101);
  await connect(`ws://${lan}:${plain.port}/signal`);
  assert.equal(await upgradeStatus("/signal", forwarded, plain), 429);
});

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

test("refuses a link's joins as busy past its pairings per window, so a guest cannot spend the host's limit", async (t) => {
  const limited = createServer();
  // The heartbeat tick ends the window; mock it so the test, not the clock, decides when.
  t.mock.timers.enable({ apis: ["setInterval"] });
  const heartbeatMs = 1000;
  const signaling = attachSignaling(limited, {
    log: () => {},
    heartbeatMs,
    limits: { pairingsPerLink: 3 },
  });
  t.after(() => {
    signaling.close();
    limited.close();
  });
  await new Promise<void>((done) => limited.listen(0, done));
  const url = `ws://localhost:${(limited.address() as AddressInfo).port}/signal`;
  const link = linkId();
  const host = await connect(url);
  host.send({ t: "host", links: [link], turn: false });
  const guest = await connect(url);
  // Join, get refused by the host, join again: one socket, as a guest without the secret would.
  const pair = async () => {
    const attempt = linkId();
    guest.send({ t: "join", link, attempt });
    const reply = await guest.next();
    if (reply.t !== "joined") {
      return reply;
    }
    assert.equal((await host.next()).t, "joined");
    host.send({ t: "refuse", link, attempt, reason: "drop" });
    assert.deepEqual(await guest.next(), { t: "refused", reason: "drop" });
    return reply;
  };
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await pair()).t, "joined");
  }
  assert.deepEqual(await pair(), { t: "refused", reason: "busy" });
  t.mock.timers.tick(heartbeatMs);
  assert.equal((await pair()).t, "joined");
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
    limits: { bufferedBytes: 64 * 1024, messagesPerWindow: 10_000_000 },
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

/** A signaling server on 127.0.0.1 that records each mail before `send` and keeps its log lines. */
async function mailServer(
  t: { after(fn: () => void): void },
  send: Mailer = async () => {},
  options: {
    heartbeatMs?: number;
    limits?: {
      noticesPerSocket?: number;
      noticesPerClient?: number;
      noticesPerRecipient?: number;
      noticesTotal?: number;
      codesTotal?: number;
    };
  } = {},
) {
  const mails: Mail[] = [];
  const lines: string[] = [];
  const mailing = createServer();
  const mailingSignaling = attachSignaling(mailing, {
    log: (event, fields) => lines.push(JSON.stringify({ event, ...fields })),
    startingMs: 0,
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

/** Checks that a reply for a registration the server took carries a mark, and returns it. */
function markIn(answer: ServerMessage, link: string, status: "sent" | "failed" = "sent"): string {
  assert.ok(
    answer.t === "email" && answer.link === link && answer.status === status && answer.mark,
    `not a marked ${status}: ${answer.t}`,
  );
  return answer.mark;
}

/** The mark in a notice's link. */
function noticeMark(mail: Mail | undefined): string {
  assert.ok(mail && "url" in mail, "no notice was mailed");
  const marked = parseEmailedFragment(new URL(mail.url).hash.slice(1));
  assert.ok(marked, `no mark in the notice's link`);
  return marked.mark;
}

/** Emails a hosted link's notice, checks it went out and returns the mark in its link. */
async function emailLink(host: Client, link: string, fields: EmailFields = {}): Promise<string> {
  host.send(emailMessage(link, fields));
  return markIn(await host.next(), link);
}

/** Asks, with a mark if given, where a link's code goes and returns the masked address, or "". */
async function gateOf(guest: Client, link: string, mark?: string): Promise<string> {
  guest.send({ t: "gate", link, mark });
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
async function codeFor(
  guest: Pick<Client, "send" | "next">,
  host: Client,
  link: string,
  mails: Mail[],
  mark: string,
) {
  guest.send({ t: "send-code", link, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "sent" });
  assert.deepEqual(await host.next(), { t: "email", link, status: "verifying" });
  const mail = mails.at(-1);
  assert.ok(mail && "code" in mail, "no code was mailed");
  assert.match(mail.code, /^[0-9]{6}$/);
  return mail.code;
}

/** Enters a fresh right code, checks the host hears `verified`, and returns the token. */
async function tokenFor(guest: Client, host: Client, link: string, mails: Mail[], mark: string) {
  guest.send({ t: "code", link, mark, code: await codeFor(guest, host, link, mails, mark) });
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
});

test("emails a hosted link's notice once and tells the host it was sent", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  const mark = await emailLink(host, link, { from: "" });
  assert.deepEqual(mails, [
    { to: "anna@example.se", lang: "sv", from: "", url: `${ORIGIN}/r/${link}#e.${mark}.${SECRET}` },
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
  const mark = noticeMark(mails[0]);
  assert.deepEqual(received, [
    { t: "hello", mail: true },
    { t: "email", link, status: "sent", mark },
  ]);
  assert.deepEqual(
    mails.map((mail) => ("url" in mail ? mail.url : "")),
    [`${ORIGIN}/r/${link}#e.${mark}.${SECRET}`],
  );
});

test("refuses an email from a guest or for a link this socket does not host", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  await mailHost(url, link);
  const stranger = await connect(url, true);
  stranger.send(emailMessage(link));
  assert.deepEqual(await stranger.next(), { t: "email", link, status: "failed" });
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
  markIn(await host.next(), link);
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
  const mark = markIn(await host.next(), link, "failed");
  assert.equal(noticeMark(mails[0]), mark);
  fail = false;
  host.send(emailMessage(link));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  const guest = await connect(url, true);
  assert.equal(await gateOf(guest, link, mark), "a***@example.se");
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "" });
  await heardNothing(host);
  assert.equal(mails.length, 1);
  await codeFor(guest, host, link, mails, mark);
});

test("returns no mark for a link whose email hit a notice cap, and spends it even after the hour", async (t) => {
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

test("keeps a link's binding when the host re-sends its set and drops it when unhosted", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const other = linkId();
  const host = await mailHost(url, link, other);
  await emailLink(host, link);
  host.send({ t: "host", links: [other, link], turn: true });
  host.send(emailMessage(link, { to: "bob@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link, status: "failed" });
  host.send({ t: "host", links: [other], turn: true });
  host.send({ t: "host", links: [other, link], turn: true });
  await emailLink(host, link, { to: "bob@example.se" });
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

test("forgets a link's binding when its host closes while the mail is still out", async (t) => {
  let calls = 0;
  let failFirst: (error: Error) => void = () => {};
  const { url, mails } = await mailServer(t, () => {
    calls += 1;
    return calls === 1
      ? new Promise<void>((_, fail) => {
          failFirst = fail;
        })
      : Promise.resolve();
  });
  const link = linkId();
  const first = await mailHost(url, link);
  first.send(emailMessage(link));
  const guest = await connect(url, true);
  const mark = noticeMark(mails[0]);
  assert.equal(await gateOf(guest, link, mark), "a***@example.se");
  first.socket.close();
  while ((await gateOf(guest, link, mark)) !== "") {
    await new Promise((done) => setTimeout(done, 5));
  }

  const second = await mailHost(url, link);
  const fresh = await emailLink(second, link, { to: "bob@example.se" });
  // The first send failing late must not unbind the second host's link.
  failFirst(new Error("mail not sent"));
  second.send(emailMessage(link));
  assert.deepEqual(await second.next(), { t: "email", link, status: "failed" });
  assert.equal(await gateOf(guest, link, fresh), "b***@example.se");
  assert.equal(mails.length, 2);
});

test("caps one socket at 20 notices an hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t);
  const links = Array.from({ length: 20 }, linkId);
  const last = linkId();
  const host = await mailHost(url, ...links, last);
  for (const [i, link] of links.entries()) {
    await emailLink(host, link, { to: `r${i}@example.se` });
  }
  host.send(emailMessage(last, { to: "last@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: last, status: "limit" });
  t.mock.timers.tick(HOUR_MS);
  const again = linkId();
  host.send({ t: "host", links: [...links, last, again], turn: true });
  await emailLink(host, again, { to: "last@example.se" });
});

test("caps one client address at 50 notices an hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t);
  let count = 0;
  for (const size of [20, 20, 10]) {
    const links = Array.from({ length: size }, linkId);
    const host = await mailHost(url, ...links);
    for (const link of links) {
      await emailLink(host, link, { to: `r${count}@example.se` });
      count += 1;
    }
  }
  const [last, again] = [linkId(), linkId()];
  const host = await mailHost(url, last, again);
  host.send(emailMessage(last, { to: "last@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: last, status: "limit" });
  t.mock.timers.tick(HOUR_MS);
  await emailLink(host, again, { to: "last@example.se" });
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
    await emailLink(host, link, { to: addresses[i] ?? "" });
  }
  const sleep = () => new Promise((done) => setTimeout(done, 50));
  await sleep();
  host.send(emailMessage(last, { to: "ANNA@EXAMPLE.SE" }));
  assert.deepEqual(await host.next(), { t: "email", link: last, status: "limit" });
  await emailLink(host, other, { to: "bertil@example.se" });
  t.mock.timers.tick(HOUR_MS);
  await sleep();
  const again = linkId();
  host.send({ t: "host", links: [...links, last, other, again], turn: true });
  await emailLink(host, again, { to: "ANNA@EXAMPLE.SE" });
});

test("counts a notice against no cap when another cap refuses it", async (t) => {
  const { url } = await mailServer(t, async () => {}, {
    limits: { noticesPerRecipient: 1, noticesPerClient: 2 },
  });
  const [first, refused, second] = [linkId(), linkId(), linkId()];
  const host = await mailHost(url, first, refused, second);
  await emailLink(host, first);
  host.send(emailMessage(refused));
  assert.deepEqual(await host.next(), { t: "email", link: refused, status: "limit" });
  await emailLink(host, second, { to: "bob@example.se" });
});

test("never logs an emailed link's address, secret, URL, mark or sender name", async (t) => {
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
  const marks = [await emailLink(host, sent, { to: canary, secret, from })];
  host.send(emailMessage(sent, { to: canary, secret, from }));
  assert.deepEqual(await host.next(), { t: "email", link: sent, status: "failed" });
  host.send(emailMessage(limited, { to: canary.toLowerCase(), secret, from }));
  assert.deepEqual(await host.next(), { t: "email", link: limited, status: "limit" });
  host.send(emailMessage(failed, { to: "leaky.canary@example.se", secret, from }));
  marks.push(markIn(await host.next(), failed, "failed"));
  assert.equal(mails.length, 2);

  const emails = lines.filter((line) => line.includes('"event":"email"'));
  assert.deepEqual(
    emails.map((line) => JSON.parse(line).reason),
    [undefined, "failed", "limit", "failed"],
  );
  for (const line of lines) {
    const lower = line.toLowerCase();
    const needles = ["canary", "kanarie", "namnsson", secret, "fidant.se", ...marks];
    for (const needle of needles.map((needle) => needle.toLowerCase())) {
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
  const mark = await emailLink(host, emailed);
  const guest = await connect(url, true);
  assert.equal(await gateOf(guest, emailed, mark), "a***@example.se");
  assert.equal(await gateOf(guest, plain), "");
  assert.equal(await gateOf(guest, plain, mark), "");
  assert.equal(await gateOf(guest, linkId(), mark), "");
  guest.send({ t: "host", links: [linkId()], turn: true });
  assert.deepEqual(await guest.next(), { t: "error", code: "wrong-role" });
  for (const message of [
    { t: "gate", link: emailed, mark },
    { t: "send-code", link: emailed, mark },
    { t: "code", link: emailed, code: "123456", mark },
  ]) {
    host.send(message);
    assert.deepEqual(await host.next(), { t: "error", code: "wrong-role" });
  }
});

test("answers anyone without an emailed link's mark as for a plain link, and spends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  const mark = await emailLink(host, link);
  const stranger = await connect(url, true);
  const guesses = [undefined, linkId(), `${mark.startsWith("A") ? "B" : "A"}${mark.slice(1)}`];
  for (const guess of guesses) {
    assert.equal(await gateOf(stranger, link, guess), "");
    stranger.send({ t: "send-code", link, mark: guess });
    assert.deepEqual(await stranger.next(), { t: "code", link, result: "failed" });
    stranger.send({ t: "join", link, attempt: linkId() });
    assert.deepEqual(await stranger.next(), { t: "gate", link, to: "" });
  }
  assert.equal(mails.length, 1);
  await heardNothing(host);

  // The recipient still gets a code at once, and keeps all its tries.
  const guest = await connect(url, true);
  const code = await codeFor(guest, host, link, mails, mark);
  for (const guess of guesses) {
    for (const tried of [wrongCode(code), wrongCode(code), code]) {
      stranger.send({ t: "code", link, code: tried, mark: guess });
      assert.deepEqual(await stranger.next(), { t: "code", link, result: "expired" });
    }
  }
  for (let i = 1; i < 5; i += 1) {
    guest.send({ t: "code", link, code: wrongCode(code), mark });
    assert.deepEqual(await guest.next(), { t: "code", link, result: "wrong" });
  }
  guest.send({ t: "code", link, code, mark });
  assert.equal((await guest.next()).t, "token");
  await heardNothing(stranger);
});

test("gives each registration of a link a new mark and answers an old mark as plain", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const first = await mailHost(url, link);
  const old = await emailLink(first, link);
  assert.equal(noticeMark(mails[0]), old);
  const guest = await connect(url, true);
  first.socket.close();
  while ((await gateOf(guest, link, old)) !== "") {
    await new Promise((done) => setTimeout(done, 5));
  }
  const second = await mailHost(url, link);
  const fresh = await emailLink(second, link, { to: "bob@example.se" });
  assert.notEqual(fresh, old);
  assert.equal(noticeMark(mails[1]), fresh);
  assert.equal(await gateOf(guest, link, old), "");
  guest.send({ t: "send-code", link, mark: old });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "failed" });
  assert.equal(await gateOf(guest, link, fresh), "b***@example.se");
  assert.equal(mails.length, 2);
});

test("answers a mark from before a restart as plain", async (t) => {
  const first = await mailServer(t);
  const link = linkId();
  const mark = await emailLink(await mailHost(first.url, link), link);
  const restarted = await mailServer(t);
  const host = await mailHost(restarted.url, link);
  const guest = await connect(restarted.url, true);
  assert.equal(await gateOf(guest, link, mark), "");
  guest.send({ t: "send-code", link, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "failed" });
  assert.deepEqual(restarted.mails, []);
  await mailJoin(guest, host, link);
});

test("refuses a token on a link that is no longer email-bound, and lets a plain join through", async (t) => {
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const first = await mailHost(url, link);
  const mark = await emailLink(first, link);
  const guest = await connect(url, true);
  const token = await tokenFor(guest, first, link, mails, mark);
  first.send({ t: "host", links: [], turn: true });
  await heardNothing(first);
  const second = await mailHost(url, link);
  await heardNothing(second);
  guest.send({ t: "join", link, attempt: linkId(), token });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "" });
  await heardNothing(second);
  await mailJoin(guest, second, link);
});

test("emails up to 5 codes per link, 30 seconds apart, in the link's language", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const [link, plain] = [linkId(), linkId()];
  const host = await mailHost(url, link, plain);
  const mark = await emailLink(host, link, { lang: "en" });
  const guest = await connect(url, true);
  const first = await codeFor(guest, host, link, mails, mark);
  assert.deepEqual(mails.at(-1), { to: "anna@example.se", lang: "en", code: first });
  t.mock.timers.tick(CODE_GAP_MS - 1);
  guest.send({ t: "send-code", link, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "wait" });
  let last = first;
  for (let i = 1; i < 5; i += 1) {
    t.mock.timers.tick(i === 1 ? 1 : CODE_GAP_MS);
    last = await codeFor(guest, host, link, mails, mark);
  }
  t.mock.timers.tick(CODE_GAP_MS);
  guest.send({ t: "send-code", link, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "limit" });
  assert.equal(mails.length, 6);
  // The newest code is the one that works.
  guest.send({ t: "code", link, code: last, mark });
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
  const marks: string[] = [];
  for (const [i, link] of links.entries()) {
    marks.push(await emailLink(host, link, { to: addresses[i] ?? "" }));
  }
  // Two clients, so that neither reaches its own cap of 5 codes an hour.
  const one = await connectFrom(t, url, "192.0.2.1");
  const two = await connectFrom(t, url, "192.0.2.2");
  const guest = await connectFrom(t, url, "192.0.2.3");
  const [first = "", second = "", third = ""] = links;
  const [firstMark = "", secondMark = "", thirdMark = ""] = marks;
  for (let i = 0; i < 5; i += 1) {
    await codeFor(one, host, first, mails, firstMark);
    await codeFor(two, host, second, mails, secondMark);
    t.mock.timers.tick(CODE_GAP_MS);
  }
  guest.send({ t: "send-code", link: third, mark: thirdMark });
  assert.deepEqual(await guest.next(), { t: "code", link: third, result: "wait" });
  t.mock.timers.tick(HOUR_MS);
  await codeFor(guest, host, third, mails, thirdMark);
});

test("kills a code after 5 wrong tries, after 10 minutes and once it is right", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  const mark = await emailLink(host, link);
  const guest = await connect(url, true);
  const tried = await codeFor(guest, host, link, mails, mark);
  for (let i = 1; i < 5; i += 1) {
    guest.send({ t: "code", link, code: wrongCode(tried), mark });
    assert.deepEqual(await guest.next(), { t: "code", link, result: "wrong" });
  }
  guest.send({ t: "code", link, code: wrongCode(tried), mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "tries" });
  guest.send({ t: "code", link, code: tried, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });

  t.mock.timers.tick(CODE_GAP_MS);
  const late = await codeFor(guest, host, link, mails, mark);
  t.mock.timers.tick(CODE_MS);
  guest.send({ t: "code", link, code: late, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });

  const right = await codeFor(guest, host, link, mails, mark);
  t.mock.timers.tick(CODE_MS - 1);
  guest.send({ t: "code", link, code: right, mark });
  const answer = await guest.next();
  assert.ok(answer.t === "token" && answer.link === link);
  assert.deepEqual(await host.next(), { t: "email", link, status: "verified" });
  guest.send({ t: "code", link, code: right, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });
});

test("lets a verified browser join its emailed link again, and no other link", async (t) => {
  const { url, mails } = await mailServer(t);
  const [link, other] = [linkId(), linkId()];
  const host = await mailHost(url, link, other);
  const mark = await emailLink(host, link);
  await emailLink(host, other, { to: "bob@example.se" });
  const guest = await connect(url, true);
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "" });
  const token = await tokenFor(guest, host, link, mails, mark);
  guest.send({ t: "join", link: other, attempt: linkId(), token });
  assert.deepEqual(await guest.next(), { t: "gate", link: other, to: "" });
  guest.send({ t: "join", link, attempt: linkId(), token: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "" });
  await heardNothing(host);

  const attempt = await mailJoin(guest, host, link, token);
  // Gate before busy, so a browser without the token learns nothing about the bound guest.
  const second = await connect(url, true);
  second.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await second.next(), { t: "gate", link, to: "" });
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
  assert.deepEqual(await late.next(), { t: "gate", link, to: "" });
  late.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await late.next(), { t: "refused", reason: "unknown" });
  assert.equal(await gateOf(late, link, mark), "");
});

test("forgets an emailed link's codes and tokens when it is unhosted", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t);
  const link = linkId();
  const host = await mailHost(url, link);
  const mark = await emailLink(host, link);
  const guest = await connect(url, true);
  const token = await tokenFor(guest, host, link, mails, mark);
  t.mock.timers.tick(CODE_GAP_MS);
  const code = await codeFor(guest, host, link, mails, mark);
  host.send({ t: "host", links: [], turn: true });
  host.send({ t: "host", links: [link], turn: true });
  const fresh = await emailLink(host, link);
  for (const tried of [mark, fresh]) {
    guest.send({ t: "code", link, code, mark: tried });
    assert.deepEqual(await guest.next(), { t: "code", link, result: "expired" });
  }
  guest.send({ t: "join", link, attempt: linkId(), token });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "" });
});

test("never logs an emailed link's address, mark, code or token", async (t) => {
  const { url, mails, lines } = await mailServer(t, async (mail) => {
    if ("code" in mail && mail.to.startsWith("leaky")) {
      // An SMTP error that quotes everything it was given.
      throw new Error(`550 <${mail.to}> ${mail.code}`);
    }
  });
  const [link, leaky] = [linkId(), linkId()];
  const host = await mailHost(url, link, leaky);
  const canary = "Canary.Address@Example.se";
  const mark = await emailLink(host, link, { to: canary });
  const leakyMark = await emailLink(host, leaky, { to: "leaky.canary@example.se" });
  const guest = await connect(url, true);
  guest.send({ t: "join", link, attempt: linkId() });
  assert.deepEqual(await guest.next(), { t: "gate", link, to: "" });
  assert.equal(await gateOf(guest, link, mark), "C***@Example.se");
  guest.send({ t: "send-code", link: leaky, mark: leakyMark });
  assert.deepEqual(await guest.next(), { t: "code", link: leaky, result: "failed" });
  const code = await codeFor(guest, host, link, mails, mark);
  guest.send({ t: "send-code", link, mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "wait" });
  guest.send({ t: "code", link, code: wrongCode(code), mark });
  assert.deepEqual(await guest.next(), { t: "code", link, result: "wrong" });
  guest.send({ t: "code", link, code, mark });
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
    for (const value of [mark, leakyMark]) {
      assert.ok(!line.includes(value), `a mark leaked into the log: ${line}`);
    }
    for (const value of codes) {
      assert.ok(!line.includes(value), `a code leaked into the log: ${line}`);
    }
  }
});

// The tests below come from the security audit of 2026-11-25.

test("closes a socket that never reads once the replies queued for it pass the limit (SIG-234)", {}, async (t) => {
  const relay = await bufferedRelay(t);
  relay.guest.pause();
  await relay.flood(500);
  assert.ok(relay.events.includes("relay-dropped"), "the guest's queue never reached the limit");
  // The queue is at the limit. Each message below earns the guest an `error` reply it never
  // reads, and unlike a relay those replies are queued whatever is already waiting.
  const count = (event: string) => relay.events.filter((e) => e === event).length;
  const before = count("error");
  const message = JSON.stringify({ t: "relay", link: linkId(), data: "sync" });
  // The kernel's socket buffers grow on localhost and take replies Node no longer counts as
  // queued, so a fixed number of messages may never reach the limit: send until the socket closes.
  let asked = 0;
  const deadline = Date.now() + 10_000;
  while (count("left") === 0 && Date.now() < deadline) {
    for (let i = 0; i < 1000; i += 1) {
      relay.guest.send(message);
    }
    asked += 1000;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(count("rate-limited"), 0, "the rate limit closed the socket, not the queue limit");
  assert.equal(
    count("left"),
    1,
    `the server queued ${count("error") - before} of ${asked} replies`,
  );
});

// Guards the ws library's own limit (maxPendingAutoPongs), so a ws upgrade that drops it fails here.
test("closes a client that floods pings and never reads the pongs", async (t) => {
  const quiet = createServer();
  const accepted: Socket[] = [];
  quiet.on("connection", (socket) => accepted.push(socket));
  const quietSignaling = attachSignaling(quiet, { log: () => {} });
  await new Promise<void>((done) => quiet.listen(0, "127.0.0.1", done));
  const client = tcpConnect((quiet.address() as AddressInfo).port, "127.0.0.1");
  client.on("error", () => {});
  t.after(() => {
    client.destroy();
    quietSignaling.close();
    quiet.close();
  });
  client.write(rawUpgrade("/signal"));
  client.pause();
  // A masked ping frame with the largest payload a control frame may carry.
  const mask = randomBytes(4);
  const ping = Buffer.concat([
    Buffer.from([0x89, 0x80 | 125]),
    mask,
    Buffer.from(Array.from({ length: 125 }, (_, i) => 0x41 ^ (mask[i % 4] as number))),
  ]);
  const batch = Buffer.concat(Array.from({ length: 2000 }, () => ping));
  const deadline = Date.now() + 10_000;
  while (!accepted[0]?.destroyed && Date.now() < deadline) {
    if (!client.destroyed) {
      client.write(batch);
    }
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok(accepted[0]?.destroyed, "the server kept queueing pongs");
});

/** Opens a socket to a mail server as a client at `address`, the way Caddy reports one. */
async function connectFrom(t: { after(fn: () => void): void }, url: string, address: string) {
  const socket = new WsClient(url, { headers: { "x-forwarded-for": address } });
  t.after(() => socket.terminate());
  const queue: ServerMessage[] = [];
  const waiting: ((message: ServerMessage) => void)[] = [];
  socket.on("message", (data) => {
    const message = parseServerMessage(String(data));
    assert.ok(message, `server sent an invalid message: ${data}`);
    const waiter = waiting.shift();
    if (waiter) {
      waiter(message);
    } else {
      queue.push(message);
    }
  });
  await new Promise<void>((done, fail) => {
    socket.once("open", () => done());
    socket.once("error", fail);
  });
  const next = () => {
    const message = queue.shift();
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise<ServerMessage>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error(`no message within ${NEXT_TIMEOUT_MS} ms`)),
        NEXT_TIMEOUT_MS,
      );
      waiting.push((message) => {
        clearTimeout(timer);
        done(message);
      });
    });
  };
  assert.deepEqual(await next(), { t: "hello", mail: true });
  return {
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    next,
    close: () => socket.close(),
  };
}

test("bounds the notices one IPv6 /48 can send by moving between its /64s (SIG-221)", {}, async (t) => {
  const { url, mails } = await mailServer(t);
  const [networks, each] = [3, 20];
  for (let network = 0; network < networks; network += 1) {
    const client = await connectFrom(t, url, `2001:db8:1:${network.toString(16)}::1`);
    const links = Array.from({ length: each }, linkId);
    client.send({ t: "host", links, turn: false });
    for (const [i, link] of links.entries()) {
      client.send(emailMessage(link, { to: `r${network}-${i}@example.se` }));
    }
    for (const _ of links) {
      assert.equal((await client.next()).t, "email");
    }
    client.close();
  }
  // 60 notices from three /64s of one /48: noticesPerClient (50) must stop the last 10.
  assert.equal(mails.length, 50, `${mails.length} notices went out from one /48`);
});

test("sends a recipient their code although another client asked for codes on its own links to that address (SIG-223)", {}, async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t);
  const sender = await connectFrom(t, url, "192.0.2.1");
  const link = linkId();
  sender.send({ t: "host", links: [link], turn: true });
  sender.send(emailMessage(link));
  const mark = markIn(await sender.next(), link);

  // A stranger with nobody's link registers four of its own to the same address and asks for
  // codes on them. Whether each is sent is the fix's choice, so only the answer is awaited.
  const stranger = await connectFrom(t, url, "198.51.100.8");
  const own = Array.from({ length: 4 }, linkId);
  stranger.send({ t: "host", links: own, turn: true });
  const marks: string[] = [];
  for (const each of own) {
    stranger.send(emailMessage(each));
    const answer = await stranger.next();
    marks.push(answer.t === "email" ? (answer.mark ?? "") : "");
  }
  const asker = await connectFrom(t, url, "198.51.100.8");
  for (let asked = 0; asked < 10; asked += 1) {
    const index = asked % own.length;
    if (asked > 0 && index === 0) {
      t.mock.timers.tick(CODE_GAP_MS);
    }
    asker.send({ t: "send-code", link: own[index], mark: marks[index] || undefined });
    assert.equal((await asker.next()).t, "code");
  }

  const recipient = await connectFrom(t, url, "203.0.113.5");
  recipient.send({ t: "send-code", link, mark });
  assert.deepEqual(await recipient.next(), { t: "code", link, result: "sent" });
});

test("caps the notices and codes the whole server sends in an hour", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url, mails } = await mailServer(t, async () => {}, {
    limits: { noticesTotal: 2, codesTotal: 1 },
  });
  const [a, b, c, d] = [linkId(), linkId(), linkId(), linkId()];
  const host = await mailHost(url, a, b, c, d);
  const marks = [await emailLink(host, a, { to: "a@example.se" })];
  marks.push(await emailLink(host, b, { to: "b@example.se" }));
  host.send(emailMessage(c, { to: "c@example.se" }));
  assert.deepEqual(await host.next(), { t: "email", link: c, status: "limit" });

  const first = await connectFrom(t, url, "192.0.2.1");
  await codeFor(first, host, a, mails, marks[0] ?? "");
  const second = await connectFrom(t, url, "192.0.2.2");
  second.send({ t: "send-code", link: b, mark: marks[1] });
  assert.deepEqual(await second.next(), { t: "code", link: b, result: "wait" });

  t.mock.timers.tick(HOUR_MS);
  await emailLink(host, d, { to: "d@example.se" });
});

test("counts an IPv6 client's notices by its /48", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const { url } = await mailServer(t, async () => {}, { limits: { noticesPerClient: 2 } });
  const statuses: string[] = [];
  for (const [i, network] of ["2001:db8:1:1::1", "2001:db8:1:2::1", "2001:db8:1:3::1"].entries()) {
    const client = await connectFrom(t, url, network);
    const link = linkId();
    client.send({ t: "host", links: [link], turn: false });
    client.send(emailMessage(link, { to: `r${i}@example.se` }));
    const answer = await client.next();
    statuses.push(answer.t === "email" ? answer.status : answer.t);
  }
  assert.deepEqual(statuses, ["sent", "sent", "limit"]);
  // Another /48 is another client.
  const other = await connectFrom(t, url, "2001:db8:2:1::1");
  const link = linkId();
  other.send({ t: "host", links: [link], turn: false });
  other.send(emailMessage(link, { to: "r9@example.se" }));
  assert.equal(markIn(await other.next(), link).length, 22);
});
