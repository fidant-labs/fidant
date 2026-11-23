import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addRelay,
  LOG_FIELD_PHRASES,
  LOGS,
  NO_RELAYS,
  passedOn,
  recipientHolds,
  senderHolds,
} from "./server-facts.ts";

test("passedOn says nothing yet, then counts with singular and plural", () => {
  assert.equal(passedOn(NO_RELAYS), "Nothing yet.");
  assert.equal(
    passedOn(addRelay(NO_RELAYS, 310)),
    "1 setup message (310 bytes), all encrypted so the server can't read them.",
  );
  assert.equal(
    passedOn({ messages: 14, bytes: 9200 }),
    "14 setup messages (9.2 KB), all encrypted so the server can't read them.",
  );
});

test("addRelay adds one message and its bytes without mutating", () => {
  const before = { messages: 2, bytes: 10 };
  assert.deepEqual(addRelay(before, 5), { messages: 3, bytes: 15 });
  assert.deepEqual(before, { messages: 2, bytes: 10 });
});

test("senderHolds follows links, connections and the server connection", () => {
  assert.equal(senderHolds({ online: true, links: 0, connected: 0 }), "No links yet.");
  assert.equal(
    senderHolds({ online: true, links: 1, connected: 0 }),
    "The ID of your link, never the part that unlocks the file.",
  );
  assert.equal(
    senderHolds({ online: true, links: 3, connected: 1 }),
    "The IDs of your 3 links, never the part that unlocks the file. 1 recipient connected right now.",
  );
  assert.equal(
    senderHolds({ online: true, links: 3, connected: 2 }),
    "The IDs of your 3 links, never the part that unlocks the file. 2 recipients connected right now.",
  );
  assert.equal(
    senderHolds({ online: false, links: 3, connected: 1 }),
    "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.",
  );
});

test("recipientHolds while active and after the attempt ends", () => {
  assert.equal(
    recipientHolds(true),
    "The ID of your link, never the part that unlocks the file, and that this page is connected to the sender.",
  );
  assert.equal(
    recipientHolds(false),
    "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped. Only the sender's page can keep your link's ID there.",
  );
});

test("LOGS names every log field phrase", () => {
  for (const phrase of Object.values(LOG_FIELD_PHRASES)) {
    assert.ok(LOGS.includes(phrase), phrase);
  }
});
