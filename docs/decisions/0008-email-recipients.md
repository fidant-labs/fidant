# 0008: Email recipients

- Status: Proposed
- Date: 2026-11-24
- Linear: SIG-105

## Context

### What we want

- Until BankID exists, bind each peer-to-peer download to an email address.
- The sender can give a recipient an email address. Fidant then emails that recipient their personal link. When the recipient opens it, they ask for a one-time code, which goes to the same address, and enter it. Only then can their browser connect to the sender.
- Recipients without an email work exactly as today.
- The code proves the recipient controls the inbox. It stops a forwarded or leaked link from working, and it stops mail scanners from using up the link. It does not stop someone who can already read that inbox.

### How it works today

- Transfers are peer-to-peer only. The sender's tab must stay open, and nothing is stored.
- A recipient link is `https://<origin>/r/<linkId>#<secret>` (`apps/web/src/lib/link.ts`). The link ID is 16 random bytes and the only part the server sees. The secret is 32 random bytes in the URL fragment.
- The secret derives both keys (`apps/web/src/lib/keys.ts`): the signal key, which seals the signaling messages, and the file key. Whoever holds the secret can open the sealed signals and read the file.
- The server (`apps/server/src/signaling.ts`) relays the sealed signaling messages over `/signal`. It holds the hosted link IDs in memory, binds at most one guest to each, and stores nothing.
- The send page registers its links with `{t:"host", links:[...]}` and sends the full set again on every change. The recipient page sends `{t:"join", link, attempt}` as soon as it loads. So anything that opens a link and runs the page joins at once, a mail scanner included.
- A link is used once the recipient's checksum matches. After a decline, a checksum failure, a dropped connection or a timeout it can be joined again (`apps/web/src/lib/sender-state.ts`).
- Recipient names exist only in the sender's browser (`RecipientList.tsx`, `sender-state.ts`). The sender's typed name travels only inside the encrypted META frame.
- The sender passes each link on. /privacy says: "You send the link yourself, for example by email or chat."
- Nothing sends mail yet. 0001's local stack has a mail catcher, and its observation points name Mailpit, but mail is not yet an e2e observation point: the e2e README assigns it to SIG-43.
- 0003 plans an IAM access key for the app on the Lightsail box, which has no instance roles. 0004 makes DynamoDB the one store. SIG-12 (the audit log) is not built.

### What the rules say today

- AGENTS.md: "Never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them." And: "Keys live only in the URL fragment or in browser memory." Its one exception is the server half of a verified transfer's split key.
- 0001 puts the fragment secret and every key derived from it in class K: "Allowed nowhere."
- 0001's local stack describes the mail catcher as "Notices sent by mail, never a key".
- 0001 encrypts SDP under the link key so that a hostile signaling server cannot swap the DTLS fingerprint. Its exception (a) treats "AEAD ciphertext under a key no infrastructure holds" as not secret, which covers `relay.data`. Both rest on the server never holding the secret. 0002 says the same of verified transfers: "The fragment half never reaches infrastructure".
- 0001 puts "recipient labels the sender types in P2P mode" in class M: "Labels must never appear in `host` or `join` frames." No class covers an email address.
- The site copy:
  - landing lede: "nobody in between, us included, can read it";
  - /terms: "we never have the key";
  - /privacy, under "Never": "The part of the link that unlocks the file never reaches us.", and for names, "Neither the name you type for yourself nor the names of the people you send to.";
  - /security: "The key is in the part of the link after #, which browsers never send to a server."

## Options considered

| Option                                                                                                                               | For                                                                                                                                                                                              | Against                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The sender's own mail app sends the link (`mailto:`)                                                                              | The key never reaches Fidant, so the rules stand. No mail service to run. The mail comes from the sender's own address.                                                                          | The key still travels by mail: the sender's and the recipient's mail providers, mail in transit and recipient-side link scanners can read it. A sender on webmail often has no mail app set up, so `mailto:` may open nothing. Fidant cannot tell whether the mail went out. Senders can already paste the link into a mail. |
| 2. Fidant sends a notice without the link                                                                                            | No key in Fidant's mail, so "never a key" holds as written. The code can still go to the same address.                                                                                           | The sender still sends the link some other way, and the key travels wherever they send it. The recipient gets two messages for one file and must match them up.                                                                                                                                                              |
| 3. Fidant emails the full link, key included                                                                                         | One step for the sender: type an address. The link and the code go to the same inbox. Nothing is stored, so a key in an old mail opens nothing once the link is used or the sender's tab closes. | The key leaves the browser (see below). It breaks the AGENTS.md key rules, 0001's class K and the site copy above. With the key, Fidant's server can open that link's sealed signals, swap the DTLS fingerprint and sit in the middle of the transfer. The code does not stop that, because Fidant sends the code.           |
| 4. A key split between the email and the peer-to-peer connection                                                                     | The mail never holds the whole key.                                                                                                                                                              | Fidant sets up that connection through signaling, with the part it emailed, so it could sit in the middle and receive the rest. More key code for no gain over option 3.                                                                                                                                                     |
| 5. A short code with a PAKE: the sender gives the recipient a short code, for example by phone, and the browsers agree a key from it | No key in the link or the mail. Fidant cannot sit in the middle without guessing the code, and a wrong guess fails that attempt.                                                                 | The sender must pass a code to every recipient through a second channel. WebCrypto has no PAKE, so it needs a library or our own implementation, and its review. It changes how links and keys are made (`link.ts`, `keys.ts`).                                                                                              |
| 6. Check words: both screens show the same short words, and the sender confirms them with the recipient before the file goes         | A party in the middle, Fidant included, shows different words on the two screens. Works with any of the options above. No change to links or mail.                                               | The sender and the recipient must talk while both pages are open. A sender who skips the check gets no protection from it. It does not stop a mail scanner from using up the link.                                                                                                                                           |

Who can read the key under option 3:

- Fidant's server, briefly: the sender's browser sends it the link to put in the mail.
- The mail service: Amazon SES in production, Mailpit locally.
- Anyone who can read the mail in transit.
- The recipient's mailbox provider, for as long as the mail is kept.
- Recipient-side link scanners, for example Microsoft Safe Links, which may rewrite the link and fetch it, fragment included.

Option 4 is rejected: Fidant sets up the peer-to-peer connection with the part it emailed, so it could sit in the middle and receive the rest.

Check words are not an alternative to the others. They can follow any of them as a complementary step. After option 3 they close the gap the key in the email opens: if a server that holds the key sits in the middle, the two screens show different words.
