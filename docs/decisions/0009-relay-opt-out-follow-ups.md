# 0009: Relay opt-out follow-ups

- Status: Accepted
- Date: 2026-11-24
- Linear: SIG-101

## Context

- 0008 let the sender refuse our relay. It stays in force. Review of its implementation found things that 0008 got wrong or left open. They are listed below.
- /privacy says the relay choice is never written to our logs. It also lists "how many links a sender has" as a logged field.
- 0008 is Accepted and merged, so it is not rewritten. This record adds to it and does not supersede it.

## Options considered

| Option                                              | For                                                                      | Against                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Edit 0008 in place                                  | One record to read.                                                      | The README forbids rewriting an Accepted, merged record.                                       |
| Supersede 0008 with a full new record               | One current record.                                                      | 0008's decision still holds. Superseding it would say otherwise.                               |
| This additive record                                | 0008 stays as merged. The corrections sit next to the decision they fix. | A reader needs both records.                                                                   |
| Log every `host`                                    | Simple.                                                                  | A `host` line with an unchanged link count reveals that the sender toggled the relay checkbox. |
| Log `host` only when the sender's link list changes | A toggle leaves no line. The link count stays logged.                    | The server must compare the old and new link list.                                             |
| Drop the `host` log line                            | Nothing to leak.                                                         | /privacy lists "how many links a sender has" as a logged field, so it would have to change.    |

## Decision

- The server logs `host` only when a sender's link list changes: the first host, a link added or removed, or a link swapped. Toggling the relay checkbox leaves no log line.
- The sender's backstop ends an attempt and reports `failed` only while that attempt is still in progress (`refusesRelay` in `apps/web/src/lib/sender-state.ts`). A relay path that resolves after the file was delivered is reported and shown as `relay`, so the page, the card and the server agree.

## Consequences

- Correction to 0008: it said the backstop "in practice it fires before any file data". That is too strong. The backstop catches only a recipient that reveals its relay candidate. It runs only after the data channel opens, and a first `stun` reading waits a second (`PATH_RECHECK_MS`) before it reads again. A recipient that accepts at once may already have received encrypted file chunks through the relay.
- Refused sends get only the `stun:` URLs in `TURN_URLS`. With no `stun:` URL configured they get no STUN at all, and browsers behind NAT can then connect only on the same network. 0007 plans to give the `stun:turn.fidant.se` slot to a `turns:` URL. That change must keep a `stun:` URL, by raising `MAX_ICE_URLS` or giving up another slot.
- The recipient's refused-relay message says the networks "probably" couldn't connect directly. It asks them to ask the sender to allow the relay or to try another network. 0008 accepts that other failures before the channel opens are shown as a refused relay, so the message can't be certain.
- The count and size of `relay` signaling log lines for one link prefix can still hint at whether TURN was offered, because each trickled relay candidate is one more sealed message and messages are not padded. No line writes the choice. Accepted.
