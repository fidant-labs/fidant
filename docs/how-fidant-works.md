# How Fidant works

This is the source of truth for how Fidant moves a file or a text and why no infrastructure can read it. It describes the code on `main` today. Planned work is marked as planned.

A change to security or data flow updates this document in the same pull request, and then the web pages that explain it (see "Keeping this true" at the end).

## Parts

| Part                  | Where                                    | What it does                                                                                                      |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Web app               | `apps/web`, runs in each browser         | Creates links and keys, encrypts and decrypts, checks the file. All cryptography happens here.                    |
| Server                | `apps/server`, the box at fidant.se      | Serves the web app over HTTPS and passes setup messages between browsers on the `/signal` WebSocket.              |
| Relay (STUN and TURN) | coturn at `turn.fidant.se`, the same box | Tells browsers their public address (STUN) and carries encrypted traffic when they can't connect directly (TURN). |
| Shared protocol       | `packages/protocol`                      | Signaling message types, parsers and limits used by both the server and the web app.                              |

The box is an AWS Lightsail instance in Stockholm (eu-north-1). There are no accounts, no database and no file storage. The server holds what it knows only in memory.

## The link

`apps/web/src/lib/link.ts`

For each recipient the sender's browser creates a link:

```
https://fidant.se/r/<link ID>#<secret>
```

- **Link ID**: 16 random bytes, base64url (22 characters). The server sees it and uses it only to pair the two browsers.
- **Secret**: 32 random bytes, base64url (43 characters), in the URL fragment. Browsers don't send the fragment to servers, and the site sets `Referrer-Policy: no-referrer`. The app never sends the secret anywhere; it only derives keys from it. The router reads the fragment only on `/how`, where it is a section anchor.

Both come from `crypto.getRandomValues`. Every recipient gets their own link ID and secret.

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
sender    → server     host {links, turn}
recipient → server     join {link, attempt}
server    → both       joined {link, attempt, iceServers, turn}
sender    → recipient  relay seal_s({offer, sdp})
recipient → sender     relay seal_r({answer, sdp})
both                   relay seal({ice, candidate})        trickle
sender ⇄ recipient     WebRTC data channel "sigill" opens
```

- The sender's page registers its link IDs with `host`, along with whether it allows our relay (`turn`).
- The recipient's page joins with the link ID and an attempt ID: random, new for each page load, each "Try again" and each automatic retry.
- The server binds at most one recipient page to a link and sends `joined` to both. It keeps no record of used links. The sender's page decides and answers with `refuse` (`used`, `busy`, `unknown` or `drop`).
- Every SDP and ICE message is sealed with the signal key: `base64url(iv(12) ‖ AES-GCM ciphertext ‖ tag(16))` with the additional data `sigill/v1/signal|<link ID>|<attempt>|<direction>`. The server can't read or change them, can't reflect a message to its sender, can't move it to another link, and can't replay it into another attempt.
- The SDP carries the DTLS certificate fingerprints of the WebRTC connection. Because the server can't change them, it can't put itself between the browsers.
- If the WebSocket drops, the two pages behave differently. The sender's page opens a new socket after a growing, jittered delay (`signaling-client.ts`) and sends `host` again with all its links (`SendPage.tsx`). A recipient whose data channel hasn't opened, on a socket that had opened, starts a new attempt at once with a new socket and a new attempt ID, up to 4 times (`MAX_REJOINS`), then fails; a socket that never opened is left to the signaling client's own retries (`ReceivePage.tsx`). After a drop, `refused: unknown` makes the recipient wait and try again, because a restarted server only knows the link once the sender hosts it again. Once the data channel is open, the transfer no longer needs the server, so a drop only closes signaling.
- Accepted residue: the sender learns the attempt ID from the server's `joined`, so a lying server could replay one old attempt's recipient signals to the sender. That only breaks that attempt: the replayed answer names a DTLS fingerprint of a closed connection, so no channel opens.

## Two layers of encryption

WebRTC encrypts the data channel with DTLS. Fidant doesn't rely on that: every frame on the channel after INIT is also encrypted with AES-256-GCM under the file key, which only the two browsers hold. INIT is sent in clear and carries only the random transfer ID, which is the file key's salt; changing it changes the key, so the next frame fails to decrypt.

## Frames

`apps/web/src/lib/frames.ts`

```
frame  = header(10) ‖ body
header = version(1) ‖ kind(1) ‖ seq(8, u64 big-endian)   plaintext, and the AES-GCM additional data
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

- Sequence numbers start at 0 in each direction. A reader accepts only the next one, and stops for good after any failure, so a dropped, reordered, repeated or altered frame ends the transfer.
- The two directions use different nonces because the direction is in the IV.
- Changing INIT changes the derived key, so META then fails to decrypt.
- Each kind has a fixed direction and body size range; anything else is rejected.

## The transfer

`apps/web/src/lib/send-file.ts`, `apps/web/src/lib/receive-file.ts`

1. When the file is chosen, or each time a text changes, the sender's browser computes its SHA-256 (`apps/web/src/lib/sha256.ts`, streamed in 4 MiB slices).
2. INIT, then META. The recipient sees the name, size, type and the sender's typed name (for a text, only the sender's name), and chooses.
3. The recipient sends ACCEPT or DECLINE, encrypted. ACCEPT also proves that the recipient holds the key. No file data is sent before it. After DECLINE the link still works.
4. CHUNK frames, `chunkSize = min(48 KiB, maxMessageSize − 64)`, sent with backpressure on the channel buffer.
5. END with the checksum and the exact size.
6. The recipient checks and sends RECEIPT with the checksum it computed. The sender marks the link delivered only when it matches.

### Checking on the recipient's side

`ReceiveVerifier` in `frames.ts` hashes the file bytes as they arrive and checks that every CHUNK is exactly `chunkSize`, the padding is zeros, the chunks add up to the padded length, and END's size and checksum match what arrived. Only then is the file kept. Any other ending (a frame that fails to decrypt, the wrong order, too much data, the channel closing first) aborts the sink, which discards what was written.

`apps/web/src/lib/sink.ts`: where the browser has `showSaveFilePicker` (Chromium), the file streams to a place the recipient chose. Elsewhere it is collected in memory as a Blob and downloaded at the end. A text is always collected in memory and never downloaded (see "Sharing a text"). The Blob is always `application/octet-stream`, whatever type the sender claims, so a file can't run as a page in Fidant's origin.

### Names

META refuses names, types and sender names containing control characters or Unicode direction controls (U+200E, U+200F, U+202A–202E, U+2066–2069), so a name ending in `.exe` can't be displayed as one ending in `.pdf`. The sender's name is typed by the sender and not verified.

## Padding

`paddedLength` in `frames.ts`

Anyone who sees the encrypted traffic (the networks, our relay) sees frame sizes. So:

- The size is rounded up with Padmé (Nikitin et al., 2019), which adds at most 12 %, then up to a whole number of chunks. An empty file is padded like a 1-byte file.
- Every CHUNK frame has the same length. The exact size travels only inside the encrypted META and END.
- META is always 1,024 bytes, so the name's length doesn't show.
- A text is at most 32 KiB. Whenever `chunkSize` is at least 32 KiB (a maximum message size of at least 32,832 bytes), every text pads to exactly one CHUNK, so all texts on a connection have the same frame sizes. When the maximum message size is at least 49,216 bytes, `chunkSize` is 48 KiB, and a text then has the same frame sizes as any file of up to 48 KiB.
- Measured on 2026-11-24 with Playwright's browser builds: Chromium 159 and WebKit 27.2 report a maximum message size of 262,144 bytes, Firefox 159 reports 1,073,741,823, and pairs of different browsers settle at 262,144. When a browser reports none, the app uses 65,536 (`DEFAULT_MAX_MESSAGE_SIZE` in `peer.ts`). So today every text crosses the network as one 48 KiB CHUNK.

An observer learns a file's size only roughly, plus the chunk size, which follows from the connection's maximum message size. A text's length doesn't show at all while the maximum message size is at least 32,832 bytes, as it is in every browser measured above.

## Sharing a text

`apps/web/src/lib/text-secret.ts`, `apps/web/src/send/SendPage.tsx`, `apps/web/src/receive/ReceivePage.tsx`

`/secret` sends a typed or pasted text instead of a file, over the transfer above unchanged: the same keys, frames, checks, RECEIPT and one-time links. The server, the relay and the signaling messages are the same as for a file.

- The sender's browser turns the text into an in-memory file named `secret.txt` of type `application/x-fidant-text`. The name and type travel inside the encrypted META, like any file's.
- A text is at most 10,000 UTF-16 code units (`MAX_TEXT_LENGTH`), so at most 30,000 bytes of UTF-8. The field has no `maxlength`, so a longer paste stays whole. While it is over the limit, the field is marked invalid and shows its length against the limit (for example "12,000 of 10,000 characters"), `textFile` refuses it, and no link can be added, so a text is never sent cut.
- The field has `spellcheck=false`, `translate=no`, `writingsuggestions=false`, and `autocomplete`, `autocorrect` and `autocapitalize` set to `off`, which tell the browser to keep its spelling, autocomplete, writing suggestions and translation features off the text.
- The recipient's page treats an offer as a text only when its type is exactly `application/x-fidant-text` and its size is at most 32 KiB (`isTextOffer`, `MAX_TEXT_BYTES`). Anything else is offered as a file.
- A text offer shows "<sender's name> sent you a text" with Show and Decline, and no name, size or type. Show always collects the text in memory (`BlobSink`): never a save dialog, never a download.
- Only after the checks in "Checking on the recipient's side" pass does the page decode the text, as UTF-8 (invalid bytes become U+FFFD). It shows the text as a text node in a `<pre>`, never parsed as HTML, inside a labelled box with `translate=no` that keyboard users can focus and scroll. No form field holds the text, because a browser can save a form field's value with its session. Copy calls `navigator.clipboard.writeText` with the decoded string.
- As for a file: nothing is stored, so the sender's page must stay open; each recipient's link works once; after Decline the link still works.
- Loading `/secret` from the server (typing its address, a reload, a bookmark or a link from elsewhere) is an HTTP request for that path, so the server can see that someone opened the page. Every sender page, including `/secret`, then opens its own `/signal` WebSocket and sends `host` with its links, and moving to `/secret` inside the app opens that connection too. The server never gets the text or its length, and a signaling connection doesn't say which page opened it, but after a full load of `/secret` the server can tie the connection that follows from the same address to the visit, and infer that this visitor shares a text and with how many links. Neither the server nor Caddy logs page requests.

## How the file travels

`apps/server/src/turn.ts`, `apps/infra/box/turnserver.conf`, `docs/decisions/0007-turn-relay.md`

WebRTC tries the paths in this order, and the sender's page shows which one each connection took:

| Path     | Meaning                                                | Who sees the encrypted traffic |
| -------- | ------------------------------------------------------ | ------------------------------ |
| `direct` | the browsers reach each other's local addresses        | the networks between them      |
| `stun`   | through public addresses learned from our STUN service | the networks between them      |
| `relay`  | through our TURN relay, when no direct route works     | the networks and our relay     |

- On any path each browser sees the other's IP address, like on a video call. STUN sees each browser's address for the binding request, and no file data passes through it.
- Relay credentials are minted by the server for each pairing and sent only to the two paired sockets: the username is an expiry time 5 minutes ahead and the credential is HMAC-SHA1 of it under a secret that only the server and coturn hold. The expiry limits starting a relay connection, not how long it may run.
- Browsers can reach coturn over UDP or TCP, but coturn forwards only over UDP (`no-tcp-relay`). It refuses to forward to other machines on private, loopback, link-local and other internal ranges (`denied-peer-ip`). The accepted exception is that relay clients can reach UDP services on the box's own private address and its global IPv6 address (`docs/decisions/0007-turn-relay.md`, Consequences). It also caps concurrent allocations (`total-quota=200`), and writes no log (`log-file=/dev/null`). Its listener is plain UDP and TCP on port 3478; the traffic it carries is DTLS and AES-GCM.
- The relay forwards encrypted packets. It can't decrypt them and doesn't store them.

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
- Until then the link can be opened again: after a decline, a dropped connection, a setup timeout (20 s) or a checksum mismatch. Each attempt has a new transfer ID and so a new file key.
- Nothing is stored, so a link works only while the sender's page is open. When the sender's socket closes, the server forgets its links, within a minute at most (heartbeat every 30 s).

## What the server and relay see, keep and log

|            | Server                                                                                                                                                                                                                                                                                                                     | Relay                                                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Sees       | IP addresses and browser details of each page; link IDs; the sender's relay choice; the connection path the sender reports for each attempt (direct, stun, relay or failed); whether a link was already used (the sender's refuse reasons); when each side connects and disconnects; sealed setup messages and their sizes | Both browsers' IP addresses; encrypted packets, with the file size only roughly and a text's length not at all             |
| Never sees | the file, its name, type or exact size, a shared text or its length, the secret, the keys, the content of setup messages                                                                                                                                                                                                   | the same                                                                                                                   |
| Keeps      | in memory only, while the pages are connected; forgotten within a minute after a page disconnects                                                                                                                                                                                                                          | nothing of the file once it has passed                                                                                     |
| Logs       | events with a fixed set of fields (`LogEvent`, `LogFields` in `packages/protocol`): the first 6 characters of a link ID, link counts, message sizes, refuse and error codes, the connection path, the port. Never names, keys, file data or IP addresses. Deleted after 30 days (journald, `MaxRetentionSec=29day`).       | nothing by default. Only to fix a fault or stop abuse: connection times, IP addresses and data volumes, for at most 7 days |

/privacy lists every log field, generated from the same type.

## The web app and the server

`apps/server/src/server.ts`, `apps/web/src/main.tsx`, `apps/web/src/i18n/preview.ts`, `apps/web/vite.config.ts`, `apps/infra/box/user-data.sh`

- HTTPS only, with `Strict-Transport-Security` (Caddy, Let's Encrypt). Send and receive refuse to run outside a secure context.
- `Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`: code, styles, fonts and connections only from our own origin, and no framing. `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- No cookies, no third-party scripts, fonts or trackers.
- Static files are served only from the build directory; path traversal is refused.
- A path without a file extension gets one of four copies of `index.html` whose link preview (Open Graph tags) holds only fixed text: a receive link (`/r/<link ID>`) says something was sent to you, any other path says what Fidant is. The server picks the copy by path and by whether `Accept-Language` starts with `sv`, and sends `Vary: Accept-Language`. Like a browser, a preview fetcher sends us the path but never the part after `#`.
- The WebSocket accepts upgrades only on `/signal`, and refuses one whose `Origin` is another site.
- Limits: 1,000 sockets, 32 per client address (an IPv6 address counts by its /64), 1,000 messages per socket per 30-second window, 256 links per sender, 16,384 characters per relayed setup message, 256 KiB queued to a socket that isn't reading.

## What Fidant doesn't protect against

- **The link is the key.** Anyone who gets a link can open its file or text until it is used. Send each link only to its recipient, over a channel you trust.
- **The served code.** The browser runs the code our server sends. A server that sent different code could read files. The code is public, but a browser can't yet check that what it received matches it.
- **Unverified sender name.** Typed by the sender.
- **Metadata.** The other browser sees your IP address. The networks and, on the relay path, our relay see both IP addresses, timing and the rough size. Our server sees both IP addresses, which recipient connects to which sender, when, and how many recipients a sender has. So it learns who sends to whom, though not what.
- **Compromised devices.** Malware on either computer can read the file before encryption or after decryption.
- **Copied text.** When the recipient copies a text, it goes to the operating system's clipboard, where clipboard history, cloud clipboard sync and other apps can read it. Once a text has been shown, Fidant can't reach it: it can't take it back or clear it from the recipient's screen, memory or clipboard.
- **No independent audit yet.**

## Planned: verified transfers

Not built. Designed in `docs/decisions/0001-e2e-tests-and-leak-model.md`, `0002-evidence-model.md`, `0003-audit-log.md` and `0004-one-store-dynamodb.md`:

- The recipient signs a receipt with BankID before they can open the file. The receipt text names the file, the one deliberate exception to "no file names on the server".
- The key is split. The server stores one half and releases it only after the receipt is signed.
- Events go to a tamper-evident, hash-chained audit log, anchored with RFC 3161 timestamps, with parties as HMAC references instead of names or personal identity numbers.

When it ships, this document and the pages below get the new mode.

## Keeping this true

A pull request that changes security or data flow updates this document in the same pull request. That covers keys, encryption, the link format, frames, signaling messages, the connection paths and relay, what the server or relay sees, keeps or logs, limits, HTTP headers, and any new mode of transfer.

The web pages explain the same things for readers, and change with it:

- `/technical`: the `technical` text in `apps/web/src/i18n/en.ts` and `sv.ts`, a reader's version of this document.
- `/how`, `/privacy`, `/security` and the landing page, wherever they say something the change makes untrue.
