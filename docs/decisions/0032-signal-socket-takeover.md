# 0032: A new signaling socket takes over a transfer's attempt

- Status: Accepted
- Date: 2026-11-27
- Linear: FID-349

This record amends 0006, 0012 and 0031. Read them with the replacements under Decision.

## Context

- 0031 recovers a transfer whose route drops after its data channel opened, by an ICE restart on the same connection. It needs both pages' signaling sockets. A real change of network, such as a laptop moving from Wi-Fi to a phone's hotspot, changes the page's IP address and drops its WebSocket as well. 0031 left that case to this issue.
- When the recipient's socket drops after its channel opened, its page closes its signaling client and opens no new socket (`onClose` in `apps/web/src/receive/ReceivePage.tsx`). It can't send the repeated `join` that 0031 needs.
- When the sender's socket drops, its page connects again and sends `host` (`onOpen` in `apps/web/src/send/SendPage.tsx`). The server has already unhosted every link of the old socket at its close (`disconnect()` in `apps/server/src/signaling.ts`). That sends `host-gone` to each bound recipient, and drops each emailed link's binding (0012). A recipient that got `host-gone` doesn't ask (0031).
- The server learns of a close only when it happens. A socket whose page went away without a close is ended by the heartbeat 30 to 60 s later (`HEARTBEAT_MS`). Until then, a page's new socket meets `already-hosted` on `host` and `busy` on `join`, because the old socket still holds the link.
- The server can't tell a page's new socket from anyone else's. The attempt ID is no proof: the recipient makes it, and the server sends it to the sender in `joined` (0006). The link secret and the keys never reach the server, so they can't be the proof either (Invariants in `AGENTS.md`).
- Email is off on every deployment (0030). The server's email code stays, with its tests.
- On 2026-11-27 the maintainers chose the hold's length, to keep emailed links bound through a takeover, the sender's re-sent `host`, and both kinds of end-to-end test (see Decision).

## Options considered

| Option                                                                                     | For                                                                                                              | Against                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Do nothing: the attempt ends, and "Try again" continues the file (FID-92)                  | Nothing to build.                                                                                                | The recipient must act. On a link with the safety number, the two people compare a new number.                                                                   |
| The attempt ID as proof                                                                    | No new value.                                                                                                    | The sender's page and the server both know it (0006). The sender could take the recipient's side.                                                                |
| A proof derived from the link secret or the keys                                           | No value from the server.                                                                                        | The server must never hold anything that derives from them. It would change `join` and the email gate.                                                           |
| One token per socket, handed out in `hello`                                                | One value per page.                                                                                              | It would take over everything the socket held: idle links and email bindings that 0012 drops at a close. It reaches further than a transfer in progress needs.   |
| One resume token per attempt and per side, from the server (chosen)                        | It reaches only one attempt and one side. Each page holds only its own.                                          | A new message, `resume`. The server keeps two more values per transfer in progress.                                                                              |
| Take over only once the server has seen the old socket close                               | No socket is ended early.                                                                                        | A page whose old socket is still open on the server waits up to 60 s for the heartbeat. ICE consent runs out after 30 s (RFC 7675).                              |
| Take over a socket that is still open, and end it at once (chosen)                         | The page doesn't wait for the heartbeat.                                                                         | A token that leaks lets its holder cut that page off (see Consequences).                                                                                         |
| End the old socket with a private close code                                               | The old page could learn why.                                                                                    | The old page is the one that lost its network, so it won't read it. A new code in the protocol.                                                                  |
| End the old socket with `terminate()` (chosen)                                             | What the heartbeat already does.                                                                                 | The old page sees 1006.                                                                                                                                          |
| Hold an attempt after every close                                                          | Covers every way a socket drops.                                                                                 | A page that closed itself, or one the server ended for breaking the protocol, would still block the link.                                                        |
| Never hold, take over only an open socket                                                  | Nothing is kept after a close.                                                                                   | A socket that drops with a close the server sees (1006 after a reset, 1001 from a proxy) loses its attempt at once.                                              |
| Hold after any close except 1000, the server's own policy close and the heartbeat (chosen) | A page that leaves on purpose frees its link at once. A page the server ended gets no second chance.             | The page must close with 1000 when it leaves, or its link stays held for up to 30 s.                                                                             |
| A hold of 60 s                                                                             | Bridges longer outages.                                                                                          | Both pages show a stalled transfer for longer. A page that takes over after 0031's 30 s deadline finds its connection already closed.                            |
| A hold of 30 s (chosen)                                                                    | The same as 0031's deadline and the recipient's connect timeout. ICE consent runs out after 30 s too (RFC 7675). | An outage longer than that ends the attempt as before.                                                                                                           |
| Arm the attempt at `joined`                                                                | Covers drops during setup.                                                                                       | A recipient that starts a new attempt before its channel opened would meet `busy` from its own held socket. A setup that fails already ends as before (0031).    |
| Arm the attempt when the sender reports its path (chosen)                                  | The channel is open, so the attempt is worth keeping.                                                            | A socket that drops during setup ends the attempt as before.                                                                                                     |
| The server sends `joined` to both pages on every takeover                                  | The sender restarts ICE at once.                                                                                 | A `restart-offer` can reach a recipient whose connection reported no drop yet. It ignores it (0031), and the next drop makes no new offer while the first waits. |
| The server sends `joined` only when the recipient asked during the attempt (chosen)        | Each restart answers a recipient that is stalled.                                                                | The server keeps one flag per held attempt.                                                                                                                      |
| Keep an emailed link's binding through the sender's takeover (chosen)                      | The emailed recipient can still ask again with its email token after the sender's page comes back.               | More server logic for a mode that is off (0030). Unit tests only, no browser test and no new page text.                                                          |
| Drop the binding as today                                                                  | No change to 0012.                                                                                               | A sender whose socket drops loses every emailed link, as 0012's Consequences say, also when the page comes back within a second.                                 |

## Decision

A page whose signaling socket drops while a transfer is in progress connects again and takes its place in the same attempt with a resume token. Pages then recover the route by ICE restart, as in 0031. One `RTCPeerConnection` and one attempt ID per page hold through the takeover.

### Terms

- **Side:** the sender's side (the socket that hosts the link) or the recipient's side (the socket bound to it as a guest).
- **Armed attempt:** an attempt whose server holds resume tokens for it.
- **Resume token:** a value the server makes for one side of one armed attempt. It is not the email token of 0012.
- **Hold:** the time after a side's socket closed in which the server keeps that side's place in an armed attempt.
- **Takeover:** a new socket taking a side's place with that side's resume token.

### Arming

- The server arms an attempt when the sender reports a `path` other than `failed` for a link that has a bound recipient. The sender reports it once, when its data channel opens (0031).
- It makes two resume tokens, one for each side, and sends `resume {link, attempt, token}` to each side's socket with its own token.
- An attempt that is not armed behaves as before this record.
- Each token is 16 bytes from `randomBytes`, written as base64url, the shape of a link ID. It derives from nothing: not from the link secret, the signal key, the file key or the attempt ID. The server compares it with `timingSafeEqual`.
- A token lives only in the server's memory and in its own page's memory. It is never logged, stored by the page or put in a URL.

### The hold

- When a socket closes, each armed attempt it held is held on that side for 30 s (`TAKEOVER_MS`). That holds for any close except these, which free the attempt at once, as before this record:
  - a close with 1000;
  - a close the server made itself: its policy close (1008, for a bad message or the rate limit), the heartbeat's `terminate()`, and the end of a socket that stopped reading;
  - the server stopping (`SERVICE_RESTART`, 0025): its memory goes with it.
- So 1001 and 1006 are held. A proxy that closes the WebSockets it carries sends 1001 (Caddy does, 0025).
- A hold also ends at the first heartbeat at which the socket would have been ended had it stayed open, because it didn't answer the previous ping. So a held side is forgotten no later than a socket that went silent: within a minute of the page's last sign of life.
- A hold ends early when the attempt ends: the other side's socket closes with 1000, the sender refuses the attempt, or the sender stops hosting the link.
- While a side is held:
  - No `host-gone` and no `left` goes out for it.
  - A `host` from another socket for that link gets `already-hosted`.
  - A `join` from any other socket gets `refused` with `busy`.
  - When the sender's side is held, the recipient's repeated `join` (0031) gets `refused` with `busy`, which its page ignores once its channel is open. The recipient stays bound, and the server notes that it asked.
  - A `relay` to the held side is dropped and logged as `relay-dropped`.
- Each side has its own hold, so both can be held at once.
- When a hold ends without a takeover, the server does what it did before this record at that side's close, with the same messages and log lines: `host-gone` to the recipient and the email binding dropped for the sender's side, `left` to the sender for the recipient's side. Those lines appear up to 30 s later than before. A `resume` for that attempt is then refused.
- The server logs nothing when a hold starts. A host socket's close logs `host-closed` as before.

### Taking over

- A page that holds a token sends `resume {link, attempt, token}` on its new socket. The server takes it while the attempt's side is bound or held, when the token is that side's current one and the socket may take that side:
  - the recipient's side: a socket that is bound to no link;
  - the sender's side: a socket with no role yet, or one that already hosts other links.
- The server then moves that side's place to the new socket. On the sender's side that is the link, the sender's relay choice for the attempt (`turn`) and the email binding (0012). It makes a new token for that side, answers `resume {link, attempt, token}` with it, and logs `resumed {link}`.
- If the old socket is still open, the server treats it as closed first and then ends it with `terminate()`, as the heartbeat does. Its other links fare as at any close other than 1000: idle links are unhosted at once, and its other armed attempts are held.
- After a takeover of the sender's side, the server sends `joined` to both pages only if the recipient sent a repeated `join` during the attempt. The sender then restarts ICE, as in 0031. Otherwise it sends nothing more.
- After a takeover of the recipient's side, the server sends no `joined`. A recipient whose connection reported `disconnected` while it had no socket sends its repeated `join` (0031) once the takeover succeeded. The server answers it like any repeated `join`.
- Every `joined` counts toward the link's 10 pairings per 30-second window (`pairingsPerLink`), as in 0031.

### Refusals

The server answers `resume {link, attempt}` with no token, logs `resume-refused {link}`, and changes nothing when:

- the token is wrong, is the other side's, belongs to another link or attempt, or was already used (each takeover replaces it);
- the attempt was never armed, has ended, or its hold ran out;
- a socket bound as a recipient to another link claims a side;
- a socket that hosts links claims the recipient's side, or a socket bound as a recipient claims the sender's side.

A refused page goes on as before this record: the recipient's page closes its signaling client, and the sender's page treats the attempt's links as lost with the socket.

### The pages

- Both pages close their signaling client, with 1000, on `pagehide` unless the browser keeps the page to go back to (`event.persisted`). So a page that leaves frees its links at once.
- The recipient's page keeps its signaling client when its socket drops after its channel opened, if it holds a token. When the new socket opens it sends `resume` instead of asking again with `gate` or `join`. Without a token it closes its client as before.
- The sender's page sends `resume` for each armed attempt on its new socket, before `host`.
- A page sends `resume` only with a token it holds, at most once per token.
- When an open connection on the sender's page reports `disconnected`, the page sends its `host` again, unchanged. A sender whose address changed behind a NAT may have a socket that is dead but not yet closed. A message on it makes the close happen (see the outside behaviour below). An unchanged `host` logs nothing (`host()` in `apps/server/src/signaling.ts`).
- The sender's page keeps an emailed recipient bound through its socket's drop while its attempt is armed. It marks it unbound when its `resume` is refused, as at any lost socket today.
- No new page text.

### What the server logs and learns

- Two new log events, `resumed {link}` and `resume-refused {link}`, with the link's first 6 characters. No new field. The token, the attempt ID and the side are never logged.
- The server learns that a page's socket dropped during a transfer and came back, when, and that the new socket's address continues the old one. Addresses are still never logged.

### What this relies on outside our code

| Assumption                                                                                                                                               | Backing                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A browser that unloads a page closes its open WebSockets with 1001. A connection that ends without a close frame reads as 1006.                          | The WebSockets standard, "make disappear" ([websockets.spec.whatwg.org](https://websockets.spec.whatwg.org/)), and [RFC 6455, section 7.1.5](https://www.rfc-editor.org/rfc/rfc6455#section-7.1.5). The design doesn't depend on the first: the pages close with 1000 on `pagehide`.                                                                     |
| Chromium fails its open WebSockets soon after the operating system reports a network change (`ERR_NETWORK_CHANGED`).                                     | Not verified. If it doesn't, the recipient's repeated `join` from 0031 or the sender's re-sent `host` puts a message on the dead socket, which makes the close happen.                                                                                                                                                                                   |
| A segment of the old TCP connection that arrives from a new address matches no connection, and the server's host answers it with a reset.                | [RFC 9293, section 3.10.7.1](https://www.rfc-editor.org/rfc/rfc9293#section-3.10.7.1). The server's own socket for the old address stays open until a takeover or the heartbeat ends it. Behind the AWS load balancer (0023) this is unknown. The networks test (`pnpm e2e:networks`) checks a renumbered router behind the suite's nginx stand-in only. |
| Playwright's `routeWebSocket` with `connectToServer()` answers the server's pings, and a route whose `onClose` handler is set doesn't pass the close on. | [Playwright's `WebSocketRoute`](https://playwright.dev/docs/api/class-websocketroute) for the second. The `pnpm e2e` takeover tests check both: they pass only when the server ends the old socket by takeover, within a few seconds and well before the heartbeat.                                                                                      |
| An ICE restart across a changed public address keeps the DTLS association.                                                                               | [RFC 8445, section 9](https://www.rfc-editor.org/rfc/rfc8445#section-9) and [RFC 8842, section 6](https://www.rfc-editor.org/rfc/rfc8842#section-6), as in 0031. The networks test checks it in Chromium.                                                                                                                                                |
| Chromium reports `disconnected` 5 to 8 s after the route goes, and the page's new socket makes its first try within 1 s.                                 | 0031 measured 5.3 to 7.5 s. `retryDelay(0)` in `apps/web/src/lib/signaling-client.ts` waits a random time below 1 s after a socket that was open for 10 s or more. Later tries wait up to 2, 4, 8 and 16 s, so a page gets several tries within the 30 s hold.                                                                                           |
| A page from before this record ignores a server message type it doesn't know. A server from before it closes a socket that sends one with 1008.          | Our code: `parseServerMessage` and the signaling client's message listener drop it; `parseClientMessage` fails and the server closes with `POLICY_VIOLATION`. Not outside our code, but outside this release.                                                                                                                                            |

### Tests

- Unit tests in `apps/server/src/signaling.test.ts` cover arming, every hold rule, every refusal, the takeover of a socket that is still open with no heartbeat, the emailed link, the pairings cap, and that a hold never keeps a side longer than a minute after its page's last sign of life.
- Two tests in `pnpm e2e`: one cuts the recipient's socket mid-transfer and one the sender's, each with a dropped route. Each passes when the file arrives with a matching SHA-256 and no "Try again", on one `RTCPeerConnection` and one attempt ID per page, with a new ICE password, one `resume` sent, the old socket closed by the server, and no `host-gone`. A token may appear only in `resume` frames.
- One test in `pnpm e2e:networks` changes the recipient's router's public address mid-transfer, as a real change of network does.

### Replacements to 0006, 0012 and 0031

0006, 0012 and 0031 are not superseded. Read them with these replacements.

| Where it says                                                                                                                                                                                  | Read                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0006, Per-attempt ID: "It travels in `join`, `joined` and `refuse`."                                                                                                                           | It travels in `join`, `joined`, `refuse` and `resume` (0032).                                                                                                                                                                                                   |
| 0012: "Unhosting a link, by a `host` that leaves it out or by closing the socket, drops its email binding and everything else the server holds about the link"                                 | The same, except that when the socket closes while the link's attempt is armed, the sender's side is held for up to 30 s (0032). A takeover in that time moves the binding to the new socket. When the hold ends without one, the binding is dropped as before. |
| 0012, Consequences: "When the sender's signaling socket closes, every emailed link it hosts ends."                                                                                             | The same, except a link whose attempt is armed. Its binding survives a takeover by the sender's new socket within the hold (0032), and the recipient's repeated `join` with its email token is taken after it.                                                  |
| 0012, Consequences: "The server cannot tell the sender's new socket from anyone else who hosts the link ID, so it cannot hand the value back after a reconnect."                               | For an armed attempt within its hold, it can: the new socket shows the sender's resume token (0032). For any other link the sentence holds.                                                                                                                     |
| 0012, Consequences: "Once the sender stops hosting the link (the tab closes, the socket closes or the recipient is removed), they can also host the same link ID"                              | The same, but while the sender's side of an armed attempt is held, nobody else can host the link (0032).                                                                                                                                                        |
| 0031, Scope: "Recovery needs both signaling sockets. A recipient whose socket is gone can't ask, and a sender whose socket dropped has lost its binding on the server."                        | Recovery needs both signaling sockets. Once the attempt is armed, a page whose socket dropped takes its place back on a new socket within the hold (0032), and then recovery goes on as in 0031.                                                                |
| 0031, Scope: "A recipient that got `host-gone` in this attempt doesn't ask. The sender's socket dropped then, and joining its new socket would be the re-pairing that this record leaves out." | The same. Since 0032 the server sends no `host-gone` for an armed attempt while the sender's side is held. It comes only when the hold ends without a takeover, or for an attempt that was not armed.                                                           |
| 0031, Scope: "Pairing again after a lost signaling socket, which a real change of IP address needs, is a follow-up issue, FID-349."                                                            | 0032 records it, for an attempt whose channel opened.                                                                                                                                                                                                           |
| 0031, Consequences: "A change of IP address that drops a page's WebSocket is not recovered."                                                                                                   | A change of IP address that drops a page's WebSocket is recovered when the attempt is armed and the page's new socket takes over within the hold (0032). A drop during setup, or one that outlasts the hold, is not.                                            |
| 0031, Consequences: "Before this record, the server saw nothing of a pairing after the sender's `path` report, apart from the sockets closing and the sender's `refuse`."                      | Since 0032 the server also sees a takeover: a `resumed` or `resume-refused` line, and the `resume` messages that carry the tokens. It learns that a page's socket came back, when, and that its new address continues the old one.                              |

## Consequences

- A transfer survives a page's change of network when its channel had opened and its page connects again within 30 s. The two people do nothing, and on a link with the safety number they compare no new number.
- A takeover moves the attempt, not the sender's other links. The sender's page hosts those again with `host`, as after any lost socket.
- A page that leaves on purpose frees its links at once, as before, because it closes with 1000. A page that crashes, or whose proxy closes the socket, holds its armed attempts for up to 30 s. In that time the recipient's "Try again" on a new socket gets `busy`, and a new recipient on the link gets `busy` too.
- The server keeps a little more, for a little longer: two tokens and one flag per armed attempt, and a held side for up to 30 s after its close. Every held side is forgotten within a minute of its page's last sign of life, so "forgotten within a minute" stays true.
- What a token is worth: its holder can take one side of one attempt and end the socket that had it. It can't open sealed signals or read the file, because it holds no key. So the worst a leaked token does is cut a page off and end that transfer, which our server can already do. Each page holds only its own token, so the sender can't take the recipient's side, or the other way round.
- What the server learns is new (see "What the server logs and learns"). `docs/how-fidant-works.md` and the `/how/traces` text describe it in this pull request.
- A server restart drops every token, as it drops every binding today. The pages' `resume` is then refused, and they go on as before this record.
- Takeover needs the new socket to reach the same server process. Signaling runs one task (0023), so that holds. More than one would need sticky sessions or shared state.
- An emailed recipient's sender keeps its binding through a takeover. Email is off on every deployment (0030), so only unit tests cover this. The emailed link's secret and typed name are unaffected: they leave server memory when the send attempt ends, long before a recipient can have joined.
- Version skew:
  - A page from before this record gets `resume` from a new server and ignores it. Its transfers end as before.
  - A page on a server from before this record gets no token and never sends `resume`. Its transfers end as before.
  - A page that got a token from a new server, and then meets an older server after a rollback, sends `resume`. The older server closes that socket with 1008. The page sends that token only once, so its next socket goes on as before this record.
- Not covered: a socket that drops during setup, before the sender reports its path; an outage longer than the hold; the sender's idle links behind a silent socket, which still wait for the heartbeat; Firefox and WebKit, which run the `pnpm e2e` takeover tests only in the nightly runs and the networks test not at all.
