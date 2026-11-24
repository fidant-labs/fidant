# 0008: Email recipients

- Status: Accepted
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
- The secret derives both keys (`apps/web/src/lib/keys.ts`): the signal key, which seals the signaling messages, and the file key. Whoever holds the secret can open the sealed signals and read the file while it is sent.
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
| 6. Check words: both screens show the same short words, and the sender confirms them with the recipient before the file goes         | If a party sits in the middle, Fidant included, the two screens show different words. Works with any of the options above. No change to links or mail.                                           | The sender and the recipient must talk while both pages are open. A sender who skips the check gets no protection from it. It does not stop a mail scanner from using up the link.                                                                                                                                           |

Who can read the key under option 3:

- Fidant's server, briefly: the sender's browser sends it the link to put in the mail.
- The mail service: Amazon SES in production, Mailpit locally.
- Anyone who can read the mail in transit.
- The recipient's mailbox provider, for as long as the mail is kept.
- Recipient-side link scanners, for example Microsoft Safe Links, which may rewrite the link and fetch it, fragment included.

Option 4 is rejected: Fidant sets up the peer-to-peer connection with the part it emailed, so it could sit in the middle and receive the rest.

Check words are not an alternative to the others. They can follow any of them as a complementary step. After option 3 they close the gap the key in the email opens: if a server that holds the key sits in the middle, the two screens show different words.

## Decision

Fidant emails the full link, key included, for now (option 3). A one-time code to the same address binds each emailed link to that inbox. Check words (option 6) follow in SIG-109 and close the gap the key in the email opens. A split key (option 4) is rejected above.

### Scope

- This applies to peer-to-peer links only.
- Verified transfers (0002, split key) are untouched. Fidant never emails a fragment half, and 0002's "The fragment half never reaches infrastructure" stands.

### What Fidant sends and keeps

- Email is optional per recipient. A recipient without one works exactly as today.
- The name stays required. It is the sender's label for that recipient and never reaches the server.
- When the sender gives an address, the send page registers the email-bound link with one message on `/signal`. It carries the link ID, the address, the full link, the sender's typed name and the page language.
- The server hands one notice to the mail service. Then it drops the full link and the typed name. The sender's card shows "Email sent" or "Email not sent".
- The notice is plain text. It shows the sender's typed name, marked as not verified, or "Someone" when the name is empty. No mail names the file or gives its size or type.
- The recipient page shows the masked address, for example `a***@example.se`, and asks the recipient to request a code. It shows no sender name before the code is entered.
- The server emails a one-time code to the same address. A correct code gives a token for that browser, and the server tells the sender the link is verified.
- Only then does the recipient page send `join`, carrying the token. The server refuses a `join` on an email-bound link without a valid token. From there the transfer runs as today.
- The token binds verification to the browser, not to the link. A link can be joined again after a decline or a dropped connection, and a forwarded copy must not inherit an earlier verification.
- Codes and outgoing mail are rate-limited. SIG-105 holds the limits.
- The check lives inside signaling, in server memory next to the link. There are no HTTP routes and no database.
- When the sender's socket closes, the server drops the address, the codes and the tokens with the link.

### The mail service

- The leak model below speaks of the mail service. In production that is Amazon SES in eu-north-1. Locally and in tests it is Mailpit, which 0001's stack already lists as the mail catcher.
- AWS already runs the server that sees the key, so SES adds no new company that sees keys.
- Another mail service needs no new record as long as everything here holds for it. It is a new company that sees keys, though, so the issue that switches to it names the service.

### Leak model: replacements to 0001

This record amends 0001 the way 0003 and 0004 did. 0001 and 0002 are not superseded. Read them with these replacements.

| Where 0001 or 0002 says                                                                                                                      | Read                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class K: "the fragment secret, the full key, every derived key (signaling key, file and chunk keys), and the receipt salt. Allowed nowhere." | The same, except the secret of a link Fidant emails. It is allowed in the four places under "The link secret" below. Derived keys, the receipt salt and the ICE pwd stay allowed nowhere. |
| Stack table, mail catcher: "Notices sent by mail, never a key"                                                                               | Notices sent by mail. The notice for a link Fidant emails carries that link's secret. No other mail carries a key.                                                                        |
| Class M: "Labels must never appear in `host` or `join` frames."                                                                              | Unchanged. The label the sender types for a recipient still never reaches the server. The email address is a separate value and replaces nothing here.                                    |
| `from` (0002): "`from` is the name the sender typed for themselves, unverified (SIG-55)."                                                    | Class M for the detector. It is allowed in the four places under "The sender's typed name" below.                                                                                         |
| Exception (a): "AEAD ciphertext under a key no infrastructure holds"                                                                         | The same, read with "Exception (a) and emailed links" below.                                                                                                                              |
| Not secret: "SDP is still encrypted, to protect the DTLS fingerprint against a hostile signaling server swapping it."                        | The same. For an emailed link it does not protect against our own server until check words exist (SIG-109).                                                                               |

#### The link secret

The secret of a link Fidant emails may appear in exactly these four places:

1. the sender's message that registers the email-bound link, on `/signal`;
2. server memory, until the notice is handed to the mail service;
3. the mail service's send request for that notice (SES in production, Mailpit locally);
4. the body of that one notice email to that one address.

It never appears in logs, the code email, the notice's subject, headers or envelope, any server response, signaling to the recipient, DynamoDB, coturn or anywhere else.

#### The sender's typed name

Today it leaves the browser only inside META. For an emailed link it may also appear in exactly these four places:

1. the message that registers the email-bound link;
2. server memory, until the notice is handed to the mail service;
3. the mail service's send request for that notice;
4. the body of that notice.

It never appears in logs, the code email, or anything the server sends to the recipient page. The recipient still reads it from META, as today.

#### The email address

No class in 0001 covers an email address. It is new personal data on the server. It may appear only in:

- the message that registers the email-bound link;
- server memory, for as long as the link is hosted;
- the mail service's send requests for the notice and the codes;
- the envelope, headers and body of mail to that address;
- a masked form, for example `a***@example.se`, in what the server sends to the recipient page.

Rate-limit counters per address hold only an HMAC of the normalized address under a random key per process. They stay in memory for at most an hour. The address is never logged and never written to a database or disk. /privacy and the live server panel list it.

#### Exception (a) and emailed links

For an emailed link the server held the key once. So ciphertext under that key, such as `relay.data` and META, no longer meets "a key no infrastructure holds". It stays exempt in the scan, because the secret itself is the needle: the scan catches it anywhere outside the four places above. What the scan cannot show is a server that kept the key in memory and used it. That is the gap check words close.

Nothing outside these lists is allowed.

### Observation point: Mailpit

- Mail becomes an e2e observation point in SIG-107, pulled forward from SIG-43. It is captured as 0001's table says: the raw source of every message, also decoded (RFC 2047, quoted-printable, base64), envelope included.
- The leak scan allows the link secret in exactly two carriers: the sender's registering frame on `/signal`, which the browser-traffic scan sees, and the body of the notice email for that same link. It fails on the secret anywhere else, including any other email.
- The two carriers cover the four places. Server memory cannot be observed, and Mailpit keeps what the server sent it, so the send request and the notice are one message.
- The scan checks the sender's typed name and the address against their lists above in the same way.
- The deliberate-leak self-test puts a link secret in the code email and asserts that the scan catches it.

## Consequences

- **Fidant can act as the recipient of an emailed link.** With the key, our server can open that link's sealed signals, swap the DTLS fingerprint and sit in the middle of the transfer. The code does not stop that, because Fidant sends the code. The key can be read by Fidant's server while it sends the notice, the mail service, anyone who can read the mail in transit, the recipient's mailbox provider for as long as the mail is kept, and recipient-side link scanners. Senders who do not want this leave the email field empty and pass the link on themselves, as today.
- **Link scanners.** Recipient-side scanners, for example Microsoft Safe Links, may rewrite the link and fetch it, fragment included. This is accepted. The code stops them from using up the link, and check words remove the rest.
- **Site copy.** The landing lede ("nobody in between, us included, can read it") stays. Where the sender enters an email, the send page says that Fidant emails this link, so our server sees its key once and does not store or log it. /terms, /privacy and /security say the key never reaches us, and /about says you need not trust anyone in between, including us. Each states the exception. /privacy also lists the address, and its line that the name you type for yourself never reaches us gets the same exception. /how does not exist yet. SIG-100 builds it, and its copy states the same exception.
- **0001 and 0002** stand, read with the replacements above. 0001 is not superseded.
- **AGENTS.md** names this exception in its opening line and its invariants.
- **SIG-109** adds check words, which close the gap the key in the email opens.
- **SIG-110** decides how the audit log records who verified and received, after SIG-12.
- **SIG-107** wires Mailpit as an e2e observation point. The e2e README's table of observation points lists mail under SIG-107 instead of SIG-43.
- **SIG-108** sets up SES: a domain identity, DNS records, a credential for the app on the box and production access. 0003 already accepts an IAM access key on the box.
