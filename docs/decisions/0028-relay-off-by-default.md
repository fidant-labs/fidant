# 0028: The relay off by default, allowed per link when asked

- Status: Proposed
- Date: 2026-11-26
- Linear: SIG-338

This record amends 0008, 0009, 0015, 0017 (`0017-check-number.md`), 0019 and 0024. Read them with the replacements under Decision. The replacements hold once this record's status reads Accepted. Until then, Context describes the code on `main`, and Decision describes what SIG-338 builds.

## Context

- The send page has a checkbox, "Use our relay if needed" (0008, 0024). It is on by default and applies to the whole send. `host` carries it as `turn`, and the server keeps the latest value per sender, in memory only.
- With the box ticked and a relay up, `joined` carries TURN credentials. The browsers try the direct routes first and add the relay when nothing has connected 3 s after the sender applies the recipient's answer (`RELAY_FALLBACK_MS`, 0019). Nobody is asked at that moment.
- Once the relay is added, each browser reserves relay addresses, and the relay sees both IP addresses, even if a direct route then wins (0019). When it carries the file, it also sees roughly the file's size.
- Relayed traffic costs money. The relay boxes share a pooled allowance, and a cap closes the relay ports when the month's estimated overage reaches 20 USD (0021). STUN closes with them, so new transfers then connect only where they can without STUN, until the ports open again. Every relayed transfer brings that day closer for all senders.
- So today a sender who never looked at "Connection options" lets our relay see both addresses and spends the relay budget, without having chosen to.
- With the box unticked, the server mints no credential (0008). An attempt that can't connect directly runs until the sender's page ends it 20 s after the join (`SETUP_TIMEOUT_MS`). The sender's card then says that allowing the relay may help when the recipient tries again. The recipient is told the sender doesn't allow the relay and must press "Try again" after the sender ticks the box.
- 0008 weighed a flag per link and turned it down: "More protocol for no use today."
- `joined`'s parser accepts only its exact keys, so a page loaded before a new key was added would ignore every `joined`. A page drops a signaling message it can't parse, with a console warning (`apps/web/src/lib/signaling-client.ts`).
- The server mints TURN credentials per pairing, and they travel only in `joined` (0006, 0015).
- On 2026-11-26, SIG-338 decided to turn the relay off by default, for privacy and for cost, and to ask the sender when a transfer can't connect without it.

## Options considered

### The default

| Option                                                              | For                                                                                                 | Against                                                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| On, as today                                                        | A transfer that needs the relay gets it about 3 s in, with nobody asked.                            | The relay sees both addresses and spends the budget on sends whose sender never chose it.                    |
| Off, and nothing else changes                                       | No new protocol.                                                                                    | The sender learns of the problem after 20 s, must find the checkbox, and the recipient must press Try again. |
| Off, and the sender is asked when a transfer can't connect (chosen) | The relay is used only where a person allowed it, for that link. The sender is told within seconds. | New protocol, a new wait on the receive page, and the sender must be at the page to answer.                  |

### What the sender allows

| Option                                       | For                                                                              | Against                                                                          |
| -------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| The whole send, by ticking the checkbox      | The `turn` flag of 0008. No new field.                                           | An answer about one recipient would also let every other link use the relay.     |
| One link (chosen)                            | The sender allows what they were asked about. The other links stay as they were. | The server keeps one more fact per sender: which of its links may use the relay. |
| The checkbox removed, only the ask stays     | One way to allow the relay.                                                      | A sender who knows their network needs the relay would wait and click per link.  |
| The checkbox kept, default unticked (chosen) | Ticked, a send behaves exactly as today (0008, 0019), with no wait for an ask.   | Two ways to allow the relay.                                                     |

### How the grant reaches the server

| Option                                          | For                                                                                                 | Against                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A new message per grant                         | Small.                                                                                              | A reconnected socket would have to send every grant again. |
| An optional `turnLinks` list on `host` (chosen) | The page already re-sends `host` on every reconnect and every change, so the grants travel with it. | The server must check the list against the links it hosts. |

### How the pages learn that asking is worth it

| Option                                            | For                                                             | Against                                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Always ask after a stall                          | No server change.                                               | With no relay up, the sender would allow a relay that can't help.                        |
| A new key on `joined`                             | No new message.                                                 | Every page loaded before the change would ignore every `joined`.                         |
| A new message, `turn-up`, after `joined` (chosen) | A page loaded before the change drops it and behaves as before. | One more message type.                                                                   |
| The pages read `/relay-status`                    | No signaling change.                                            | Another request per attempt, and without a relay list it says nothing about `TURN_URLS`. |

### The direct attempt when the ask shows

| Option                                                    | For                                                                                 | Against                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| It keeps trying until the 20 s timeout                    | A direct route that needs more than 3 s can still connect.                          | The ask would change under the sender after 20 s, or the timeout would have to wait for a click. |
| It ends when the ask shows, 3 s after the answer (chosen) | The ask has no deadline. The link is back to waiting, a state the page already has. | A direct route that needs more than 3 s fails until the sender allows the relay.                 |

### How the transfer goes on after the sender allows

| Option                                                                                                                    | For                                                                            | Against                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| The recipient presses Try again, as under 0008                                                                            | No new restart rule.                                                           | The recipient must be told to click at the right moment, by a page that can't know when the sender answered.         |
| The kept attempt gets TURN credentials in a new message                                                                   | No new attempt.                                                                | Credentials would travel outside `joined` (0006, 0015), and the sender's attempt has already ended.                  |
| The sender refuses the waiting attempt with a new reason, `turn`, and the recipient's page joins again by itself (chosen) | The new attempt is an ordinary join, and its `joined` carries the credentials. | The recipient's page makes a new connection without a click, also on a link with a safety number (see Consequences). |

### Telling the sender

| Option                                                                        | For                                                       | Against                                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| The card only                                                                 | Nothing new.                                              | The recipient waits with no deadline, and the sender is often in another tab. |
| A sound and a notification, repeated until answered                           | Hard to miss.                                             | Noise without end for a sender who has left.                                  |
| A sound at once, stronger alerts after 1 and 5 minutes, then nothing (chosen) | Three chances to notice, each harder to miss, then quiet. | A sender away for longer than 5 minutes sees only the card.                   |

### What the server logs

| Option                                                       | For                                           | Against                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| A log line or field for the grant                            | Counts of how often the relay is allowed.     | The relay choice is never written to our logs (0008, 0009, /privacy).                       |
| Nothing new, and `refused` with `turn` isn't logged (chosen) | /privacy's log list stays as it is.           | The count and order of the existing lines can still hint (see Consequences).                |
| A new path value for a stalled, asked attempt                | Path counts would tell an ask from a failure. | A new log value. 0008 chose `failed` for a connection that can't be made without the relay. |

## Decision

The relay is off unless the sender allows it. The checkbox stays, unticked by default. When a transfer can't connect directly and a relay is up, the sender's page asks the sender to allow the relay for that one link. This record calls that question the ask, and a yes the grant.

### The checkbox

- "Use our relay if needed" is unticked by default. It still applies to that send only and isn't remembered.
- Ticked, the send behaves exactly as before this record: `host` carries `turn: true`, and the relay is added as in 0019. No ask shows.

### The grant on `host`

- `host` gains an optional field, `turnLinks`: a list of link IDs with no duplicates, each also in `links`. The page leaves it out when it is empty.
- The server keeps the list per sender, next to `turn`, cut down to the links it accepted. It is in memory only, replaced by every `host` and gone with the socket. It is never logged.
- A `host` that changes only `turnLinks` leaves no log line, as with `turn` (0009).
- For a join, the sender allows the relay when `turn` is true or the link is in `turnLinks`. `joined` carries the result as `turn`, with credentials as before (0008, 0015).
- The sender's page still enforces its own choice (0008): it treats an attempt as allowed only when `joined` says `turn` and its own checkbox is ticked or it holds a grant for that link.

### `turn-up`

- After the server has sent both `joined` messages for an attempt whose `turn` is false, it sends `{t: "turn-up", link, attempt}` to both pages when a relay is up.
- With a relay list, a relay is up as in 0015. Without one, a relay counts as up when the server has a TURN secret and a `turn:` or `turns:` URL. Nothing checks that coturn then, as 0007 says of the URLs.
- The server mints no credential to find this out.
- `turn-up` is never logged. `joined` keeps its shape.

### The stall

- A peer that got no `turn:` or `turns:` URL tells its page when the attempt stalls: 3 s (`RELAY_FALLBACK_MS`) after the sender applies the answer, or after the recipient sends it, if ICE isn't connected and the data channel isn't open. That is the test 0019 uses for adding the relay, on a peer that has no relay to add. It fires at most once per attempt. The peer doesn't close itself.
- The sender's page, on a stall under `turn: false`:
  - With `turn-up` for that attempt: it ends the attempt, puts the link back to waiting and shows the ask. It closes its peer and sends no `refuse`, so the recipient stays bound to the link on the server. It reports `path: failed`, as 0008 says of a connection that can't be made without the relay.
  - Without `turn-up`: nothing changes on screen. The attempt runs on to the 20 s timeout and then shows 0008's message.
- The recipient's page, on a stall with `turn-up` and no open channel: it stops its 30 s connect timeout, keeps its peer and its socket, and shows "Couldn't connect directly. Waiting for the sender to allow our relay." There is no "Try again" and no deadline on that view.
- The wait ends when the sender allows the relay, when the sender is gone or removes the recipient (`host-gone`: removing re-sends `host` without the link), or when the recipient's socket drops. The last three end it as they end an attempt today.

### The ask

- The card's status line says the link was opened but couldn't connect directly, and a button reads "Allow our relay for <name>". Keyboard focus doesn't move, and the button is outside the live region.
- Pressing it sets the grant for that link, re-sends `host` with the link in `turnLinks`, and then sends `refuse` for the waiting attempt with the new reason `turn`. The order matters: the server must hold the grant before the recipient joins again.
- The server forwards it as `refused` with `turn` and unbinds the recipient, as for any `refuse`. It doesn't log this one.
- The recipient's page, on `refused` with `turn` before its channel has opened, starts a new attempt by itself, at most `MAX_REJOINS` (4) times in a row. Past that it shows the failure view with "Try again". With an open channel it ignores the message.
- The new attempt is an ordinary join. Its `joined` carries credentials, and the relay is added as in 0019: only if nothing has connected 3 s after the answer, and ICE can still pick a direct route.
- The grant lasts until the link is delivered or removed, or the page closes. There is no control to take it back. When a link with a grant is delivered, the page re-sends `host` without it in `turnLinks`.
- If the recipient leaves while the ask shows, or the sender's socket drops, the ask goes away. No grant is set.
- There is no "Not now" button. A sender who doesn't want the relay leaves the ask alone.
- Ticking the checkbox while asks show answers every one of them as the button does: each asking link gets the grant, and each waiting recipient's page joins again. No waiting recipient is left on a view with no "Try again". The grants stay if the checkbox is then unticked.

### Alerts

- When an ask shows, the page beeps once. One minute later, if the ask is still open, it beeps twice, louder. Five minutes after the ask, it beeps three times, louder. Then it stops.
- The sound is made in the page (`AudioContext`), with no audio file. It needs no opt-in. The page prepares it on the "Create link" click.
- Each of the three alerts also shows a notification, in place of the one before it, and only the third stays until dismissed (`requireInteraction`). A notification shows only when the sender already allowed notifications through "Notify me" and the page isn't focused. The ask adds no permission prompt. Its text is fixed and names no recipient, file or link, as for the delivery notification.
- Allowing, removing the recipient, or the recipient leaving stops the alerts.
- Assumptions about browsers, to be tested by the e2e tests in SIG-338 and not yet verified: a sound started by a timer plays after one earlier click on the page; `requireInteraction` keeps a notification up where the browser supports it and is ignored elsewhere. Where either fails, the sender still has the card.

### Logs and paths

- There is no new log event or field. `LogEvent` and /privacy's log list stay as they are.
- The type of a logged reason leaves out `turn`, so logging it fails the typecheck.
- A stalled attempt that was asked reports `failed`. The new attempt after a grant reports its own path.

### Replacements to 0008, 0009, 0015, 0017, 0019 and 0024

None of them is superseded. Read them with these replacements.

| Where it says                                                                                                                                                                                              | Read                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0008: "It is on by default, applies to that send only and isn't remembered."                                                                                                                               | It is off by default, applies to that send only and isn't remembered.                                                                                                                                                                                                        |
| 0008: "`host` carries `turn: boolean` for the whole send, and the sender re-sends `host` whenever the checkbox changes. The server keeps the latest value per sender, in memory only, and never logs it."  | The same, and `host` also carries `turnLinks`, the links the sender allowed the relay for, re-sent whenever a grant is added. The server keeps both, in memory only, and logs neither.                                                                                       |
| 0008: "`join` reads the sender's current value. `joined` carries it as `turn` to both browsers"                                                                                                            | `join` reads the sender's current `turn` and whether the link is in `turnLinks`. `joined` carries `turn: true` when either holds.                                                                                                                                            |
| 0008: "The sender's card says that allowing the relay may let the recipient connect when they try again."                                                                                                  | When a relay is up, the card asks the sender to allow the relay for that link, 3 s after the answer (see "The ask"). The message 0008 describes shows only when no relay is up and the attempt stalled.                                                                      |
| 0008: "Our server never hands out relay access for a refused send"                                                                                                                                         | Our server never hands out relay access for a link unless the sender ticked the checkbox or allowed the relay for that link.                                                                                                                                                 |
| 0008: "Ticking it helps a refused recipient only once they press "Try again"."                                                                                                                             | Still true of the checkbox. The button "Allow our relay for <name>" makes the waiting recipient's page join again by itself.                                                                                                                                                 |
| 0008: "A refused connection can take up to `SETUP_TIMEOUT_MS` (20 s) to show its message."                                                                                                                 | With a relay up, the ask shows 3 s after the answer. With none up, still up to 20 s.                                                                                                                                                                                         |
| 0008: "Under `turn: false`, any attempt that ends before its channel opens is shown as a refused relay, even when the cause was something else"                                                            | Under `turn: false`, an attempt is shown as a refused relay only when it stalled: nothing had connected 3 s after the answer. One that ends sooner, for example because the recipient closed the tab, is shown as a failed connection. A stall can still have another cause. |
| 0009: "Toggling the relay checkbox leaves no log line."                                                                                                                                                    | Neither toggling the checkbox nor a grant leaves a log line.                                                                                                                                                                                                                 |
| 0009: "The recipient's refused-relay message says the networks "probably" couldn't connect directly."                                                                                                      | The recipient sees that message only after a stall on an attempt with no relay up. With a relay up, it sees the waiting view instead.                                                                                                                                        |
| 0015, Choosing a relay: "when the sender allows the relay, its URLs with fresh credentials"                                                                                                                | The sender allows the relay for a join when the checkbox is ticked or the link is in `turnLinks`.                                                                                                                                                                            |
| 0015, Choosing a relay: "The signaling protocol doesn't change."                                                                                                                                           | True of 0015. This record adds `turnLinks`, `turn-up` and the refuse reason `turn`, and the server's up and down state now also decides whether `turn-up` is sent.                                                                                                           |
| 0017, The attempt cap: "a refused relay"                                                                                                                                                                   | A refused relay, which includes a stalled attempt that the sender was asked about.                                                                                                                                                                                           |
| 0017, The recipient's reconnects: "Once the recipient's page has sent its answer, it never makes a new connection by itself"                                                                               | One exception: on `refused` with `turn` before its channel has opened, it joins again by itself, at most 4 times in a row.                                                                                                                                                   |
| 0017, How many guesses: "On the recipient's side, every connection after the first in an attempt needs the recipient to see a failed connection and click "Try again"."                                    | The same, except for up to 4 connections in a row that follow `refused` with `turn`. Each is one more blind guess, one in a million. The sender's limit of 5 unconfirmed attempts per link is unchanged, and a stalled attempt counts toward it.                             |
| 0019: "The relay is added only when `joined` listed `turn:` or `turns:` URLs: the sender allows the relay and a relay is up."                                                                              | The same, where "the sender allows the relay" means the checkbox is ticked or the sender allowed the relay for that link.                                                                                                                                                    |
| 0019: "Refusing the relay (`turn: false`, 0008) is unchanged: `joined` then has only `stun:` URLs, so the relay is never added."                                                                           | The same, and 3 s after the answer each peer tells its page that the attempt stalled (see "The stall").                                                                                                                                                                      |
| 0019: "A direct route that hasn't connected 3 s after the sender applies the recipient's answer, for example on a network that loses many packets, gets the relay added and may then end up on the relay." | True where the sender allowed the relay before the join. Otherwise, with a relay up, that attempt ends and the sender is asked. With none up, it runs on to 20 s.                                                                                                            |
| 0019, on 0009's hint: "The relay is added only when TURN was offered, so those lines hint that TURN was offered and that nothing had connected 3 s after the sender applied the recipient's answer."       | The same, and for one link prefix, `joined`, `path` with `failed`, a second `joined` and then about a dozen more `relay` lines hint that the sender allowed the relay after an ask.                                                                                          |
| 0024: "unticked, our server mints no relay credentials for that send, so neither browser gets any."                                                                                                        | Unticked, our server mints relay credentials only for a link the sender allowed the relay for.                                                                                                                                                                               |

## Consequences

- By default no browser reserves a relay address and no file passes through our relay. The relay sees both addresses of a pairing through an allocation only after the sender ticked the checkbox or allowed the relay for that link.
- The relay box still sees each browser's IP address from its STUN request, as before (0019). That doesn't change with the default.
- Fewer transfers use the relay, so less of 0021's budget is spent, and the cap that closes STUN for everyone is further away.
- A transfer that needs the relay now also needs the sender at the page. The recipient waits, with no deadline, until the sender answers, leaves or removes them.
- A direct route that needs more than 3 s after the answer fails under the default, until the sender allows the relay. After that, ICE can still pick the direct route. Before this record, such an attempt had until 20 s when the relay was refused.
- The server keeps one new fact: which of a sender's links may use the relay. It is in memory, per socket, never logged. `docs/how-fidant-works.md`, /privacy, /security, /how, the landing page and the send page's "Holds" row must name it in the pull request that builds it.
- The new signaling data is link IDs, attempt IDs and one refuse reason. Nothing about a file, a name or a key reaches the server.
- The `failed` path count rises: every ask adds one `failed`, also when the transfer then succeeds through the relay or directly. Path counts from before and after this record can't be compared.
- The log can still hint at a grant, by the order and count of lines the server already writes (see the replacement to 0019). No line writes the choice. Accepted, as in 0009.
- On a link with a safety number, a stalled attempt counts toward the sender's 5. A link on a network that needs the relay spends one of its 5 before the transfer starts.
- The recipient's restart weakens 0017's rule by a bounded amount. Our server forwards `refused`, so on an emailed link it can forge `refused` with `turn` and make the recipient's page connect again without a click, at most 4 times in a row. That is at most 4 more blind guesses, each one in a million. Past that the page shows a failure and needs a click, as in 0017.
- No relay up means no `turn-up`, so no ask: the attempt runs to 20 s and both pages show 0008's messages. That covers the local demo, which has no TURN server, a relay that is down, and a relay closed by the cap.
- A relay that goes down between the ask and the grant isn't noticed. The new attempt gets no credentials, runs to 20 s and ends with the plain "couldn't connect" message. Accepted.
- Without a relay list, `turn-up` says only that the server has TURN settings, not that coturn answers. An ask can then lead to an attempt that fails after 20 s.
- The ask depends on both pages measuring 3 s from nearly the same moment. If only the sender's page sees the stall, it asks while the recipient's page still runs its 30 s timeout. The grant then restarts the recipient if it comes within that time. After it, the recipient has seen a failed connection and presses "Try again".
- Pages loaded before this change:
  - A sender page still sends `turn: true` by default and never sends `turnLinks`, so its sends behave as before until it is reloaded.
  - A recipient page drops `turn-up` and `refused` with `turn`. With a new sender page, it gets no waiting view: it fails after its 30 s timeout and closes its socket, which takes the ask away on the sender's page. Reloading the receive page fixes it.
  - A server from before this change refuses a `host` with `turnLinks`. It also never sends `turn-up`, so a page talking to it never shows an ask and never sends the field.
- Chrome on Android can't show the notification from a page (`notifyPermission` reports "unsupported" there), so it gets the sounds and the card only.
- Tests: unit tests for the parsers, the server's grant and `turn-up`, the peer's stall, the sender's reducer and the alerts. End-to-end tests in Chromium for the ask, the wait, the restart and the alerts, on Playwright's clock, so `pnpm e2e` gets no slower. Two rows in the networks suite with real timers.
- 0008, 0009, 0015, 0017, 0019 and 0024 stay Accepted.
