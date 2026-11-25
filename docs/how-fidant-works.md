# How Fidant works

This is the source of truth for how Fidant moves a file or a shared secret and why no infrastructure can read it, except through a peer-to-peer link that Fidant emails (see "Emailed links"). It describes the code on `main` today. Planned work is marked as planned.

A change to security or data flow updates this document in the same pull request, and then the web pages that explain it (see "Keeping this true" at the end).

## Parts

| Part                  | Where                                                                                     | What it does                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app               | `apps/web`, runs in each browser                                                          | Creates links and keys, encrypts and decrypts, checks the file. All cryptography happens here.                                                                                                             |
| Server                | `apps/server`, the box at fidant.se                                                       | Serves the web app over HTTPS, passes setup messages between browsers on the `/signal` WebSocket, checks the relays and hands each relay its secret, and, when mail is configured, emails links and codes. |
| Relay (STUN and TURN) | coturn on the relay box at `sto.relay.fidant.se`, set up by `apps/infra/relay/install.sh` | Tells browsers their public address (STUN) and carries encrypted traffic when they can't connect directly (TURN). See "The relay box".                                                                     |
| Fallback relay        | coturn at `turn.fidant.se`, on the box                                                    | The same, but offered only when the server has no relay list (see "The relay box").                                                                                                                        |
| Front proxy           | HAProxy, on the box                                                                       | Holds TCP port 443 and hands each connection on by its TLS server name, without decrypting it.                                                                                                             |
| Shared protocol       | `packages/protocol`                                                                       | Signaling message types, parsers and limits used by both the server and the web app.                                                                                                                       |
| Mail service          | SMTP, from `apps/server/src/mail.ts`                                                      | Delivers the emails the server sends for emailed links. Mailpit locally; see "Emailed links" for production.                                                                                               |

The box is an AWS Lightsail instance in Stockholm (eu-north-1), and so is the relay box. There are no accounts, no file storage and no database of people or transfers. The server holds what it knows about pages and transfers only in memory. Among the secrets it keeps on disk is the relay master, and the relay box keeps its own secrets in a small database file (see "The relay box").

## Modes

Three independent choices set how a transfer runs. Every combination uses the same keys, frames and checks.

| Choice                                | Modes                                                                                                                                                                                                      | Details                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| What is sent                          | A file (`/send`), or a shared secret the sender types or pastes (`/secret`)                                                                                                                                | "The transfer", "Sharing a secret"           |
| How the link reaches the recipient    | The sender copies the link and passes it on over any channel they choose, and the secret never leaves the browser; or the sender gives an email address and our server emails the link and a one-time code | "The link", "Emailed links"                  |
| The route the encrypted traffic takes | Direct over local addresses, direct through public addresses learned from STUN, or through our TURN relay; the sender can refuse the relay for a send                                                      | "How the file travels", "Refusing the relay" |

Emailing a link is offered only when the server has a mail service (see "The mail service"), and it is the one mode in which a link's secret reaches our server.

## The link

`apps/web/src/lib/link.ts`

For each recipient the sender's browser creates a link:

```
https://fidant.se/r/<link ID>#<secret>
```

- **Link ID**: 16 random bytes, base64url (22 characters). The server sees it and uses it only to pair the two browsers.
- **Secret**: 32 random bytes, base64url (43 characters), in the URL fragment. Browsers don't send the fragment to servers, and the site sets `Referrer-Policy: no-referrer`. The app sends the secret nowhere except in the one message that asks our server to email that link (see "Emailed links"); apart from that it only derives keys from it. The router reads the fragment on `/how`, where it is a section anchor, and on the receive page, where it keeps the page's first address, fragment included, in memory only. That lets the "Go back to it" bar return to an unfinished transfer: the link it shows carries only the path, and following it puts the secret back in the address bar and the session history. Nothing more reaches the server.

Both come from `crypto.getRandomValues`. Every recipient gets their own link ID and secret. A link Fidant emails carries a marked fragment, `#e.<value>.<secret>` (see "Emailed links").

## Keys

`apps/web/src/lib/keys.ts`

Two keys are derived from the secret with HKDF-SHA-256. Both are AES-256-GCM `CryptoKey`s, non-extractable, usable only to encrypt and decrypt.

| Key        | HKDF salt                  | HKDF info          | Protects                     |
| ---------- | -------------------------- | ------------------ | ---------------------------- |
| Signal key | the link ID's 16 bytes     | `sigill/v1/signal` | setup messages (SDP and ICE) |
| File key   | the transfer ID (16 bytes) | `sigill/v1/file`   | every frame after INIT       |

The transfer ID is fresh and random for each transfer attempt, so a retry never reuses a (file key, nonce) pair.

## Connecting the two browsers

`apps/web/src/lib/peer.ts`, `apps/web/src/lib/signaling-client.ts`, `apps/server/src/signaling.ts`, `packages/protocol/src/signaling.ts`

```
server    → each page  hello {mail}
sender    → server     host {links, turn}
recipient → server     join {link, attempt}                 with a token on an emailed link
server    → both       joined {link, attempt, iceServers, turn}
sender    → recipient  relay seal_s({offer, sdp})
recipient → sender     relay seal_r({answer, sdp})
both                   relay seal({ice, candidate})        trickle
sender ⇄ recipient     WebRTC data channel "sigill" opens
```

- On connect the server sends `hello`, saying whether it can send mail. Only then does the send page offer to email a link, and only as an opt-in (see "Emailed links").
- The sender's page registers its link IDs with `host`, along with whether it allows our relay (`turn`).
- The recipient's page joins with the link ID and an attempt ID: random, new for each page load, each "Try again" and each automatic retry.
- The server binds at most one recipient page to a link and sends `joined` to both. It keeps no record of used links. The sender's page decides and answers with `refuse` (`used`, `busy`, `unknown` or `drop`).
- Every SDP and ICE message is sealed with the signal key: `base64url(iv(12) ‖ AES-GCM ciphertext ‖ tag(16))` with the additional data `sigill/v1/signal|<link ID>|<attempt>|<direction>`. The server can't read or change them, can't reflect a message to its sender, can't move it to another link, and can't replay it into another attempt. All of this rests on the server not having the secret, which holds for every link except one Fidant emails.
- The SDP carries the DTLS certificate fingerprints of the WebRTC connection. Because the server can't change them, it can't put itself between the browsers. For an emailed link it could, until check words exist (SIG-109, planned).
- When the server stops on SIGTERM, as on a restart, it closes every socket with close code 1012 (`main.ts`). If the WebSocket drops, the two pages behave differently. The sender's page opens a new socket after a growing, jittered delay (`signaling-client.ts`) and sends `host` again with all its links except emailed ones (`SendPage.tsx`): the server dropped their email binding with the old socket, so the page stops hosting them and their card says the emailed link stopped working (`server-lost` in `sender-state.ts`). A recipient whose data channel hasn't opened, on a socket that had opened, starts a new attempt at once with a new socket and a new attempt ID, up to 4 times (`MAX_REJOINS`), then fails (reaching the code step of an emailed link resets the count); a socket that never opened is left to the signaling client's own retries (`ReceivePage.tsx`). After a drop, `refused: unknown` makes the recipient wait and try again, because a restarted server only knows the link once the sender hosts it again. A recipient on an emailed link sends `gate` first on every attempt; once the sender's socket has dropped or the server has restarted, no binding matches its value, so the page shows that the link no longer works (`unbound`). Once the data channel is open, the transfer no longer needs the server, so a drop only closes signaling.
- Accepted residue: the sender learns the attempt ID from the server's `joined`, so a lying server could replay one old attempt's recipient signals to the sender. That only breaks that attempt: the replayed answer names a DTLS fingerprint of a closed connection, so no channel opens.

## Two layers of encryption

WebRTC encrypts the data channel with DTLS. Fidant doesn't rely on that: every frame on the channel after INIT is also encrypted with AES-256-GCM under the file key, which only the two browsers hold. For an emailed link our server had the link's secret, so by sitting in the middle it could derive the file key too. INIT is sent in clear and carries only the random transfer ID, which is the file key's salt; changing it changes the key, so the next frame fails to decrypt.

## Frames

`apps/web/src/lib/frames.ts`

```
frame  = header(10) ‖ body
header = version(1) = 2 ‖ kind(1) ‖ seq(8, u64 big-endian)   plaintext, and the AES-GCM additional data
body   = AES-GCM(file key, iv, aad = header), 16-byte tag
iv     = direction(1: 0 sender, 1 recipient) ‖ 00 00 00 ‖ seq(8)
```

| Kind | Name    | From      | Body                                                                                |
| ---- | ------- | --------- | ----------------------------------------------------------------------------------- |
| 0    | INIT    | sender    | transfer ID (16), in clear, the only unencrypted frame                              |
| 1    | META    | sender    | exactly 1,024 bytes: length(2) ‖ JSON `{name, size, type, chunkSize, from}` ‖ zeros |
| 2    | CHUNK   | sender    | exactly `chunkSize` bytes of file, zero-padded after the end of the file            |
| 3    | END     | sender    | SHA-256(32) ‖ size(8)                                                               |
| 16   | ACCEPT  | recipient | empty                                                                               |
| 17   | RECEIPT | recipient | SHA-256(32) the recipient computed                                                  |
| 18   | DECLINE | recipient | empty                                                                               |
| 19   | CREDIT  | recipient | granted(8, u64): how many CHUNKs in all the sender may send                         |

- Sequence numbers start at 0 in each direction. A reader accepts only the next one, and stops for good after any failure, so a dropped, reordered, repeated or altered frame ends the transfer.
- The two directions use different nonces because the direction is in the IV.
- Changing INIT changes the derived key, so META then fails to decrypt.
- Each kind has a fixed direction and body size range; anything else is rejected.
- Version 2 added CREDIT. A browser rejects a frame of any other version, so both pages must run the same release.

## The transfer

`apps/web/src/lib/send-file.ts`, `apps/web/src/lib/receive-file.ts`

1. When the file is chosen, or each time a shared secret changes, the sender's browser computes its SHA-256 (`apps/web/src/lib/sha256.ts`, streamed in 4 MiB slices).
2. INIT, then META. The recipient sees the name, size, type and the sender's typed name (for a shared secret, only the sender's name), and chooses.
3. The recipient sends ACCEPT or DECLINE, encrypted. ACCEPT also proves that the recipient holds the key. No file data is sent before it. After DECLINE the link still works.
4. CHUNK frames, `chunkSize = min(48 KiB, maxMessageSize − 64)` (64 is `FRAME_OVERHEAD_BYTES` in `frames.ts`: the 26-byte header and tag, with margin), sent while the channel buffer holds at most 4 MiB (`bufferedAmount`) and only within the recipient's credit: right after ACCEPT the recipient sends CREDIT for 128 chunks (`CREDIT_WINDOW_CHUNKS` in `receive-file.ts`), and every 64 chunks its sink writes it raises the credit to 128 past what is written. The sender sends CHUNK i (counting from 0) only while i is below the highest CREDIT. END needs no credit.
5. END with the checksum and the exact size.
6. The recipient checks and sends RECEIPT with the checksum it computed. The sender marks the link delivered only when it matches.

### Checking on the recipient's side

`ReceiveVerifier` in `frames.ts` hashes the file bytes as they arrive and checks that every CHUNK is exactly `chunkSize`, the padding is zeros, the chunks add up to the padded length, and END's size and checksum match what arrived. Only then is the file kept. Any other ending (a frame that fails to decrypt, the wrong order, too much data, the channel closing first) aborts the sink, which discards what was written.

META's `chunkSize` must be at least 986 bytes (`MIN_CHUNK_BYTES`): the META frame (1,050 bytes) must fit the channel, so no honest sender's chunk is smaller, and a sender that claims tiny chunks can't make an in-memory recipient hold millions of separate parts. A recipient holds at most 129 incoming frames that it hasn't handled yet (the window and END), and a sender at most 8. One more ends the transfer as a broken format (`createInbox` in `inbox.ts`), so a sender that ignores its credit can't fill the recipient's memory: what waits for a slow sink stays at about 128 × `chunkSize`, 6 MiB at 48 KiB, whatever the file's size.

`apps/web/src/lib/sink.ts`: where the browser has `showSaveFilePicker` (Chromium), the file streams to a place the recipient chose. Elsewhere it is collected in memory as a Blob and downloaded at the end, and an offer of a file over 256 MiB warns the recipient of that (`BLOB_WARN_BYTES`). A shared secret is always collected in memory and never downloaded (see "Sharing a secret"). The Blob is always `application/octet-stream`, whatever type the sender claims, so a file can't run as a page in Fidant's origin.

### Names

META refuses names, types and sender names containing C0 or C1 control characters, line and paragraph separators (U+2028, U+2029), any Unicode Bidi_Control character (U+061C, U+200E, U+200F, U+202A–202E, U+2066–2069), a filler that always draws as blank (U+115F, U+1160, U+2800, U+3164, U+FFA0, U+13441, U+13442, U+16FE4, U+1D159) or three or more spaces of any kind (also when invisible characters such as U+200B sit between them), so a name ending in `.exe` can't be displayed as one ending in `.pdf` or have its ending pushed out of sight. A single space of any kind is allowed, since macOS puts U+202F in screenshot names (`hasForbiddenCharacters` in `packages/protocol`). The sender's name is typed by the sender and not verified.

## Padding

`paddedLength` in `frames.ts`

Anyone who sees the encrypted traffic (the networks, our relay) sees frame sizes. So:

- The size is rounded up with Padmé (Nikitin et al., 2019), which adds at most 12 %, then up to a whole number of chunks. An empty file is padded like a 1-byte file.
- Every CHUNK frame has the same length. The exact size travels only inside the encrypted META and END.
- META is always 1,024 bytes, so the name's length doesn't show.
- CREDIT is a small encrypted frame of fixed size. Its timing shows only how fast the recipient writes, like the timing of any other frame.
- A shared secret is at most 32 KiB. When `chunkSize` is at least 32 KiB (a maximum message size of at least 32,832 bytes), every shared secret pads to exactly one CHUNK. The code enforces this: on `/secret`, a connection that allows less gets nothing, not even INIT (`textFitsOneChunk` in `text-secret.ts`, checked in `SendPage.tsx` when the data channel opens), and that recipient's card says the secret wasn't sent. The check uses the 32 KiB limit, never the shared secret's own size, so a refusal says nothing about the length. So all shared secrets on a connection have the same frame sizes. When the maximum message size is at least 49,216 bytes, `chunkSize` is 48 KiB, and a shared secret then has the same frame sizes as any file of up to 48 KiB.
- Measured on 2026-11-24 with Playwright's browser builds: Chromium 159 and WebKit 27.2 report a maximum message size of 262,144 bytes, Firefox 159 reports 1,073,741,823, and pairs of different browsers settle at 262,144. When a browser reports none, the app uses 65,536 (`DEFAULT_MAX_MESSAGE_SIZE` in `peer.ts`). So today every shared secret crosses the network as one 48 KiB CHUNK.

An observer learns a file's size only roughly, plus the chunk size, which follows from the connection's maximum message size. A shared secret's length doesn't show at all: a shared secret is sent only over a connection whose maximum message size is at least 32,832 bytes, which every browser measured above allows.

## Sharing a secret

`apps/web/src/lib/text-secret.ts`, `apps/web/src/send/SendPage.tsx`, `apps/web/src/receive/ReceivePage.tsx`

`/secret` sends a secret the sender types or pastes instead of a file, over the transfer above unchanged: the same keys, frames, checks, RECEIPT and one-time links. The server, the relay and the signaling messages are the same as for a file, and so is emailing the link (see "Emailed links").

- The sender's browser turns the shared secret into an in-memory file named `secret.txt` of type `application/x-fidant-text`. The name and type travel inside the encrypted META, like any file's.
- A shared secret is at most 10,000 UTF-16 code units (`MAX_TEXT_LENGTH`), so at most 30,000 bytes of UTF-8. The field has no `maxlength`, so a longer paste stays whole. While it is over the limit, the field is marked invalid and shows its length against the limit (for example "12,000 of 10,000 characters"), `textFile` refuses it, and no link can be added, so a shared secret is never sent cut.
- The field has `spellcheck=false`, `translate=no`, `writingsuggestions=false`, and `autocomplete`, `autocorrect` and `autocapitalize` set to `off`, which tell the browser to keep its spelling, autocomplete, writing suggestions and translation features off the shared secret.
- The recipient's page treats an offer as a shared secret only when its type is exactly `application/x-fidant-text` and its size is at most 32 KiB (`isTextOffer`, `MAX_TEXT_BYTES`). Anything else is offered as a file.
- An offer of a shared secret shows "<sender's name> sent you a secret" with Show and Decline, and no name, size or type. Show always collects the shared secret in memory (`BlobSink`): never a save dialog, never a download.
- Only after the checks in "Checking on the recipient's side" pass does the page decode the shared secret, as UTF-8, keeping a leading byte order mark (invalid bytes become U+FFFD). It shows it as a text node in a `<pre>`, never parsed as HTML, inside a labelled box with `translate=no` that keyboard users can focus and scroll. No form field holds it, because a browser can save a form field's value with its session. Copy calls `navigator.clipboard.writeText` with the decoded string.
- As for a file: nothing is stored, so the sender's page must stay open; each recipient's link works once; after Decline the link still works.
- Loading `/secret` from the server (typing its address, a reload, a bookmark or a link from elsewhere) is an HTTP request for that path, so the server can see that someone opened the page. Every sender page, including `/secret`, then opens its own `/signal` WebSocket and sends `host` with its links, and moving to `/secret` inside the app opens that connection too. The server never gets the shared secret or its length, and a signaling connection doesn't say which page opened it, but after a full load of `/secret` the server can tie the connection that follows from the same address to the visit, and infer that this visitor shares a secret and with how many links. A full load of any other page can give away that the visitor shares a secret too. Each sender page connects when it is first shown and stays connected while the tab is open, so two sender connections open at once from the same address, with no page request between them, most likely mean the visitor opened both `/send` and `/secret` in one tab; after a full load of `/send`, the second connection comes from `/secret`. Neither the server nor Caddy logs page requests.

## How the file travels

`apps/server/src/turn.ts`, `apps/server/src/relays.ts`, `apps/server/relays.json`, `apps/infra/relay/install.sh`, `apps/infra/box/turnserver.conf`, `apps/infra/box/user-data.sh`, `docs/decisions/0007-turn-relay.md`, `docs/decisions/0010-turn-tls-443.md`, `docs/decisions/0015-relay-switch.md`

WebRTC tries the paths in this order, and the sender's page shows which one each connection took:

| Path     | Meaning                                                | Who sees the encrypted traffic |
| -------- | ------------------------------------------------------ | ------------------------------ |
| `direct` | the browsers reach each other's local addresses        | the networks between them      |
| `stun`   | through public addresses learned from our STUN service | the networks between them      |
| `relay`  | through our TURN relay, when no direct route works     | the networks and our relay     |

- On any path each browser sees the other's IP address, like on a video call. STUN sees each browser's address for the binding request, and no file data passes through it.
- Relay credentials are minted by the server for each pairing and sent only to the two paired sockets: the username is an expiry time 5 minutes ahead and the credential is HMAC-SHA1 of it under the relay's secret, which the server and that relay hold. Code that runs as the app's user on the app box can also work it out (see "The relay box"). The expiry limits starting a relay connection, not how long it may run.
- The server hands browsers the URLs of the first relay in `apps/server/relays.json` that is up (see "The relay box"). Today that is the relay box: `stun:sto.relay.fidant.se:3478`, `turn:sto.relay.fidant.se:3478?transport=udp` and `turns:sto.relay.fidant.se:443?transport=tcp`. So browsers reach coturn over UDP on port 3478, or over TLS on TCP port 443, which networks that allow only web traffic still let through. coturn also accepts plain TCP and TLS on 3478, but no URL names them (SIG-125). Its other ports (3479 and TLS on 444) are closed by both firewalls. `sto.relay.fidant.se` has only an IPv4 address, so browsers reach the relay over IPv4 only.
- coturn forwards only over UDP (`no-tcp-relay`), and only from its box's private IPv4 address (`relay-ip`), so relayed addresses are IPv4 only. It refuses to forward to other machines on private, loopback, link-local and other internal ranges (`denied-peer-ip`). The accepted exception is that relay clients can reach UDP services on the relay's own box, at its private and public IPv4 address (`docs/decisions/0007-turn-relay.md`, Consequences). It also caps concurrent allocations (`total-quota=200`), and writes no log (`log-file=/dev/null`). The traffic it carries is DTLS and AES-GCM; on 443 it is wrapped in TURN's TLS as well.
- The relay forwards encrypted packets. It can't decrypt them and doesn't store them.

### The fallback relay on the box

Without a relay list, the server hands out the box's own coturn instead, from `TURN_URLS`: `stun:turn.fidant.se:3478`, `turn:turn.fidant.se:3478?transport=udp` and `turns:turn.fidant.se:443?transport=tcp`, plus a `stun:` URL with the box's IPv6 address when it has one. It has the same settings as above. It differs in two ways:

- On 443, HAProxy reads only the TLS server name and ALPN. It passes connections for `turn.fidant.se` to coturn's TLS listener without decrypting them, except Let's Encrypt's `acme-tls/1` checks, which go to Caddy; coturn holds that name's key, a copy of Caddy's Let's Encrypt certificate. coturn sees such a connection as coming from 127.0.0.1, though the peer addresses in it still name the browsers.
- Its other TLS ports (3479, 5349, 5350) are closed by the firewall.

SIG-154 takes it off the box (planned).

### The relay box

`apps/infra/relay/install.sh`, `apps/infra/src/relay.ts`, `apps/server/src/relays.ts`, `apps/server/src/relay-secret.ts`, `apps/server/src/turn-check.ts`, `docs/decisions/0013-relay-service.md`, `docs/decisions/0015-relay-switch.md`

The relay is its own service, so that relays can run on any Ubuntu server and in more than one place. The first is a second Lightsail box in Stockholm, set up by `install.sh`, and it carries relayed transfers while the server has a relay list.

- It runs coturn with the settings above, on UDP and TCP 3478, and with TLS on TCP 443 directly, with its own Let's Encrypt certificate for `sto.relay.fidant.se`. No HAProxy sits in front of it, so it sees real client addresses on TLS too.
- At install it makes an RSA key pair. The private key never leaves the box. The server trusts only the public keys in its relay list, `apps/server/relays.json`, which changes only through a pull request that the `maintainers` team must approve (repository admins can bypass that rule).
- The server derives each relay's secret from one master: HMAC-SHA256 of the relay's ID under it. The master is 32 random bytes in `/var/lib/sigill/relay-master` on the box, mode 0600. The server makes it at its first start and keeps it through deploys and reboots. Anything that runs as the app's user can read it, a deploy's build steps included. Nothing logs the master or a relay's secret.
- Every minute the relay asks the server for its secret at `https://fidant.se/relay-secret/sto`. The answer is the secret sealed to the relay's public key (RSA-OAEP with SHA-256, `sealRelaySecret`), so anyone can ask but only that relay can open it.
- A new secret reaches coturn through coturn's own SQLite file, without a restart, so relayed transfers in progress keep running. The previous secret stays valid for 24 hours after a change, unless a second change ends it sooner, and longer while no new answer arrives.
- At startup and then every 60 seconds the server checks each relay with a real TURN allocation from the box, under a username marked `probe`, and releases it at once. A relay counts as up once a check passes, and as down before that and after two failed checks in a row. `joined` carries the first relay in the list that is up. When none is, it carries only the first relay's `stun:` URL, so browsers can still learn their public address but get no relay. `/relay-status` shows which relays are up, to anyone.
- When `apps/server/relays.json` is `[]`, or a drop-in on the box turns the list off (`RELAYS_FILE` set but empty, see the runbook in `docs/decisions/0015-relay-switch.md`), the server has no relay list and uses the fallback relay above.
- What the relay box sees, keeps and logs is under "What the server and relay see, keep and log".

### Refusing the relay

`docs/decisions/0008-relay-opt-out.md`

The send page has "Allow our relay if a direct connection isn't possible", on by default, for that send only.

- When it is off, the server mints no TURN credential and `joined` carries only the `stun:` URLs. An unmodified browser can't use our relay.
- Backstop: if the sender's selected candidate pair still reads `relay` on a refused attempt, the sender ends the attempt and reports `failed`. It runs after the channel opens, so INIT and META may have passed; file data only flows after ACCEPT.
- Limit: a modified recipient can route its own side through our relay with credentials from another pairing, or through any public TURN server. That recipient holds the key anyway. The choice decides which infrastructure carries the encrypted traffic, not who can read the file.

## Several recipients and one-time links

`apps/web/src/lib/sender-state.ts`

- One send can go to up to 256 recipients (`MAX_LINKS`). Each has their own link, key, connection and transfer.
- A link is used only after a matching RECEIPT. A later join on it is refused with `used`. A second page on a link that is already connected is refused with `busy`.
- Until then the link can be opened again: after a decline, a dropped connection, a setup timeout (20 s), a checksum mismatch or, for a shared secret, a connection too small to carry it in one chunk. Each attempt has a new transfer ID and so a new file key.
- Nothing is stored, so a link works only while the sender's page is open. When the sender's socket closes, the server forgets its links, within a minute at most (heartbeat every 30 s).

## Emailed links

`apps/server/src/signaling.ts`, `apps/server/src/mail.ts`, `apps/web/src/send/SendPage.tsx`, `apps/web/src/receive/ReceivePage.tsx`, `docs/decisions/0012-email-recipients.md`

The sender can give a recipient an email address, on `/send` for a file and on `/secret` for a shared secret. It is opt-in: the address field appears only after the sender ticks "Email the link for me (less private)", which is off on every page load, and ticking it first shows what emailing costs (our server and the mail service see the key, the link stays in the mailbox, and our server could sit in the middle until check words exist). Fidant then emails that recipient their link, and the recipient's browser can connect only after they enter a one-time code sent to the same address. This is the one case where a link's secret leaves the browser: our server and the mail service see it. Recipients without an address work as described above.

### Registering an emailed link

```
server → sender    hello {mail: true}
sender → server    host {links, turn}                      the new link included
sender → server    email {link, to, secret, from, lang}    once per link
server → mail      notice to `to` with <PUBLIC_ORIGIN>/r/<link ID>#e.<value>.<secret>
server → sender    email {link, status, mark}              sent or failed, with the value
```

- Adding a recipient with an address hosts the link as usual, then sends one `email` message with the link ID, the address, the link's secret, the name the sender typed for themselves and the page language. `host` carries only link IDs, never any of these.
- The protocol parser checks every field first: a valid link ID; a secret of exactly the link secret's form (43 base64url characters that decode to 32 bytes); an address that `<input type="email">` accepts, at most 254 characters; a typed name that passes META's rule above, at most 100 characters; and `lang` `sv` or `en`.
- The server answers `wrong-role` to a recipient's socket. It answers `failed` (naming the link, no mark) when the socket doesn't host the link, when it has no mail service, or when the link has already had an `email` or a guest while hosted, and `limit` when a notice limit is reached. None of these sends mail or changes a binding. A `limit` answer still uses up the link's one `email`, so the page offers the plain link.
- Otherwise the server picks a random value for this registration (16 bytes from `randomBytes`, base64url), never derived from the link's secret and never chosen by a client, and binds the link to the address, the language and the value. It then makes one attempt to hand the notice to the mail service, bounded by nodemailer's timeouts (10 s to connect, 10 s for the greeting, 20 s of silence). A notice the mail service doesn't take is never queued or retried.
- The link in the notice is built from the configured `PUBLIC_ORIGIN`, never from the request, so the server can only email links to its own site.
- The link's secret and the typed name exist on the server only in that send attempt, until it ends. They are never stored or logged.
- The reply to the sender carries the value, never the link's secret: `sent`, or `failed` if the attempt failed or timed out. A failed notice leaves the link email-bound, because a timed-out notice may still arrive. To send again, the sender removes the recipient and adds them again, which makes a new link.
- The sender's card offers no link until the reply arrives. With a value, the page builds the same marked link from the link's secret it already has and shows and copies only that. After a refusal without a value, it offers the plain link.
- The notice is plain text, from `MAIL_FROM` to that one address, with no Reply-To. Its subject names neither the sender nor the file. Its body has the typed name marked as not verified ("Someone" when it is empty) and the link, and says "a file or a secret" for both. No email names the file, gives its size or type, or says whether the link carries a file or a shared secret.

### Opening an emailed link

```
recipient → server     gate {link, mark}
server    → recipient  gate {link, to}                  the masked address, or ""
recipient → server     send-code {link, mark}
server    → mail       code email to the bound address
server    → recipient  code {link, result}              sent, wait, limit or failed
server    → sender     email {link, status: verifying}
recipient → server     code {link, code, mark}
server    → recipient  token {link, token}              or code {link, result: wrong, expired or tries}
server    → sender     email {link, status: verified}
recipient → server     join {link, attempt, token}
```

- The recipient page reads the value from `#e.<value>.<secret>` and sends `gate` with it before every `join`, rejoins and reloads included. The server answers with the masked address (`a***@example.se`) only when the value matches the link's current binding. Any other `gate` (no value, a wrong value, a link that is not email-bound or unknown) gets `to: ""`, the same answer as for a plain link. So someone with only the link ID can't see the masked address or cause code emails.
- For a marked link, `to: ""` means the binding is gone: the page joins nothing and says the link no longer works (`unbound`).
- `send-code` and `code` carry the value too. With a wrong one, `send-code` answers `failed` and `code` answers `expired`, and no code is sent or checked. A code is 6 digits from `randomInt`, works for 10 minutes or until the fifth wrong try, and replaces any earlier code for the link. The server compares it with `timingSafeEqual`. A right code gets a token of 16 random bytes, base64url.
- The page keeps the token in that tab's `sessionStorage` under `token:<link ID>` and joins with it. A reload or a rejoin in the same tab reuses it. Another tab or browser needs its own code, except a tab the browser copies sessionStorage into, such as a duplicated tab.
- The server refuses a `join` on an email-bound link without a token its current binding issued, and a `join` that carries a token on any other link. It logs `refused` with reason `unverified` and answers `gate {link, to: ""}`, never the masked address. The page then drops its token and, for a marked link, asks `gate` again.
- A rejoin keeps the code field. A `failed` or `expired` code result makes the page ask `gate` again, so a binding that is gone ends as "this link no longer works".
- The page shows no sender name before the code. As for any link, the recipient reads it from META.

### What the server keeps, and limits

- While the sender's page hosts the link, the server holds in memory the address, the language, the value, the latest code with its expiry and tries, when the link's codes went out, the tokens, and whether the link already had its `email` or a guest.
- Unhosting the link (a `host` without it, which is what removing the recipient sends, or the sender's socket closing) drops all of it, and so does a server restart. The emailed link then connects to nothing, even if someone hosts the same link ID again as a plain link.
- The limits are `LIMITS` and the code constants in `apps/server/src/signaling.ts`:

| Limit                                             | Value                                    |
| ------------------------------------------------- | ---------------------------------------- |
| Notices from one sender socket                    | 20 an hour                               |
| Notices from one client address (IPv6 by its /48) | 50 an hour                               |
| Notices to one email address                      | 5 an hour                                |
| Notices from the whole server                     | 500 an hour                              |
| Codes for one link                                | 5 while it is hosted                     |
| Time between two codes for one link               | 30 s                                     |
| Codes asked for by one client address (as above)  | 5 an hour                                |
| Codes to one email address                        | 10 an hour                               |
| Codes from the whole server                       | 500 an hour                              |
| A code's life                                     | 10 minutes, or until the fifth wrong try |

- The limits per email address and for the whole server can be used up by anyone, a stranger with no link included: they can stop notices or codes to one address, or all of them, for up to an hour, and a sender who gets `limit` can tell that the notice limit was reached. A refused code counts against nothing, and a client's own limit on codes (5) is below the address's (10), so one client can't use up an address's codes on its own (0016).
- The counters per email address and per client address hold only send times, under an HMAC-SHA-256 of the lowercased address or the client address with a 32-byte random key made when the server starts. The two counters for the whole server hold only send times. They outlive the link, stay in memory for at most an hour and are pruned on the heartbeat. The per-socket count lives on the socket and goes with it.

### The mail service

- The server sends mail over SMTP with nodemailer only when `MAIL_SMTP_URL`, `MAIL_FROM` and `PUBLIC_ORIGIN` are all set (`apps/server/src/main.ts`). Without them `hello` says `mail: false` and every `email` gets `failed`. An SMTP password comes only from the file named by `MAIL_PASSWORD_FILE`, never from the URL. `smtps://` uses TLS from the start, and `smtp://` requires STARTTLS whenever a password is set and for every host except loopback (localhost, 127.0.0.0/8, ::1), and never falls back to plain text. Certificate verification stays on.
- Mail service errors can quote the address, so the server keeps none of them and logs only the outcome.
- Locally, `pnpm e2e` runs Mailpit, which catches every mail and never sends it on. `pnpm start` sends no mail unless those variables are set.
- In production the mail service will be Amazon SES in eu-north-1 (planned, SIG-108). Until then the box sets no mail variables, so fidant.se offers no email field.
- SES stops all sending when the account's bounce rate reaches 2 % or its complaint rate 0.05 %, below the rates at which AWS reviews the account. Every `email` and code then gets `failed` until a maintainer turns sending back on. The alarms read only these rates, never a bounce or complaint itself.

### Who can read an emailed link's key

- Our server, while it builds and sends the notice, and the mail service.
- Anyone who can read the mail in transit, the recipient's mailbox provider for as long as the mail is kept, and link scanners that fetch it. A scanner can't connect without the code.
- Anyone who can read that mailbox, who can also get the code and so the file or shared secret.
- With the key, our server could open that link's sealed setup messages, swap the DTLS fingerprints and sit in the middle of the transfer. The code doesn't stop this, because Fidant sends the code. Check words that both screens show will close the gap (SIG-109, planned). A sender who doesn't want any of this leaves "Email the link for me (less private)" unticked and passes the link on themselves.

## What the server and relay see, keep and log

|            | Server                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Relay                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sees       | IP addresses and browser details of each page; link IDs; the sender's relay choice; the connection path the sender reports for each attempt (direct, stun, relay or failed); whether a link was already used (the sender's refuse reasons); when each side connects and disconnects; sealed setup messages and their sizes; for an emailed link, the address, the link's secret and the sender's typed name in its `email` message, and the value, codes and tokens the server makes | Both browsers' IP addresses, on every connection (on the fallback relay, a TLS connection through HAProxy reaches coturn from 127.0.0.1, but peer addresses and direct UDP connections still carry real addresses); encrypted packets, with the file size only roughly and a shared secret's length not at all |
| Never sees | the file, its name, type or exact size; a shared secret or its length; a link's secret, the keys and the content of setup messages, except for an emailed link                                                                                                                                                                                                                                                                                                                       | the file, its name, type or exact size; a shared secret or its length; any link's secret or key                                                                                                                                                                                                                |
| Keeps      | in memory only, while the pages are connected; forgotten within a minute after a page disconnects. Except: an emailed link's binding while it is hosted, its secret and typed name until the send attempt ends, the email counters (HMACs, plus two server-wide counters of send times tied to no address) for up to an hour, and, on disk, the relay master that every relay's secret comes from                                                                                    | nothing of the file once it has passed; its current secret and at most one previous one (see below)                                                                                                                                                                                                            |
| Logs       | events with a fixed set of fields (`LogEvent`, `LogFields` in `packages/protocol`): the first 6 characters of a link ID, link counts, message sizes, refuse and error codes, the outcome of each email and code (`email`, `code`, `verified`), the connection path, the port. Never names, email addresses, codes, tokens, the email marker's value, keys, file data or IP addresses. Deleted after 30 days (journald, `MaxRetentionSec=29day`).                                     | nothing of the traffic by default. Only to fix a fault or stop abuse: connection times, IP addresses (on the fallback relay, 127.0.0.1 for a TLS connection through HAProxy) and data volumes, for at most 7 days. On the relay box, certbot's log (see below)                                                 |

On the relay box (see "The relay box"):

- coturn sees the real address of every client, TLS included.
- It keeps its key pair. The private key never leaves the box.
- It keeps the current secret, and at most one previous one for 24 hours after a change or longer while the relay gets no answer it can open, in files and in coturn's SQLite file, readable only by root and coturn. It keeps nothing of the file.
- coturn logs nothing. The journal is deleted after 30 days and holds no client addresses: the host firewall logs nothing either, because a logged blocked packet would carry its source address.
- certbot's log is the exception. While certbot holds port 80 to get or renew the relay's certificate, a few seconds on each attempt, every 15 minutes until the first certificate and then roughly every 60 days, its log records the address of whatever connects: Let's Encrypt's validators and scanners. Browsers never use port 80 on the relay. Such an address is kept for at most about five weeks: logrotate rotates the log weekly, and a rule removes each file 29 days after its last write.

/privacy lists every log field, generated from the same type.

## What stays on the two devices

`apps/web/src/theme.ts`, `apps/web/src/i18n/language.ts`, `apps/web/src/send/SendPage.tsx`, `apps/web/src/receive/ReceivePage.tsx`

- Both pages keep the links, keys, transfers and file data only in memory. Fidant writes only two things to storage that outlasts the tab: the chosen theme and language, in `localStorage`.
- Sender: the file is read from where it is and copied nowhere else. A shared secret is typed into a `<textarea>`, whose value a browser can save with its session. A link the sender copies is on their clipboard.
- Recipient: the file is where they saved it (see "Checking on the recipient's side"). A shared secret is only in the page's memory until copied, then also on the clipboard (see "What Fidant doesn't protect against"). For an emailed link, the token stays in that tab's `sessionStorage` (see "Opening an emailed link").
- Both: the browser's history keeps every address it opened, so the recipient's history holds the link with its secret, like any address. The link is refused once its file is delivered and works only while the sender's page is open.

## The web app and the server

`apps/server/src/server.ts`, `apps/server/src/relays.ts`, `apps/web/src/main.tsx`, `apps/web/src/i18n/preview.ts`, `apps/web/vite.config.ts`, `apps/infra/box/user-data.sh`

- HTTPS only, with `Strict-Transport-Security` (Caddy, Let's Encrypt). Send and receive refuse to run outside a secure context.
- HAProxy holds TCP 443 and passes every connection not for `turn.fidant.se` to Caddy on port 8444, without decrypting it. It adds a PROXY protocol header, which Caddy accepts only from 127.0.0.1, so Caddy and the server still see the real client address (`docs/decisions/0010-turn-tls-443.md`). HAProxy logs nothing and stores nothing on disk; it holds only addresses and connection counts in memory, for its per-source cap.
- `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`: code, styles, fonts and connections only from our own origin, and no framing. `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- No cookies, no third-party scripts, fonts or trackers.
- Static files are served only from the build directory; path traversal is refused.
- A path without a file extension gets one of four copies of `index.html` whose link preview (Open Graph tags) holds only fixed text: a receive link (`/r/<link ID>`) says something was sent to you, any other path says what Fidant is. The server picks the copy by path and by whether `Accept-Language` starts with `sv`, and sends `Vary: Accept-Language`. Like a browser, a preview fetcher sends us the path but never the part after `#`.
- The WebSocket accepts upgrades only on `/signal`, and refuses one whose `Origin` is another site.
- Two routes serve the relays, with `Cache-Control: no-store` and the headers above. They take only GET and HEAD and need no authentication. `/relay-status` answers JSON with each relay's ID and whether it is up, such as `[{"id":"sto","up":true}]`, or `[]` without a relay list. `/relay-secret/<id>` answers a relay's sealed secret as one line of text (see "The relay box"). Any other path under them gets 404.
- Limits: HAProxy closes a source's 129th concurrent connection on 443 (a source is an IPv4 address or an IPv6 /64) and an idle connection after 2 minutes, or after 1 hour on the path to the fallback relay. The server allows 1,000 sockets, 32 per client address (an IPv6 address counts by its /64), 1,000 messages per socket per 30-second window, 256 links per sender, 16,384 characters per relayed setup message, 256 KiB queued to a socket that isn't reading before relays to it are dropped, 512 KiB before the socket is ended, and the email and code limits under "Emailed links".

## Every path and its traces

The three choices under "Modes" give twelve paths: a file or a shared secret, a link the sender passes on or one Fidant emails, and a direct route with the relay allowed, the relay route, or a direct route with the relay refused. This section lists, for every path, each place that keeps a trace, what it keeps and for how long. The `/how/traces` explorer shows the same to readers (`apps/web/src/how/TraceExplorer.tsx`, its text in `technical.explorer` in `apps/web/src/i18n/en.ts` and `sv.ts`).

Every pull request is checked against this section. The `Claude review` workflow walks every path against the diff, and `packages/protocol/src/transfer-paths.test.ts` fails when a signaling message, log event or log field has no entry below, or when a file this document names no longer exists.

### Where traces are kept

| Place                                                          | What it keeps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | On which paths | Kept for                                                                                                                                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sender's browser                                               | The link and its key in the tab's memory; the file stays where it is; a shared secret in its text box, which session restore can save                                                                                                                                                                                                                                                                                                                                                            | all            | until the tab closes                                                                                                                                                        |
| Both browsers                                                  | Theme and language in `localStorage`                                                                                                                                                                                                                                                                                                                                                                                                                                                             | all            | until cleared                                                                                                                                                               |
| The channel the sender pastes the link in                      | The full link, key included; its link previewer requests `/r/<link ID>` but never gets the fragment                                                                                                                                                                                                                                                                                                                                                                                              | link passed on | that service's policy                                                                                                                                                       |
| Our server, in memory                                          | Both IP addresses, link IDs and pairings; setup messages pass through (sealed, except on an emailed path while check words, planned in SIG-109, don't exist: the server could sit in the middle)                                                                                                                                                                                                                                                                                                 | all            | while the sockets are open, ≤ 1 min after                                                                                                                                   |
| Our server                                                     | While a relay is up, makes the TURN credentials for the pair (valid 5 minutes), sends them in `joined` and keeps none. When no relay is up, `joined` carries only the first listed relay's `stun:` URLs                                                                                                                                                                                                                                                                                          | relay allowed  | not kept                                                                                                                                                                    |
| Both browsers                                                  | While a relay is up, the TURN credentials, valid 5 minutes to start a relay (coturn stores none: it recomputes the HMAC from its secret)                                                                                                                                                                                                                                                                                                                                                         | relay allowed  | while the page is open                                                                                                                                                      |
| Our server, in memory                                          | The address, value, code and tokens; the link's secret and typed name only during the send attempt; HMAC counters; two server-wide send-time counters (all notices, all codes), tied to no address                                                                                                                                                                                                                                                                                               | emailed        | while hosted; counters up to 1 h                                                                                                                                            |
| Server journal                                                 | The lines under "Every server log line"                                                                                                                                                                                                                                                                                                                                                                                                                                                          | all            | 30 days                                                                                                                                                                     |
| HAProxy                                                        | Each source address (an IPv6 address by its /64) and its connection count, in memory; no log                                                                                                                                                                                                                                                                                                                                                                                                     | all            | while any connection from it is open, and up to 2 minutes after the last one closes                                                                                         |
| Caddy                                                          | Decrypts TLS and sees every HTTP request and every `/signal` message it passes on, in memory only: request paths (among them `/relay-status` and `/relay-secret/<id>`, which no transfer uses), IP addresses and, on an emailed link, the `email`, `code` and `token` messages with the address, typed name, link's secret, code and token. Never the URL fragment, which browsers do not send. No access log; its own log goes to the journal, with the HTTP error log and the TLS log excluded | all            | the log 30 days (the journal); the requests not kept                                                                                                                        |
| coturn (on the relay box; on the app box without a relay list) | Each browser's public address for STUN                                                                                                                                                                                                                                                                                                                                                                                                                                                           | all            | no log of the traffic; a temporary log, only to fix a fault or stop abuse, for at most 7 days                                                                               |
| coturn (on the relay box; on the app box without a relay list) | While a relay is up, both IP addresses, from each browser's allocation, even when a direct route wins                                                                                                                                                                                                                                                                                                                                                                                            | relay allowed  | while the allocation lasts; no log of the traffic, a temporary log for at most 7 days                                                                                       |
| coturn (on the relay box; on the app box without a relay list) | The encrypted traffic, forwarded and not stored                                                                                                                                                                                                                                                                                                                                                                                                                                                  | relay route    | not stored                                                                                                                                                                  |
| App box's disk                                                 | The relay master, 32 random bytes in `/var/lib/sigill/relay-master` (mode 0600), from which each relay's secret is derived. Anything that runs as the `sigill` user can read it. It holds no trace of any transfer                                                                                                                                                                                                                                                                               | all            | until the app box is replaced, or until a step in 0015's runbook removes it                                                                                                 |
| Relay box's files                                              | Its private key, readable only by root, and its public key. Its current secret and at most one previous one, in files and in coturn's SQLite file, readable only by root and coturn. It holds no trace of any transfer                                                                                                                                                                                                                                                                           | all            | the key pair until the box is replaced; the current secret until it changes; the previous one 24 hours after a change, or longer while the relay gets no answer it can open |
| certbot's log on the relay box                                 | The address of whatever connects to port 80 while certbot runs: Let's Encrypt's validators and scanners, never a browser. It holds no trace of any transfer                                                                                                                                                                                                                                                                                                                                      | none           | at most about five weeks                                                                                                                                                    |
| Mail service and the recipient's mailbox                       | The notice with the full link, key included, and the typed name; the code email                                                                                                                                                                                                                                                                                                                                                                                                                  | emailed        | the mail service's own policy; the mailbox until deleted                                                                                                                    |
| Recipient's browser                                            | The link with its secret in history; the saved file, or a shared secret in page memory and, once copied, the clipboard                                                                                                                                                                                                                                                                                                                                                                           | all            | history and files until deleted                                                                                                                                             |
| Recipient's browser                                            | The token in that tab's `sessionStorage`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | emailed        | until the tab closes                                                                                                                                                        |
| Networks on the route                                          | Both IP addresses, timing, padded sizes; a shared secret's length doesn't show                                                                                                                                                                                                                                                                                                                                                                                                                   | all            | not known                                                                                                                                                                   |

### Retries and failures

| Event                                                                                                    | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Extra traces                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decline                                                                                                  | The recipient's page closes its signaling socket. The sender marks the link declined and the link stays usable. A new attempt gets a new transfer ID and file key.                                                                                                                                                                                                                                                                                                                                                                                                           | `left`; no `refused`, because a decline sends no `refuse`                                                                                                         |
| Setup timeout (sender's 20 s)                                                                            | The sender reports `path` with `failed`, refuses the recipient with `drop`, closes the connection and waits again. The recipient ends with a failure and doesn't rejoin.                                                                                                                                                                                                                                                                                                                                                                                                     | `path` with `failed`, `refused` with `drop`                                                                                                                       |
| No relay is up                                                                                           | The server's checks haven't passed yet, which is so at startup, or have failed twice in a row. `joined` carries only the first listed relay's `stun:` URLs and no TURN credentials. A transfer that needs the relay ends as under "Setup timeout", or as under "Dropped channel before delivery" if the browser's ICE gives up first. Routes over local addresses still work, and routes through public addresses do too while the relay box still answers STUN. Without a relay list, the server offers the fallback relay whenever `TURN_URLS` is set and never checks it. | as in the row it ends under                                                                                                                                       |
| Dropped channel before delivery                                                                          | The sender refuses the recipient with `drop`, as above. The recipient ends with a failure and doesn't rejoin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `refused` with `drop` while the recipient is still joined; `path` with `failed` if ICE failed; `console.warn` of the reason                                       |
| Recipient's own timeout (30 s)                                                                           | The recipient ends with a failure and closes its signaling socket. The sender waits again.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `left`                                                                                                                                                            |
| Recipient's signaling socket drops before the channel opens, or `refused` with `unknown` after a restart | The recipient rejoins with a new attempt ID, up to 4 times.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Socket drop: `left`, then `joined` on a rejoin. After a restart: no `left`; `refused` with `unknown` for each rejoin before the sender hosts again, then `joined` |
| Used, busy, unknown link                                                                                 | `used`: the sender's page answers `refuse` and the server forwards it. `busy` and `unknown`: the server refuses the join itself.                                                                                                                                                                                                                                                                                                                                                                                                                                             | `refused` with `used`, `busy` or `unknown`                                                                                                                        |
| Sender's socket drops                                                                                    | The sender reconnects and hosts again, except emailed links, whose binding the server dropped. A recipient who had joined gets `host-gone`.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `host-closed`, `host-gone`                                                                                                                                        |
| A relayed connection on a send that refused the relay                                                    | The sender's page sees the relay route after the channel opens, ends the attempt, refuses the recipient with `drop` and shows that the relay was refused. INIT and META may have passed through the relay; file data flows only after ACCEPT. The recipient ends with a failure and doesn't rejoin.                                                                                                                                                                                                                                                                          | `path` with `failed`, `refused` with `drop`                                                                                                                       |
| A shared secret on a connection too small to carry it in one chunk                                       | The sender's page sends nothing, not even INIT, refuses the recipient with `drop`, and the card says the secret wasn't sent. The recipient ends with a failure and doesn't rejoin.                                                                                                                                                                                                                                                                                                                                                                                           | `refused` with `drop`, then `path` with the route                                                                                                                 |
| Checksum mismatch                                                                                        | The recipient sends RECEIPT with the checksum it computed. The sender marks the card failed and closes the connection, with no `refuse`. The link stays usable. The recipient closes its signaling socket.                                                                                                                                                                                                                                                                                                                                                                   | `left`                                                                                                                                                            |
| Server restart                                                                                           | All memory is gone, emailed bindings included. Open data channels keep running. On SIGTERM the server first closes every signaling socket with close code 1012 (service restart).                                                                                                                                                                                                                                                                                                                                                                                            | none beyond the journal                                                                                                                                           |
| Tampered, replayed or reflected frame or signal                                                          | The reader stops for good; the sink discards what was written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none                                                                                                                                                              |

Checked by `apps/e2e/tests/first-demo.spec.ts` ("refuses used, unknown and malformed links", "a sender whose connection setup fails logs why and lets the recipient try again", "a declined offer shows as declined, and the link can be reopened", "through a server restart", "a hostile path"), `apps/e2e/tests/secret.spec.ts`, and for the relay backstop `apps/web/src/lib/sender-state.test.ts`.

### Every signaling message

`packages/protocol/src/signaling.ts`. The server reads every field listed here. None carries file content, a file name, type or size, or a key, except `email`.

| Message     | Direction            | Fields                                         | Path                  | Sensitive                                                  |
| ----------- | -------------------- | ---------------------------------------------- | --------------------- | ---------------------------------------------------------- |
| `hello`     | server → page        | `mail`                                         | all                   | no                                                         |
| `host`      | sender → server      | `links` (IDs), `turn`                          | all                   | no                                                         |
| `join`      | recipient → server   | `link`, `attempt`, `token` on an emailed link  | all                   | `token` is a bearer value, never logged                    |
| `joined`    | server → both        | `link`, `attempt`, `iceServers`, `turn`        | all                   | TURN credential, never logged                              |
| `relay`     | page → server → page | `link`, `data` sealed with the signal key      | all                   | sealed; server can't read it (except on emailed paths)     |
| `refuse`    | sender → server      | `link`, `attempt`, `reason`                    | failures and refusals | no                                                         |
| `refused`   | server → recipient   | `reason`                                       | failures and refusals | no                                                         |
| `left`      | server → sender      | `link`                                         | all                   | no                                                         |
| `host-gone` | server → recipient   | none                                           | failures and refusals | no                                                         |
| `error`     | server → page        | `code`                                         | failures and refusals | no                                                         |
| `path`      | sender → server      | `link`, `path`                                 | all                   | no; logged without the link                                |
| `email`     | sender → server      | `link`, `to`, `secret`, `from`, `lang`         | emailed               | **yes: the link's secret, the address and the typed name** |
| `email`     | server → sender      | `link`, `status`, `mark`                       | emailed               | `mark` is the value, never logged                          |
| `gate`      | recipient ⇄ server   | `link`, `mark` / `link`, `to` (masked address) | emailed               | `mark`, never logged                                       |
| `send-code` | recipient → server   | `link`, `mark`                                 | emailed               | `mark`, never logged                                       |
| `code`      | recipient ⇄ server   | `link`, `code`, `mark` / `link`, `result`      | emailed               | `code`, never logged                                       |
| `token`     | server → recipient   | `link`, `token`                                | emailed               | `token`, never logged                                      |

### Every server log line

Written as one JSON line, `{event, ...fields}`, to stdout and from there to the journal (deleted after 30 days). `LogEvent` and `LogFields` in `packages/protocol/src/signaling.ts` are the only allowed shape; /privacy lists them from the same type.

Fields: `link` (first 6 characters of a link ID), `links` (a count), `bytes` (a message size), `reason`, `code` (an error code), `port`, `path` (the route).

| Event              | Fields           | Path                           |
| ------------------ | ---------------- | ------------------------------ |
| `listening`        | `port`           | start                          |
| `upgrade-rejected` | `reason`         | failures and refusals          |
| `bad-message`      | `bytes`          | failures and refusals          |
| `rate-limited`     | none             | failures and refusals          |
| `error`            | `code`           | failures and refusals          |
| `host`             | `links`          | all                            |
| `host-gone`        | `link`           | failures and refusals          |
| `host-closed`      | `links`          | all                            |
| `joined`           | `link`           | all                            |
| `refused`          | `link`, `reason` | failures and refusals; emailed |
| `relay`            | `link`, `bytes`  | all                            |
| `relay-dropped`    | `link`, `bytes`  | failures and refusals          |
| `path`             | `path`           | all                            |
| `left`             | `link`           | all                            |
| `email`            | `link`, `reason` | emailed                        |
| `code`             | `link`, `reason` | emailed                        |
| `verified`         | `link`           | emailed                        |

## What Fidant doesn't protect against

- **The link is the key.** Anyone who gets a link can open the file or shared secret behind it until the link is used. A link Fidant emails also needs a code sent to the same address, so it opens for anyone who can read that mailbox. Send each link only to its recipient, over a channel you trust.
- **Emailed links.** Our server, the mail service and the recipient's mailbox see the key, and our server could sit in the middle of that transfer until check words exist (SIG-109). See "Emailed links".
- **The served code.** The browser runs the code our server sends. A server that sent different code could read files. The code is public, but a browser can't yet check that what it received matches it.
- **Unverified sender name.** Typed by the sender.
- **Metadata.** The other browser sees your IP address. The networks and, on the relay path, our relay see both IP addresses, timing and the rough size. Our server sees both IP addresses, which recipient connects to which sender, when, and how many recipients a sender has, and for an emailed link the recipient's email address. So it learns who sends to whom, though not what, unless it sits in the middle of an emailed link's transfer.
- **Compromised devices.** Malware on either computer can read the file before encryption or after decryption.
- **Copied secrets.** When the recipient copies a shared secret, it goes to the operating system's clipboard, where clipboard history, cloud clipboard sync and other apps can read it. Once a shared secret has been shown, Fidant can't reach it: it can't take it back or clear it from the recipient's screen, memory or clipboard.
- **No independent audit yet.**

## Planned: verified transfers

Not built. Designed in `docs/decisions/0001-e2e-tests-and-leak-model.md`, `0002-evidence-model.md`, `0003-audit-log.md` and `0004-one-store-dynamodb.md`:

- The recipient signs a receipt with BankID before they can open the file. The receipt text names the file, the one deliberate exception to "no file names on the server".
- The key is split. The server stores one half and releases it only after the receipt is signed.
- Events go to a tamper-evident, hash-chained audit log, anchored with RFC 3161 timestamps, with parties as HMAC references instead of names or personal identity numbers.

When it ships, this document and the pages below get the new mode.

## Keeping this true

A pull request that changes security or data flow updates this document in the same pull request. That covers keys, encryption, the link format, frames, signaling messages, the connection paths and relay, what the server or relay sees, keeps or logs, limits, HTTP headers, and any new mode of transfer.

That includes "Every path and its traces" and the `/how/traces` explorer's text (`technical.explorer`).

The web pages explain the same things for readers, and change with it:

- The `/how/<step>` pages (`file`, `encryption`, `link`, `connect`, `direct`, `relay`, `transfer`, `verification`, `masking`, `traces`, `protection` and the word list `tech`): the `technical` text in `apps/web/src/i18n/en.ts` and `sv.ts`, a reader's version of this document, split over the steps by `STEPS` in `apps/web/src/how/steps.tsx`.
- `/how`, `/privacy`, `/security` and the landing page, wherever they say something the change makes untrue.
