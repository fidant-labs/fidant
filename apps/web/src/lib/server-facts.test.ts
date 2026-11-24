import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../i18n/en.ts";
import { sv } from "../i18n/sv.ts";
import { formatBytes } from "./format.ts";
import { addRelay, NO_RELAYS, type Relayed } from "./server-facts.ts";

const { recipientHolds, senderAfterwards, senderHolds } = en.server;
const passedOn = (relayed: Relayed) =>
  en.server.passedOn(relayed.messages, formatBytes(relayed.bytes, "en"));

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

test("senderHolds follows links, connections, the relay choice and the server connection", () => {
  assert.equal(
    senderHolds({ online: true, links: 0, connected: 0, relay: true }),
    "No links yet. Your choice to allow our relay.",
  );
  assert.equal(
    senderHolds({ online: true, links: 0, connected: 0, relay: false }),
    "No links yet. Your choice not to allow our relay.",
  );
  assert.equal(
    senderHolds({ online: true, links: 1, connected: 0, relay: true }),
    "The ID of your link, never the part that unlocks the file. Your choice to allow our relay.",
  );
  assert.equal(
    senderHolds({ online: true, links: 3, connected: 1, relay: false }),
    "The IDs of your 3 links, never the part that unlocks the file. Your choice not to allow our relay. 1 recipient connected right now.",
  );
  assert.equal(
    senderHolds({ online: true, links: 3, connected: 2, relay: true }),
    "The IDs of your 3 links, never the part that unlocks the file. Your choice to allow our relay. 2 recipients connected right now.",
  );
  assert.equal(
    senderHolds({ online: false, links: 3, connected: 1, relay: false }),
    "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.",
  );
});

test("senderAfterwards for an open and a lost server connection", () => {
  assert.equal(
    senderAfterwards(true),
    "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay.",
  );
  assert.equal(
    senderAfterwards(false),
    "Your links are gone from the server within a minute of the connection closing. Its log lines stay.",
  );
});

test("recipientHolds for a paired, unpaired and closed page", () => {
  assert.equal(
    recipientHolds("paired"),
    "The ID of your link, never the part that unlocks the file, and that this page is connected to the sender.",
  );
  assert.equal(
    recipientHolds("unpaired"),
    "Nothing that ties this page to your link. Only the sender's page can keep your link's ID there.",
  );
  assert.equal(
    recipientHolds("closed"),
    "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped. Only the sender's page can keep your link's ID there.",
  );
});

test("the Swedish server text counts and picks singular or plural", () => {
  assert.equal(sv.server.passedOn(0, ""), "Inget ännu.");
  assert.equal(
    sv.server.passedOn(1, formatBytes(310, "sv")),
    "1 uppkopplingsmeddelande (310 byte), alla krypterade så att servern inte kan läsa dem.",
  );
  assert.equal(
    sv.server.passedOn(14, formatBytes(9200, "sv")),
    "14 uppkopplingsmeddelanden (9,2 KB), alla krypterade så att servern inte kan läsa dem.",
  );
  assert.equal(
    sv.server.senderHolds({ online: true, links: 0, connected: 0, relay: false }),
    "Inga länkar ännu. Ditt val att inte tillåta vårt relä.",
  );
  assert.equal(
    sv.server.senderHolds({ online: true, links: 1, connected: 1, relay: true }),
    "ID:t för din länk, aldrig den del som låser upp filen. Ditt val att tillåta vårt relä. 1 mottagare är ansluten just nu.",
  );
  assert.equal(
    sv.server.senderHolds({ online: true, links: 3, connected: 2, relay: false }),
    "ID:na för dina 3 länkar, aldrig den del som låser upp filen. Ditt val att inte tillåta vårt relä. 2 mottagare är anslutna just nu.",
  );
});
