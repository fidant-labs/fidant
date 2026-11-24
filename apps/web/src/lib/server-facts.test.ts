import assert from "node:assert/strict";
import { test } from "node:test";
import { en } from "../i18n/en.ts";
import { sv } from "../i18n/sv.ts";
import { formatBytes } from "./format.ts";
import { addRelay, NO_RELAYS, type Relayed } from "./server-facts.ts";

const { recipientHolds, senderAfterwards, senderHolds } = en.server;
const PLAIN = { emailed: 0, sending: 0, mailed: false, kind: "file" } as const;
const passedOn = (relayed: Relayed) =>
  en.server.passedOn(relayed.messages, formatBytes(relayed.bytes, "en"), false);

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
    senderHolds({ online: true, links: 0, connected: 0, relay: true, ...PLAIN }),
    "No links yet. Your choice to allow our relay.",
  );
  assert.equal(
    senderHolds({ online: true, links: 0, connected: 0, relay: false, ...PLAIN }),
    "No links yet. Your choice not to allow our relay.",
  );
  assert.equal(
    senderHolds({ online: true, links: 1, connected: 0, relay: true, ...PLAIN }),
    "The ID of your link, never the part that unlocks the file. Your choice to allow our relay.",
  );
  assert.equal(
    senderHolds({ online: true, links: 3, connected: 1, relay: false, ...PLAIN }),
    "The IDs of your 3 links, never the part that unlocks the file. Your choice not to allow our relay. 1 recipient connected right now.",
  );
  assert.equal(
    senderHolds({ online: true, links: 3, connected: 2, relay: true, ...PLAIN }),
    "The IDs of your 3 links, never the part that unlocks the file. Your choice to allow our relay. 2 recipients connected right now.",
  );
  assert.equal(
    senderHolds({ online: false, links: 3, connected: 1, relay: false, ...PLAIN }),
    "Nothing once it notices the connection has closed. That takes up to a minute if the network dropped.",
  );
});

test("senderAfterwards for an open and a lost server connection", () => {
  assert.equal(
    senderAfterwards(true, false),
    "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay.",
  );
  assert.equal(
    senderAfterwards(false, false),
    "Your links are gone from the server within a minute of the connection closing. Its log lines stay.",
  );
});

test("recipientHolds for a paired, unpaired and closed page", () => {
  assert.equal(
    recipientHolds("paired", false, "file"),
    "The ID of your link, never the part that unlocks the file, and that this page is connected to the sender.",
  );
  assert.equal(
    recipientHolds("unpaired", false, "file"),
    "Nothing that ties this page to your link. Only the sender's page can keep your link's ID there.",
  );
  assert.equal(
    recipientHolds("closed", false, "file"),
    "Nothing about this page once it notices the connection has closed, which takes up to a minute if the network dropped. Only the sender's page can keep your link's ID there.",
  );
});

test("the Swedish server text counts and picks singular or plural", () => {
  assert.equal(sv.server.passedOn(0, "", false), "Inget ännu.");
  assert.equal(
    sv.server.passedOn(1, formatBytes(310, "sv"), false),
    "1 uppkopplingsmeddelande (310 byte), alla krypterade så att servern inte kan läsa dem.",
  );
  assert.equal(
    sv.server.passedOn(14, formatBytes(9200, "sv"), false),
    "14 uppkopplingsmeddelanden (9,2 KB), alla krypterade så att servern inte kan läsa dem.",
  );
  assert.equal(
    sv.server.senderHolds({ online: true, links: 0, connected: 0, relay: false, ...PLAIN }),
    "Inga länkar ännu. Ditt val att inte tillåta vårt relä.",
  );
  assert.equal(
    sv.server.senderHolds({ online: true, links: 1, connected: 1, relay: true, ...PLAIN }),
    "ID:t för din länk, aldrig den del som låser upp filen. Ditt val att tillåta vårt relä. 1 mottagare är ansluten just nu.",
  );
  assert.equal(
    sv.server.senderHolds({ online: true, links: 3, connected: 2, relay: false, ...PLAIN }),
    "ID:na för dina 3 länkar, aldrig den del som låser upp filen. Ditt val att inte tillåta vårt relä. 2 mottagare är anslutna just nu.",
  );
});

test("an emailed link adds what the server holds for it and how long its counts stay", () => {
  const online = { online: true, connected: 0, relay: true, kind: "file" } as const;
  assert.equal(
    senderHolds({ ...online, links: 2, emailed: 1, sending: 1, mailed: true }),
    "The IDs of your 2 links. For the link it emails: the recipient's email address and the codes sent there. While it sends an email, also the part of that link that unlocks the file, and your name. Your choice to allow our relay. Scrambled counts of the emails it sent for you, for up to an hour.",
  );
  assert.equal(
    senderHolds({ ...online, links: 3, emailed: 2, sending: 0, mailed: true }),
    "The IDs of your 3 links, never the part that unlocks the file. For the 2 links it emails: the recipients' email addresses and the codes sent there. Your choice to allow our relay. Scrambled counts of the emails it sent for you, for up to an hour.",
  );
  assert.equal(
    senderHolds({ ...online, links: 0, emailed: 0, sending: 0, mailed: true }),
    "No links yet. Your choice to allow our relay. Scrambled counts of the emails it sent for you, for up to an hour.",
  );
  assert.equal(
    senderHolds({ ...online, online: false, links: 0, emailed: 0, sending: 0, mailed: true }),
    "Only scrambled counts of the emails it sent for you, for up to an hour, once it notices the connection has closed. That takes up to a minute if the network dropped.",
  );
  assert.equal(
    senderAfterwards(true, true),
    "When you close this tab, the server forgets your links, within a minute at most. Its log lines stay. So do scrambled counts of the emails it sent for you, for up to an hour.",
  );
  assert.equal(
    en.server.passedOn(2, "1 KB", true),
    "2 setup messages (1 KB), all encrypted so the server can't read them, except for a link it emailed, whose key it had.",
  );
  assert.equal(
    recipientHolds("paired", true, "file"),
    "The ID of your link, your email address, that this tab entered the right code, and that this page is connected to the sender. It had the part that unlocks the file only while it emailed you the link.",
  );
  assert.equal(
    recipientHolds("unpaired", true, "file"),
    "Your email address, which the sender gave for this link, the latest code it emailed you and whether this tab entered it. Only the sender's page can keep them there.",
  );
  assert.ok(
    recipientHolds("closed", true, "file").startsWith("Nothing about this page once it notices"),
  );
  assert.ok(en.server.afterwardsRecipient(true).includes("for up to an hour"));
});

test("the Swedish text for an emailed link", () => {
  const online = { online: true, connected: 1, relay: false, kind: "file" } as const;
  assert.equal(
    sv.server.senderHolds({ ...online, links: 1, emailed: 1, sending: 1, mailed: true }),
    "ID:t för din länk. För länken den mejlar: mottagarens e-postadress och koderna som skickas dit. Medan den skickar ett mejl också den del av länken som låser upp filen, och ditt namn. Ditt val att inte tillåta vårt relä. Antalet mejl den skickade åt dig, i förvrängd form, i upp till en timme. 1 mottagare är ansluten just nu.",
  );
  assert.equal(
    sv.server.senderHolds({ ...online, links: 3, emailed: 2, sending: 0, mailed: true }),
    "ID:na för dina 3 länkar, aldrig den del som låser upp filen. För de 2 länkar den mejlar: mottagarnas e-postadresser och koderna som skickas dit. Ditt val att inte tillåta vårt relä. Antalet mejl den skickade åt dig, i förvrängd form, i upp till en timme. 1 mottagare är ansluten just nu.",
  );
  assert.equal(
    sv.server.passedOn(1, formatBytes(310, "sv"), true),
    "1 uppkopplingsmeddelande (310 byte), alla krypterade så att servern inte kan läsa dem, utom för en länk som den har mejlat och därför haft nyckeln till.",
  );
  assert.ok(sv.server.recipientHolds("paired", true, "file").includes("din e-postadress"));
  assert.ok(sv.server.senderAfterwards(false, true).endsWith("i upp till en timme."));
});

test("the server panel text names a secret, not a file, for a secret", () => {
  assert.equal(
    recipientHolds("paired", false, "secret"),
    "The ID of your link, never the part that unlocks the secret, and that this page is connected to the sender.",
  );
  assert.equal(
    recipientHolds("paired", false, "unknown"),
    "The ID of your link, never the part that unlocks what is shared, and that this page is connected to the sender.",
  );
  assert.equal(en.server.fileData("secret"), "None. The secret goes directly between browsers.");
  assert.equal(sv.server.fileData("secret"), "Inget. Hemligheten går direkt mellan webbläsarna.");
  const sender = {
    online: true,
    links: 1,
    connected: 0,
    relay: true,
    ...PLAIN,
    kind: "secret",
  } as const;
  assert.ok(!/file/i.test(senderHolds(sender)));
  assert.ok(!/fil/i.test(sv.server.senderHolds(sender)));
});

test("no server panel string names a file for a secret", () => {
  const sender = { online: true, links: 2, connected: 1, relay: true, kind: "secret" } as const;
  const strings = [
    [/\bfiles?\b/i, en.server],
    [/\bfil(en|er|erna)?\b/i, sv.server],
  ] as const;
  for (const [pattern, s] of strings) {
    for (const text of [
      s.fileDataLabel("secret"),
      s.fileData("secret"),
      s.fileDataRelayed("secret"),
      s.relaySees("secret"),
      s.relayLogs("secret"),
      s.relayKeeps("secret"),
      s.logs("secret"),
      s.senderHolds({ ...sender, emailed: 0, sending: 0, mailed: false }),
      s.senderHolds({ ...sender, emailed: 1, sending: 1, mailed: true }),
      s.senderHolds({ ...sender, emailed: 2, sending: 0, mailed: true }),
      s.senderHolds({ ...sender, online: false, emailed: 0, sending: 0, mailed: true }),
      ...(["paired", "unpaired", "closed"] as const).flatMap((tie) => [
        s.recipientHolds(tie, false, "secret"),
        s.recipientHolds(tie, true, "secret"),
      ]),
    ]) {
      assert.doesNotMatch(text, pattern);
    }
  }
});
