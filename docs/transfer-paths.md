# Transfer paths: steps and traces

> Reference copy only, to be deleted before this branch merges. `docs/how-fidant-works.md` ("Every path and its traces") is the source of truth, and the checks below now run against it.

This is the audit baseline for every way a file or a shared secret moves through Fidant. For each path it lists the steps and the traces each one leaves: what is kept, where, for how long, and whether it can reveal content, names or keys. It describes the code on `main`. `docs/how-fidant-works.md` explains why the design is safe. This document lists what to check, path by path.

## How this document is checked

Every pull request is checked against it before merge:

- **The `Claude review` workflow** (`.github/workflows/claude-review.yml`), whose approval a merge needs, walks every path below against the diff. It requests changes when the diff makes a step or a trace here untrue and the same pull request doesn't update this document.
- **The review-changes skill**: the Application Security Engineer lane (`.claude/agents/application-security-engineer.md`) does the same check before a pull request opens.
- **`packages/protocol/src/transfer-paths.test.ts`**, in `pnpm check`, fails when a file this document names no longer exists, or when a signaling message type, a log event or a log field exists in `packages/protocol/src/signaling.ts` but not here. A new message or log field can't merge without an entry in this document.
- **The e2e suites** under "Checked by" in each path run in CI (`pnpm e2e`, `pnpm e2e:networks`). The `actor` fixture records every request, WebSocket frame, console message, mail, server log line and, in the networks suite, the box's journal and coturn's traffic, and fails the test if a file's bytes, name, size, hash or key appears anywhere outside its allowed carriers (`apps/e2e/src/leak-watch.ts`, `docs/decisions/0001-e2e-tests-and-leak-model.md`).

A pull request that adds a path, a step or a trace adds it here, and updates `docs/how-fidant-works.md` as `AGENTS.md` requires.

## Paths

Three choices set a transfer's path. Each combination below is a path.

| ID  | What is sent  | How the link reaches the recipient | Route of the encrypted traffic                |
| --- | ------------- | ---------------------------------- | --------------------------------------------- |
| P1  | file          | the sender passes the link on      | `direct` (local addresses) or `stun` (public) |
| P2  | file          | the sender passes the link on      | `relay` through coturn (UDP 3478 or TLS 443)  |
| P3  | file          | the sender passes the link on      | relay refused by the sender                   |
| P4  | shared secret | the sender passes the link on      | any of the routes of P1–P3                    |
| P5  | file          | Fidant emails the link and a code  | any of the routes of P1–P3                    |
| P6  | shared secret | Fidant emails the link and a code  | any of the routes of P1–P3                    |

Around every path:

- **A0, page loads and link previews**: what loading a page or previewing a link leaves, before any transfer.
- **A1, retries and failures**: decline, dropped connection, setup timeout, server restart, refused link.

Not paths yet:

- **Verified transfers** (BankID receipt, split key, audit log): planned, `docs/decisions/0002-evidence-model.md`. When built, it gets its own path here.
- **The relay box** (`apps/infra/relay/install.sh`, `sto.relay.fidant.se`): built, but serves no transfers until SIG-153. When it does, P2 gets its traces.

## Where traces can be kept

Every trace below is kept in one of these places. "Content" means file bytes, a shared secret, a file name, type or exact size, or a key.

| Place                 | Who controls it          | Kept for                                     | Can hold content?                                      |
| --------------------- | ------------------------ | -------------------------------------------- | ------------------------------------------------------ |
| Sender's browser      | the sender               | the tab's life; history and session restore  | yes: its own file, secret, links                       |
| Recipient's browser   | the recipient            | the tab's life; history, saved file          | yes: the received file or secret, the link             |
| Clipboard             | the user's OS            | until overwritten; clipboard history or sync | yes: a copied link or shared secret                    |
| Server memory         | Fidant                   | while sockets are open; counters up to 1 h   | only an emailed link's secret and typed name (P5, P6)  |
| Server journal        | Fidant                   | 29 days (`MaxRetentionSec=29day`)            | no: `LogEvent` and `LogFields` only                    |
| Caddy                 | Fidant                   | journal, 29 days                             | no: no access log; error and TLS logs excluded         |
| HAProxy               | Fidant                   | memory only (per-source counts)              | no: logs nothing                                       |
| coturn (relay)        | Fidant                   | memory while an allocation lasts             | no: encrypted packets; `log-file=/dev/null`            |
| Mail service          | Fidant's SMTP provider   | provider's policy                            | yes: an emailed link's secret and typed name, the code |
| Recipient's mailbox   | the recipient's provider | until deleted                                | yes: the emailed link with its secret, and the code    |
| Link channel          | the sender's provider    | provider's policy                            | yes: the full link with its secret (P1–P4)             |
| Networks on the route | ISPs, Wi-Fi owners       | not known                                    | no: IP addresses, timing, padded sizes                 |

## P1: a file, link passed on by the sender, direct route

### Steps

1. The sender opens `/send` and chooses a file. The browser hashes it with SHA-256 (`apps/web/src/lib/sha256.ts`). The file is read where it is and copied nowhere.
2. For each recipient the browser makes a link ID (16 random bytes) and a secret (32 random bytes): `https://fidant.se/r/<link ID>#<secret>` (`apps/web/src/lib/link.ts`). The secret stays in the fragment and in memory.
3. The page opens the `/signal` WebSocket. The server sends `hello`. The page sends `host` with the link IDs and its relay choice (`apps/web/src/send/SendPage.tsx`, `apps/server/src/signaling.ts`).
4. The sender copies the link and passes it on over a channel of their choice.
5. The recipient opens the link. The browser requests `/r/<link ID>`. The fragment is never sent.
6. The recipient's page sends `join` with the link ID and a fresh attempt ID. The server pairs the sockets and sends `joined` to both, with STUN URLs and, if the relay is allowed, TURN credentials.
7. The pages exchange the SDP offer, answer and ICE candidates as `relay` messages, each sealed with the signal key (HKDF of the secret, `apps/web/src/lib/keys.ts`). The server passes them on and can't read them.
8. The WebRTC data channel opens. The sender reports the route with `path`.
9. Frames (`apps/web/src/lib/frames.ts`): INIT (random transfer ID, in clear), META (name, size, type, sender's typed name, encrypted, padded to 1,024 bytes). The recipient sends ACCEPT or DECLINE. Then CREDIT, CHUNK (padded with Padmé, fixed length), END (SHA-256 and size), RECEIPT (`apps/web/src/lib/send-file.ts`, `apps/web/src/lib/receive-file.ts`).
10. The recipient's page checks every chunk, the padding, the size and the hash, then keeps the file (`apps/web/src/lib/sink.ts`). The sender marks the link used when RECEIPT matches; later joins get `used`.

### Traces

| Where               | What                                                                                                                     | Kept for                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Sender's browser    | file, hash, links, keys in memory; `console.warn` of a drop reason and an error name, never detail or names              | until the tab closes                    |
| Sender's browser    | the copied link on the clipboard                                                                                         | until overwritten                       |
| Link channel        | the full link, secret included, in the chat, mail or SMS service the sender passes it on through, and its link previewer | the provider's policy                   |
| Sender's browser    | `localStorage`: theme and language only                                                                                  | until cleared                           |
| Recipient's browser | the link, secret included, in history and in memory for "Go back to it"                                                  | history: until cleared                  |
| Recipient's browser | the file where they saved it (Chromium: chosen place; others: a Blob, then downloads, as `application/octet-stream`)     | until deleted                           |
| Server memory       | both IP addresses, link IDs, which socket hosts or joined which link, relay choice                                       | until the sockets close (≤ 1 min after) |
| Server journal      | `host` (link count), `joined`, `relay` (6-char link prefix, bytes), `path` (route only, no link), `left`, `host-closed`  | 29 days                                 |
| Caddy, HAProxy      | nothing kept; addresses in memory for HAProxy's per-source cap                                                           | memory only                             |
| STUN (coturn)       | each browser's public address for the binding request                                                                    | not logged                              |
| Networks            | both IP addresses, timing, padded size, DTLS and AES-GCM ciphertext                                                      | not known                               |

### Audit checklist

- The secret and keys never reach a request, a WebSocket message, `console.*` or storage.
- `host`, `join`, `joined` and `relay` carry no name, size, type or key; `relay` data is sealed.
- META and every frame after INIT are encrypted; META stays 1,024 bytes and CHUNKs stay one size.
- The server logs only `LogFields`, and links only by their 6-character prefix.

### Checked by

`apps/e2e/tests/first-demo.spec.ts` ("delivers a file to two recipients with a verified checksum", "a hostile path"), `apps/e2e/tests/networks.spec.ts` (direct and STUN routes), `apps/e2e/tests/leaks.spec.ts`, `apps/web/src/lib/frames.test.ts`, `apps/web/src/lib/keys.test.ts`, `apps/server/src/signaling.test.ts`.

## P2: a file through the relay

As P1, except at step 8 the only working route is our TURN relay.

### Steps

1. `joined` carries `turn:turn.fidant.se:3478?transport=udp`, `turns:turn.fidant.se:443?transport=tcp` and a credential minted for this pairing: username = expiry 5 minutes ahead, credential = HMAC-SHA1 under the secret only the server and coturn hold (`apps/server/src/turn.ts`).
2. Each browser allocates on coturn and sends its encrypted traffic through it. On 443, HAProxy reads only the TLS server name and passes the connection to coturn without decrypting it (`apps/infra/box/user-data.sh`).
3. coturn forwards UDP only, from the box's private address, never to internal ranges (`apps/infra/box/turnserver.conf`).

### Traces

All of P1's, plus:

| Where          | What                                                                                                | Kept for                   |
| -------------- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| coturn memory  | both IP addresses (127.0.0.1 for TLS through HAProxy, real peer addresses inside), allocation sizes | while the allocation lasts |
| coturn log     | nothing (`log-file=/dev/null`); a temporary log only to fix a fault or stop abuse, at most 7 days   | at most 7 days, when on    |
| Server journal | `path` with `relay`                                                                                 | 29 days                    |
| Box network    | encrypted packets with padded sizes                                                                 | not stored                 |

### Audit checklist

- TURN credentials go only to the two paired sockets and are never logged.
- coturn keeps `log-file=/dev/null`, `no-tcp-relay`, `relay-ip` and the `denied-peer-ip` list.
- HAProxy still passes `turn.fidant.se` on without decrypting and still logs nothing.

### Checked by

`apps/e2e/tests/relay.spec.ts` ("a transfer forced through the TURN relay over ..."), `apps/e2e/tests/networks.spec.ts` ("the leak scan sees what reaches coturn", "logs a relayed transfer only to its journal, within the allowlist"), `apps/server/src/turn.test.ts`.

## P3: a file with the relay refused

As P1, with "Allow our relay" off on the send page.

### Steps

1. `host` carries `turn: false`. The server mints no TURN credential, and `joined` carries only `stun:` URLs.
2. If the sender's selected candidate pair still reads `relay`, the sender ends the attempt and reports `failed` (`apps/web/src/send/SendPage.tsx`).

### Traces

P1's, except that `joined` still carries the `stun:` URLs, which on the box point at coturn (`stun:turn.<domain>:3478`, plus IPv6). coturn still sees each browser's public address for the STUN binding request, and logs nothing. A relay route ends the attempt: the sender reports `path` with `failed`, then refuses the recipient with `drop`, so the journal has `path` with `failed` and `refused` with `drop`. `path` with `failed` is also logged when no route works.

### Audit checklist

- With `turn: false`, `joined` holds no `turn:` or `turns:` URL and no credential.
- The backstop runs before any CHUNK: file data flows only after ACCEPT.

### Checked by

`apps/e2e/tests/relay.spec.ts` ("a sender who refuses the relay: no credentials, no bytes, plain words on both pages", "a sender who refuses the relay and fails setup shows the refused relay"), `apps/server/src/turn.test.ts`.

## P4: a shared secret, link passed on by the sender

As P1–P3, over the same frames.

### Steps

1. The sender types or pastes on `/secret`, at most 10,000 UTF-16 code units. The browser turns it into an in-memory file `secret.txt` of type `application/x-fidant-text` (`apps/web/src/lib/text-secret.ts`).
2. On a connection whose maximum message size is under 32,832 bytes, the sender sends nothing, not even INIT (`textFitsOneChunk`). Otherwise the secret pads to exactly one CHUNK, whatever its length.
3. The recipient sees "<name> sent you a secret" with no size or type. Show collects it in memory (`BlobSink`), checks it, and shows it as a text node in a `<pre>`. It is never downloaded or put in a form field (`apps/web/src/receive/ReceivePage.tsx`).

### Traces

P1–P3's, except the recipient keeps no file, plus:

| Where               | What                                                                                                                                | Kept for                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Sender's browser    | the secret in a `<textarea>`, which a browser can save with its session                                                             | until the session is discarded                |
| Recipient's browser | the decoded secret in page memory                                                                                                   | until the tab closes                          |
| Clipboard           | the secret, if the recipient presses Copy                                                                                           | until overwritten; clipboard history and sync |
| Server              | a full load of `/secret` is an HTTP request for that path; the server can tie the next `/signal` connection from that address to it | memory only; not logged                       |

### Audit checklist

- Every shared secret still crosses the network as one CHUNK of the same size.
- The recipient's page never downloads it, never puts it in a form field and never parses it as HTML.
- The textarea keeps `spellcheck=false`, `translate=no`, `writingsuggestions=false` and `autocomplete`, `autocorrect`, `autocapitalize` off.

### Checked by

`apps/e2e/tests/secret.spec.ts`, `apps/web/src/lib/text-secret.test.ts`.

## P5: a file, Fidant emails the link

The one path where a link's secret leaves the browser (`docs/decisions/0012-email-recipients.md`). Offered only when the server has a mail service: `hello` says `mail: true`. Production sends no mail until `sigill-credential mail on` is run on the box (`AGENTS.md`).

### Steps

1. The sender ticks "Email the link for me (less private)", which is off on every page load and first shows what emailing costs (`docs/decisions/0013-email-link-opt-in.md`), then gives the recipient's address. The page hosts the link as in P1, then sends one `email` message: link ID, address, the link's secret, the sender's typed name and the page language.
2. The server checks limits, picks a random value (16 bytes, never derived from the secret), binds the link to the address, language and value, and makes one attempt to hand the notice to the mail service: `<PUBLIC_ORIGIN>/r/<link ID>#e.<value>.<secret>` with the typed name marked as not verified (`apps/server/src/mail.ts`).
3. The server answers the sender with `email {status, mark}`: the value, never the secret. The sender's page builds the same marked link.
4. The recipient opens the emailed link and sends `gate` with the value. The server answers with the masked address.
5. The recipient asks for a code (`send-code`). The server emails a 6-digit code to the bound address, valid 10 minutes or 5 wrong tries.
6. The recipient sends `code`. A right code gets a `token` (16 random bytes). The page keeps it in `sessionStorage` as `token:<link ID>` and joins with it.
7. From `join` on, as P1–P3.

### Traces

All of P1–P3's, except the link channel (Fidant sends the link), plus:

| Where               | What                                                                                                                  | Kept for                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Server memory       | the link's secret and typed name                                                                                      | until the one send attempt ends (bounded by nodemailer's timeouts) |
| Server memory       | the address, language, value, current code with expiry and tries, tokens, whether the link had its `email` or a guest | while the sender hosts the link; gone on unhost or restart         |
| Server memory       | HMAC-SHA-256 of the address and of the client address (random key per start), with send times                         | at most 1 hour                                                     |
| Server journal      | `email` and `code` (6-char link prefix, outcome), `verified`, `refused` with `unverified`                             | 29 days                                                            |
| Mail service        | the notice (address, typed name, link with its secret) and the code mail                                              | the provider's policy                                              |
| Recipient's mailbox | both mails; link scanners may fetch the link but can't connect without the code                                       | until deleted                                                      |
| Recipient's browser | the token in that tab's `sessionStorage`                                                                              | until the tab closes                                               |

What the server could do with the secret: open that link's sealed setup messages and sit in the middle of the transfer. The code doesn't stop this. Check words will (SIG-109, planned).

### Audit checklist

- The secret reaches the server only in the `email` message, and only the mail service gets it from there. It is never stored past the send attempt and never logged.
- `host` still carries only link IDs; the reply to the sender carries the value, never the secret.
- The link is built from `PUBLIC_ORIGIN`, never from the request.
- No mail names the file, its size or type, or says whether it is a file or a secret.
- The server never logs addresses, codes, tokens or the value.
- A wrong or missing value gets the same `gate` answer as a plain link.

### Checked by

`apps/e2e/tests/first-demo.spec.ts` ("emailed links"), `apps/e2e/tests/leaks.spec.ts` ("an emailed link"), `apps/server/src/signaling.test.ts`, `apps/server/src/mail.test.ts`.

## P6: a shared secret, Fidant emails the link

P5's steps and traces, with P4's sending and showing. The notice says "a file or a secret" for both, so the mail doesn't reveal which it is.

### Checked by

`apps/e2e/tests/first-demo.spec.ts` ("a text from /secret can be emailed and shows after the code").

## A0: page loads and link previews

### Steps and traces

| Event                               | What reaches us                                                                                                                                                                        | Kept                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Any page load                       | the path, IP address, browser headers; never the fragment (`Referrer-Policy: no-referrer`)                                                                                             | not logged by Caddy or the server |
| A link preview fetcher on `/r/<ID>` | the path with the link ID, never the fragment. It gets fixed Open Graph text (`apps/server/src/server.ts`). The fetcher is usually the chat, mail or SMS service the link went through | not logged                        |
| A WebSocket upgrade                 | `Origin`; refused off `/signal` or from another site, logged as `upgrade-rejected` with a reason                                                                                       | journal, 29 days                  |
| The page itself                     | no cookies, no third-party scripts, fonts or trackers (CSP `default-src 'self'`)                                                                                                       | nothing                           |

### Checked by

`apps/e2e/tests/smoke.spec.ts` (the blocker refuses any request outside the stack), `apps/server/src/server.test.ts`, `apps/server/src/no-log-files.test.ts`.

## A1: retries and failures

| Event                                                                                                    | What happens                                                                                                                                                             | Extra traces                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decline                                                                                                  | The recipient's page closes its signaling socket. The sender marks the link declined and the link stays usable. A new attempt gets a new transfer ID and file key.       | `left`; no `refused`, because a decline sends no `refuse`                                                                                                         |
| Setup timeout (sender's 20 s)                                                                            | The sender reports `path` with `failed`, refuses the recipient with `drop`, closes the connection and waits again. The recipient ends with a failure and doesn't rejoin. | `path` with `failed`, `refused` with `drop`                                                                                                                       |
| Dropped channel before delivery                                                                          | The sender refuses the recipient with `drop`, as above. The recipient ends with a failure and doesn't rejoin.                                                            | `refused` with `drop` while the recipient is still joined; `path` with `failed` if ICE failed; `console.warn` of the reason                                       |
| Recipient's own timeout (30 s)                                                                           | The recipient ends with a failure and closes its signaling socket. The sender waits again.                                                                               | `left`                                                                                                                                                            |
| Recipient's signaling socket drops before the channel opens, or `refused` with `unknown` after a restart | The recipient rejoins with a new attempt ID, up to 4 times.                                                                                                              | Socket drop: `left`, then `joined` on a rejoin. After a restart: no `left`; `refused` with `unknown` for each rejoin before the sender hosts again, then `joined` |
| Used, busy, unknown link                                                                                 | `used`: the sender's page answers `refuse` and the server forwards it. `busy` and `unknown`: the server refuses the join itself.                                         | `refused` with `used`, `busy` or `unknown`                                                                                                                        |
| Sender's socket drops                                                                                    | The sender reconnects and hosts again, except emailed links, whose binding the server dropped. A recipient who had joined gets `host-gone`.                              | `host-closed`, `host-gone`                                                                                                                                        |
| Server restart                                                                                           | All memory is gone, emailed bindings included. Open data channels keep running.                                                                                          | none beyond the journal                                                                                                                                           |
| Tampered, replayed or reflected frame or signal                                                          | The reader stops for good; the sink discards what was written.                                                                                                           | none                                                                                                                                                              |

### Checked by

`apps/e2e/tests/first-demo.spec.ts` ("refuses used, unknown and malformed links", "a sender whose connection setup fails logs why and lets the recipient try again", "a declined offer shows as declined, and the link can be reopened", "through a server restart", "a hostile path"), `apps/e2e/tests/secret.spec.ts`.

## Reference: every signaling message

`packages/protocol/src/signaling.ts`. The server reads every field listed here. None carries file content, a file name, type or size, or a key, except `email`.

| Message     | Direction            | Fields                                         | Path   | Sensitive                                                  |
| ----------- | -------------------- | ---------------------------------------------- | ------ | ---------------------------------------------------------- |
| `hello`     | server → page        | `mail`                                         | all    | no                                                         |
| `host`      | sender → server      | `links` (IDs), `turn`                          | all    | no                                                         |
| `join`      | recipient → server   | `link`, `attempt`, `token` on an emailed link  | all    | `token` is a bearer value, never logged                    |
| `joined`    | server → both        | `link`, `attempt`, `iceServers`, `turn`        | all    | TURN credential, never logged                              |
| `relay`     | page → server → page | `link`, `data` sealed with the signal key      | all    | sealed; server can't read it (except P5, P6)               |
| `refuse`    | sender → server      | `link`, `attempt`, `reason`                    | A1     | no                                                         |
| `refused`   | server → recipient   | `reason`                                       | A1     | no                                                         |
| `left`      | server → sender      | `link`                                         | A1     | no                                                         |
| `host-gone` | server → recipient   | none                                           | A1     | no                                                         |
| `error`     | server → page        | `code`                                         | A1     | no                                                         |
| `path`      | sender → server      | `link`, `path`                                 | all    | no; logged without the link                                |
| `email`     | sender → server      | `link`, `to`, `secret`, `from`, `lang`         | P5, P6 | **yes: the link's secret, the address and the typed name** |
| `email`     | server → sender      | `link`, `status`, `mark`                       | P5, P6 | `mark` is the value, never logged                          |
| `gate`      | recipient ⇄ server   | `link`, `mark` / `link`, `to` (masked address) | P5, P6 | `mark`, never logged                                       |
| `send-code` | recipient → server   | `link`, `mark`                                 | P5, P6 | `mark`, never logged                                       |
| `code`      | recipient ⇄ server   | `link`, `code`, `mark` / `link`, `result`      | P5, P6 | `code`, never logged                                       |
| `token`     | server → recipient   | `link`, `token`                                | P5, P6 | `token`, never logged                                      |

## Reference: every server log line

Written as one JSON line, `{event, ...fields}`, to stdout and from there to the journal (29 days). `LogEvent` and `LogFields` in `packages/protocol/src/signaling.ts` are the only allowed shape; /privacy lists them from the same type.

Fields: `link` (first 6 characters of a link ID), `links` (a count), `bytes` (a message size), `reason`, `code` (an error code), `port`, `path` (the route).

| Event              | Fields           | Path           |
| ------------------ | ---------------- | -------------- |
| `listening`        | `port`           | start          |
| `upgrade-rejected` | `reason`         | A0             |
| `bad-message`      | `bytes`          | A1             |
| `rate-limited`     | none             | A1             |
| `error`            | `code`           | A1             |
| `host`             | `links`          | all            |
| `host-gone`        | `link`           | A1             |
| `host-closed`      | `links`          | A1             |
| `joined`           | `link`           | all            |
| `refused`          | `link`, `reason` | A1, P3, P5, P6 |
| `relay`            | `link`, `bytes`  | all            |
| `relay-dropped`    | `link`, `bytes`  | A1             |
| `path`             | `path`           | all            |
| `left`             | `link`           | A1             |
| `email`            | `link`, `reason` | P5, P6         |
| `code`             | `link`, `reason` | P5, P6         |
| `verified`         | `link`           | P5, P6         |
