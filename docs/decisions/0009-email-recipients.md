# 0009: Email recipients

- Status: Accepted
- Date: 2026-11-24
- Linear: SIG-105

## Context

### What we want

- Until BankID exists, bind a peer-to-peer download to an email address when the sender gives one.
- The sender can give a recipient an email address. Fidant then emails that recipient their personal link. When the recipient opens it, they ask for a one-time code, which goes to the same address, and enter it. Only then can their browser connect to the sender.
- Recipients without an email work exactly as today.
- The code proves the recipient controls the inbox. It stops a forwarded or leaked link from working, and it stops mail scanners from holding the link. It does not stop someone who can already read that inbox.

### How it works today

- Transfers are peer-to-peer only. The sender's tab must stay open, and nothing is stored.
- A recipient link is `<origin>/r/<linkId>#<secret>` (`apps/web/src/lib/link.ts`). The link ID is 16 random bytes and the only part the server sees. The secret is 32 random bytes in the URL fragment.
- The secret derives both keys (`apps/web/src/lib/keys.ts`): the signal key, which seals the signaling messages, and the file key. Whoever holds the secret can open the sealed signals and read the file while it is sent.
- The server (`apps/server/src/signaling.ts`) relays the sealed signaling messages over `/signal`. It holds the hosted link IDs in memory, binds at most one guest to each, and stores nothing.
- The send page registers its links with `{t:"host", links:[...], turn}` and sends the full set again on every change. The recipient page sends `{t:"join", link, attempt}` as soon as it loads. So anything that opens a link and runs the page joins at once, a mail scanner included.
- A link is used once the recipient's checksum matches. After a decline, a checksum failure, a dropped connection or a timeout it can be joined again (`apps/web/src/lib/sender-state.ts`).
- Recipient names exist only in the sender's browser (`RecipientList.tsx`, `sender-state.ts`). The sender's typed name travels only inside the encrypted META frame.
- The sender passes each link on. /privacy says: "You send the link yourself, for example by email or chat."
- Nothing sends mail yet. 0001's local stack has a mail catcher, and its observation points name Mailpit, but mail is not yet an e2e observation point: the e2e README assigns it to SIG-43.
- 0003 plans an IAM access key for the app on the Lightsail box, which has no instance roles. 0004 makes DynamoDB the one store. SIG-12 (the audit log) is not built.

### What the rules say today

- AGENTS.md: "Never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them." And: "Keys live only in the URL fragment or in browser memory." Its two exceptions are the BankID receipt text, which names the file, and the server half of a verified transfer's split key.
- 0001 puts the fragment secret and every key derived from it in class K: "Allowed nowhere."
- 0001's local stack describes the mail catcher as "Notices sent by mail, never a key".
- 0001 encrypts SDP under the link key so that a hostile signaling server cannot swap the DTLS fingerprint. Its exception (a) treats "AEAD ciphertext under a key no infrastructure holds" as not secret, which covers `relay.data`. Both rest on the server never holding the secret. 0002 says the same of verified transfers: "The fragment half never reaches infrastructure".
- 0001 puts "recipient labels the sender types in P2P mode" in class M: "Labels must never appear in `host` or `join` frames." No class covers an email address.
- The site copy:
  - landing lede: "nobody in between, us included, can read it";
  - /terms: "we never have the key";
  - /privacy, under "Never": "The part of the link that unlocks the file never reaches us.", and for names, "Neither the name you type for yourself nor the names of the people you send to.";
  - /security: "The key is in the part of the link after #, which browsers never send to a server.";
  - /about, lede: "Fidant is a way to send a file to someone without trusting anyone in between, including us.";
  - /how: "Browsers never send that part to us, so we never see the key."

## Options considered

| Option                                                                                                                               | For                                                                                                                                                                                              | Against                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. The sender's own mail app sends the link (`mailto:`)                                                                              | The key never reaches Fidant, so the rules stand. No mail service to run. The mail comes from the sender's own address.                                                                          | The key still travels by mail: the sender's and the recipient's mail providers, mail in transit and recipient-side link scanners can read it. A sender on webmail often has no mail app set up, so `mailto:` may open nothing. Fidant cannot tell whether the mail went out. Senders can already paste the link into a mail. |
| 2. Fidant sends a notice without the link                                                                                            | No key in Fidant's mail, so "never a key" holds as written. The code can still go to the same address.                                                                                           | The sender still sends the link some other way, and the key travels wherever they send it. The recipient gets two messages for one file and must match them up.                                                                                                                                                              |
| 3. Fidant emails the full link, key included                                                                                         | One step for the sender: type an address. The link and the code go to the same inbox. Nothing is stored, so a key in an old mail opens nothing once the link is used or the sender's tab closes. | The key leaves the browser (see below). It breaks the AGENTS.md key rules, 0001's class K and the site copy above. With the key, Fidant's server can open that link's sealed signals, swap the DTLS fingerprint and sit in the middle of the transfer. The code does not stop that, because Fidant sends the code.           |
| 4. A key split between the email and the peer-to-peer connection                                                                     | The mail never holds the whole key.                                                                                                                                                              | Fidant sets up that connection through signaling, with the part it emailed, so it could sit in the middle and receive the rest. More key code for no gain over option 3.                                                                                                                                                     |
| 5. A short code with a PAKE: the sender gives the recipient a short code, for example by phone, and the browsers agree a key from it | No key in the link or the mail. Fidant cannot sit in the middle without guessing the code, and a wrong guess fails that attempt.                                                                 | The sender must pass a code to every recipient through a second channel. WebCrypto has no PAKE, so it needs a library or our own implementation, and its review. It changes how links and keys are made (`link.ts`, `keys.ts`).                                                                                              |
| 6. Check words: both screens show the same short words, and the sender confirms them with the recipient before the file goes         | If a party sits in the middle, Fidant included, the two screens show different words. Works with any of the options above. No change to links or mail.                                           | The sender and the recipient must talk while both pages are open. A sender who skips the check gets no protection from it. It does not stop a mail scanner from holding the link.                                                                                                                                            |

Who can read the key under option 3:

- Fidant's server, briefly: the sender's browser sends it the secret, and the server builds the link to put in the mail.
- The mail service: Amazon SES in production, Mailpit locally.
- Anyone who can read the mail in transit.
- The recipient's mailbox provider, for as long as the mail is kept.
- Recipient-side link scanners, for example Microsoft Safe Links, which may rewrite the link and fetch it, fragment included.

Check words close the gap only if both screens derive them from the DTLS certificate fingerprints that each browser's own connection used, never from the link secret or any value the server can choose. The server must also be unable to pick its certificate after it learns what the words depend on: the words need a commitment first, as in ZRTP's short authentication string, or enough bits that no search finishes while the handshake waits. SIG-109 must meet both.

## Decision

Fidant emails the full link, key included, for now (option 3). A one-time code to the same address binds each emailed link to that inbox. Check words (option 6) follow in SIG-109 and close the gap the key in the email opens. A split key (option 4) is rejected for the reason in its row.

### Scope

- This applies to peer-to-peer links only.
- Verified transfers (0002, split key) are untouched. Fidant never emails a fragment half, and 0002's "The fragment half never reaches infrastructure" stands.

### What Fidant sends and keeps

- Email is optional per recipient. A recipient without one works exactly as today.
- The name stays required. It is the sender's label for that recipient and never reaches the server.
- When the sender gives an address, the send page registers the email-bound link with one message on `/signal`. It carries the link ID, the address, the link's secret, the sender's typed name and the page language. The server builds the link from its configured public origin, never from anything in the request, and the link ID, so it can only email links to this site.
- Later `host` messages carry the link ID, never the secret, the address or the typed name. `host` cannot create an email binding. Unhosting a link, by a `host` that leaves it out or by closing the socket, drops its binding with everything else.
- The server refuses a second registering message for a link ID, a registering message for a link that socket does not host, and any change to the address of a link that is already email-bound. To send again, the sender removes the recipient and adds them again, which makes a new link.
- The server refuses a registering message unless the link ID is a valid link ID, the secret has the link secret's exact form (43 base64url characters), the address is one plain address (no CR, LF, comma, angle bracket or whitespace), the typed name passes the rule below, and the language is one the site ships.
- The server refuses a registering message whose typed name breaks META's `from` rule (the length cap, no control or direction characters) or contains a line or paragraph separator (U+2028, U+2029), so nobody can forge lines after the not-verified marker in mail Fidant signs. The typed name goes only in the notice body, never in the notice's subject, headers or envelope.
- The server makes one attempt to hand one notice to the mail service, with a timeout. At most one notice goes out per link, and none when the server refuses the message or the attempt fails. The secret and the typed name stay in server memory only until the server refuses the message, the attempt ends (success or failure), or the sender's socket closes, whichever comes first. The server never keeps them for a retry. The sender's card shows "Email sent" or "Email not sent".
- The notice is plain text. It shows the sender's typed name, marked as not verified, or "Someone" when the name is empty. No mail names the file or gives its size or type.
- The recipient page shows the masked address, for example `a***@example.se`, and asks the recipient to request a code. It shows no sender name before the code is entered.
- The server emails a one-time code to the same address. A correct code gives a token for that browser, and the server tells the sender the link is verified.
- Only then does the recipient page send `join`, carrying the token. The server refuses a `join` on an email-bound link without a valid token. From there the transfer runs as today.
- The token is bound to that link and that browser. It survives a rejoin of the same link from the same browser, and it is refused on any other link and in any other browser. A link can be joined again after a decline or a dropped connection, and a forwarded copy must not inherit an earlier verification.
- Codes and outgoing mail are rate-limited. Wrong guesses per code are capped, and a code expires. SIG-105 holds the limits.
- The check lives inside signaling, in server memory next to the link. There are no HTTP routes and no database.
- When the sender's socket closes, the server drops the address, the secret, the typed name, the codes and the tokens with the link.

### The mail service

- The leak model below speaks of the mail service. In production that is Amazon SES in eu-north-1. Locally and in tests it is Mailpit.
- AWS already runs the server that sees the key, so SES adds no new company that sees keys.
- The notice's From address is on a sending subdomain whose domain publishes a null MX, and the notice has no Reply-To, so replies never reach a mailbox.
- Bounces and complaints go back to the mail service itself (its own bounce domain as MAIL FROM, or a custom MAIL FROM whose only MX is the mail service's feedback endpoint). They never reach a mailbox that Fidant or another company keeps: no feedback forwarding by email, and any bounce or complaint notification goes to a channel that stores nothing and has no email subscription.
- The mail service does not keep the address after delivery, for example in a suppression list, unless /privacy states how long it keeps it.
- Another mail service needs no new record as long as everything here holds for it. It is a new company that sees keys, though, so the issue that switches to it names the service.

### Leak model: replacements to 0001 and 0002

This record amends 0001 and 0002 the way 0003 and 0004 did. 0001 and 0002 are not superseded. Read them with these replacements.

| Where 0001 or 0002 says                                                                                                                      | Read                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class K: "the fragment secret, the full key, every derived key (signaling key, file and chunk keys), and the receipt salt. Allowed nowhere." | The same, except the secret of a link Fidant emails. It is allowed in the four places under "The link secret" below. Derived keys, the receipt salt and the ICE pwd stay allowed nowhere. |
| Stack table, mail catcher: "Notices sent by mail, never a key"                                                                               | Notices sent by mail. The notice for a link Fidant emails carries that link's secret. No other mail carries a key.                                                                        |
| Class M: "Labels must never appear in `host` or `join` frames."                                                                              | Unchanged. The label the sender types for a recipient still never reaches the server. The email address is a separate value and replaces nothing here.                                    |
| `from` (0002): "`from` is the name the sender typed for themselves, unverified (SIG-55)."                                                    | The same, and: class M for the detector in peer-to-peer mode. For an emailed link it is also allowed in the places under "The sender's typed name" below.                                 |
| Exception (a): "AEAD ciphertext under a key no infrastructure holds"                                                                         | The same, read with "Exception (a) and emailed links" below.                                                                                                                              |
| Not secret: "SDP is still encrypted, to protect the DTLS fingerprint against a hostile signaling server swapping it."                        | The same. For an emailed link it does not protect against our own server until check words exist (SIG-109).                                                                               |

#### The link secret

The secret of a link Fidant emails may appear in exactly these four places:

1. the sender's message that registers the email-bound link, on `/signal`;
2. server memory, only until the server refuses the message, its one send attempt ends (successfully or not), or the sender's socket closes;
3. the mail service's send request for that notice (SES in production, Mailpit locally);
4. the body of the one notice email for that link, to that one address.

It never appears in logs, the code email, the notice's subject, headers or envelope, any server response, signaling to the recipient, DynamoDB, coturn or anywhere else.

#### The sender's typed name

Today it leaves the browser only inside META. For an emailed link it may also appear in exactly these four places:

1. the message that registers the email-bound link;
2. server memory, only until the server refuses the message, its one send attempt ends (successfully or not), or the sender's socket closes;
3. the mail service's send request for that notice;
4. the body of that notice.

It never appears in logs, the code email, the notice's subject, headers or envelope, or anything the server sends to the recipient page. The recipient still reads it from META, as today.

#### The email address

No class in 0001 covers an email address. It is new personal data on the server. It may appear only in:

- the message that registers the email-bound link;
- server memory, for as long as the link is hosted;
- the mail service's send requests for the notice and the codes;
- the envelope, headers and body of mail to that address;
- a masked form, for example `a***@example.se`, in what the server sends to the recipient page;
- the mail service's bounce and complaint handling, which stores nothing;
- the mail service's suppression list, only if /privacy states how long it keeps it.

The one-time code and the token are secrets too, and neither is ever logged. The code appears only in the code email, the recipient's message that submits it and server memory. The token appears only in the server's reply to that browser, that browser's storage and its `join`, and server memory.

Rate-limit counters per address hold only an HMAC of the normalized address under a random key per process. They stay in memory for at most an hour. The address is never logged and never written to a database or disk. /privacy and the live server panel list it.

Nothing outside these lists is allowed.

#### Exception (a) and emailed links

For an emailed link the server held the key once. So ciphertext under that key, such as `relay.data` and META, no longer meets "a key no infrastructure holds". It stays exempt in the scan, because the secret itself is the needle: the scan catches it anywhere outside the four places above. What the scan cannot show is a server that kept the key in memory and used it. That is the gap check words close.

### Observation point: Mailpit

- Mail becomes an e2e observation point in SIG-107, pulled forward from SIG-43. It is captured as 0001's Mail observation point says.
- The server reaches the mail service over SMTP in tests and in production, so the e2e scan sees the same send path.
- The leak scan allows the link secret in exactly two carriers: the sender's registering frame on `/signal`, which the browser-traffic scan sees, and the notice email for that same link. At most one message, the notice for that link, carries the link secret. Its only envelope recipient and its To are the registered address, it has no Cc or Bcc, and the secret is allowed only in its body, raw or decoded, never in its headers or envelope. The scan fails on the secret anywhere else, including any other email.
- The two carriers cover the four places. Server memory cannot be observed, and Mailpit keeps what the server sent it, so the send request and the notice are one message.
- The scan checks the sender's typed name and the address against their lists above in the same way.
- The deliberate-leak self-test puts a link secret in the code email and asserts that the scan catches it. It also checks that a second copy of the notice is flagged.

## Consequences

- **Fidant can act as the recipient of an emailed link**, and so can anyone who can read both the notice and the code mail. The list under option 3 says who can read the key. Senders who do not want this leave the email field empty and pass the link on themselves, as today. This is accepted, link scanners included: they can read the key but cannot join without the code.
- **Site copy.** The landing lede ("nobody in between, us included, can read it") stays. Where the sender enters an email, the send page says that Fidant emails this link, so our server sees its key once and does not store or log it. Every claim that the key, the setup messages or the typed name never reach us, every claim about how long anything is kept (the address counters last an hour), and "Anyone who has the link can open the file." (an emailed link also needs the code) gets the exception or a correction. That covers /terms, /privacy (including its how-sending-works steps and the lists the landing page shows), /security, /about, /how and the live server panel.
- **0001 and 0002** stand, read with the replacements above. 0001 is not superseded.
- **AGENTS.md** names this exception in its opening line and its invariants.
- **SIG-109** adds check words, which close the gap the key in the email opens.
- **SIG-110** decides how the audit log records who verified and received, after SIG-12.
- **SIG-107** wires Mailpit as an e2e observation point. The e2e README's table of observation points lists mail under SIG-107 instead of SIG-43.
- **SIG-108** sets up SES: a domain identity, DNS records, a credential for the app on the box and production access. It also meets the requirements under "The mail service". 0003 already accepts an IAM access key on the box.
