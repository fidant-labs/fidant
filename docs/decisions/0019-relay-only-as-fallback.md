# 0019: The relay only as a fallback

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-191

This record amends 0007, 0009 and 0015. Read them with the replacements under Decision.

## Context

- The send page offers "Allow our relay if a direct connection isn't possible" (0008), and `docs/how-fidant-works.md` said the relay route is taken "when no direct route works".
- When the sender allows the relay and a relay is up, `joined` carries its `stun:`, `turn:` and `turns:` URLs, with TURN credentials (0006, 0008, 0015). Until SIG-191 both browsers started their peer connection with all of them.
- So on every pairing that allowed the relay while a relay was up, each browser reserved a relay address, even when a direct route won (0007). The relay saw both IP addresses on every such pairing.
- ICE takes the first pair that works. In CI's networks suite, the "home routers (cone)" row ended on the relay although hole punching would have worked (runs 45648055551 and 45657096618). The TURN pair became writable before hole punching finished, Chrome selected it, and the sender's page itself reported the path `relay`. The promise of the checkbox didn't hold.
- A peer refuses a second `offer` or `answer` in an attempt (`apps/web/src/lib/peer.ts`).
- The sender ends an attempt whose data channel hasn't opened 20 s after the join (`SETUP_TIMEOUT_MS`).
- On 2026-11-25, SIG-191 decided to make the relay a true fallback.

## Options considered

| Option                                                                                                   | For                                                                                                      | Against                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TURN from the start, as before                                                                           | A transfer that needs the relay starts at once.                                                          | The relay pair can win while a direct route is still being found. Every pairing that allows the relay reserves relay addresses, so the relay sees both IP addresses even when a direct route wins.                                                   |
| Keep each browser's own relay candidates from the other side                                             | No ICE restart.                                                                                          | Each browser still reserves relay addresses and pairs its own relay candidates with the other side's candidates. A check that arrives through a relay shows on the other side as a peer-reflexive candidate (0008), so the relay pair can still win. |
| Start without TURN and add it once ICE reports `failed`                                                  | No fixed wait.                                                                                           | When ICE counts as failed is up to the browser, and the sender ends the attempt 20 s after the join whatever ICE does.                                                                                                                               |
| Start without TURN and add it by an ICE restart when nothing has connected 3 s after the answer (chosen) | A direct route that connects within 3 s can't lose to the relay. Such pairings reserve no relay address. | A transfer that needs the relay starts about 3 s later. A direct route that is slower than 3 s may end up on the relay.                                                                                                                              |
| A shorter wait                                                                                           | Relayed transfers start sooner.                                                                          | More direct routes that are only slow get the relay added.                                                                                                                                                                                           |
| A longer wait                                                                                            | Fewer slow direct routes get the relay added.                                                            | Every relayed transfer starts later, and less of the sender's 20 s is left for the relay.                                                                                                                                                            |
| A second `offer` and `answer` for the restart                                                            | No new signal kinds.                                                                                     | The peers would have to accept a second offer or answer, so the server could replay a first one into the attempt.                                                                                                                                    |
| New sealed kinds, `restart-offer` and `restart-answer` (chosen)                                          | A first offer or answer that comes again is still refused.                                               | A recipient page from before this change refuses `restart-offer`.                                                                                                                                                                                    |

## Decision

The browsers first try the direct routes without the relay. They add the relay only when nothing has connected 3 s after the answer. In this record and in `docs/how-fidant-works.md`, that step is the relay restart.

### Direct routes first

- Both browsers start their peer connection with only the `stun:` URLs from `joined`. No browser reserves a relay address, and no traffic goes through the relay, while the direct routes are tried.
- STUN requests still go to the relay box (`stun:sto.relay.fidant.se:3478` today), so the relay box still sees each browser's IP address when that browser asks for its public address.
- `joined` doesn't change (0015, "Choosing a relay"). The browsers keep the full list, with the TURN credentials, for the relay restart.

### The relay restart

- It runs only when `joined` listed `turn:` or `turns:` URLs: the sender allows the relay and a relay is up.
- When the sender has applied the recipient's answer, it waits 3 s (`RELAY_FALLBACK_MS` in `apps/web/src/lib/peer.ts`). If ICE is still not connected then, it adds the full ICE server list (`setConfiguration`), restarts ICE (`restartIce()`) and sends a new offer as a sealed signal of the new kind `restart-offer`.
- ICE counts as connected when `iceConnectionState` is `connected` or `completed`; DTLS doesn't count, so a connection that is `disconnected` at 3 s also gets the relay restart.
- The recipient adds its own full list and answers with `restart-answer`.
- ICE then tries every route again, the relay included, and can still pick a direct one.
- Each is accepted once per attempt: `restart-offer` only after the recipient answered the first `offer`, and `restart-answer` only after `restart-offer`. A second `offer` or `answer` is still refused, so the server can't replay a first offer or answer as a restart one.
- Both must name the same two DTLS certificates as the first `offer` and `answer`, which the check number comes from (0017). A page refuses the other side's restart SDP with another fingerprint as a bad signal, and closes with `setup-failed` if its own would name another, so a relay restart can't put anyone between the browsers after the number was fixed.
- Both kinds are sealed like every other signal, with the direction and the attempt bound in. The server sees only another opaque `relay` message.
- A candidate whose `usernameFragment` is set and differs from the current remote description's is dropped silently, which drops candidates from before the restart that arrive after it.
- If sending `restart-offer` or `restart-answer` fails, the peer closes with `signal-failed`. If `setLocalDescription` fails for either, it closes with `setup-failed`.
- If the sender's `setConfiguration` or `restartIce` throws, it doesn't restart, and the connection goes on without the relay. If the recipient's `setConfiguration` throws, it still answers `restart-offer`, and the connection can still go through the sender's relay address.

### What stays

- Refusing the relay (`turn: false`, 0008) is unchanged: `joined` then has only `stun:` URLs, so the relay restart never runs.
- The server is unchanged. The sender reads and reports the path as before.

### Replacements to 0007, 0009 and 0015

This record amends 0007, 0009 and 0015. They are not superseded. Read them with these replacements.

| Where it says                                                                                                                                                                                                           | Read                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0007: "A TURN server also tells the browser its public address, so STUN by name adds nothing then."                                                                                                                     | The browsers use the `turn:` and `turns:` URLs only on a relay restart. Until then a `stun:` URL is their only way to learn their public address, so the list needs one.                                                                                                                                                                                                                                                                                  |
| 0007: "Each browser allocates once per `turn:` URL on each network interface, even when the direct path wins, so a pairing takes up to about 8. 200 is about 25 pairings at once."                                      | Each browser allocates only on a relay restart: then once per `turn:` URL on each network interface, even if a direct route wins after all, so such a pairing takes up to about 8. 200 is about 25 restarted pairings at once. A pairing that connects within 3 s of the answer allocates nothing.                                                                                                                                                        |
| 0007, Emergency stop: "Browsers try the relay, fail to reach it, and connect directly."                                                                                                                                 | Browsers try the direct routes first and add the relay only when nothing has connected 3 s after the answer. It doesn't answer, so they connect only where a direct route works.                                                                                                                                                                                                                                                                          |
| 0009: "The count and size of `relay` signaling log lines for one link prefix can still hint at whether TURN was offered, because each trickled relay candidate is one more sealed message and messages are not padded." | An attempt that connects within 3 s of the answer trickles no relay candidate, so its `relay` lines say nothing about the choice. A relay restart adds about a dozen `relay` lines for the link prefix: `restart-offer`, `restart-answer` and a new round of candidates, relay candidates among them. It runs only when TURN was offered, so those lines hint that TURN was offered and that nothing connected within 3 s. Messages are still not padded. |
| 0015, Runbook, "Turn the relay list off at once": "In Chrome, `chrome://webrtc-internals` on a page that has paired lists the ICE server URLs: they name `turn.fidant.se` and not `sto.relay.fidant.se`."               | The connection starts with only the `stun:` URLs, so a page whose connection didn't restart lists only those. `stun:turn.fidant.se:3478` names `turn.fidant.se`, and no URL names `sto.relay.fidant.se`.                                                                                                                                                                                                                                                  |

## Consequences

- A transfer that needs the relay starts about 3 s later, plus the time the browsers take to reserve relay addresses.
- A pairing whose direct route connects within 3 s of the answer reserves no relay address. The relay carries less, sees fewer addresses and counts fewer allocations against `total-quota`.
- A direct route that takes longer than 3 s, for example on a network that loses many packets, gets the relay restart and may then end up on the relay. After the restart ICE runs with the relay, so a relay pair can still win against a direct route that would also have worked.
- The relay box still sees each browser's IP address on every pairing that gets its `stun:` URL, from the STUN request. After a relay restart it also sees both IP addresses from the allocations, even if a direct route then wins.
- With unmodified browsers, the sender reports `relay` only after a relay restart.
- A recipient page loaded before this change treats `restart-offer` as a bad signal. It ends that attempt with a failure and closes its signaling socket, as when its connection drops.
- A sender page loaded before this change is the likelier case, because senders keep their page open. It starts with the full list and reserves relay addresses at once, but never sends `restart-offer`. A recipient page loaded after the change then starts with STUN only and never adds the relay, so it can reach only the sender's relay address. That fails for a recipient that needs its own relay, such as one on a network that blocks UDP or allows only TCP 443. A reload of the sender's page fixes it.
- A page loaded before this change still starts with the full list, so it reserves relay addresses at once and trickles relay candidates, as before. What this record says about allocations, relay candidates and the `relay` path holds for pairings where both pages were loaded after it.
- A browser whose `setConfiguration` or `restartIce` throws doesn't stop the attempt. On the sender's side the connection goes on without the relay. On the recipient's side the connection can still use the sender's relay address.
- A restarted attempt sends about a dozen more `relay` messages through the server, far under its limit of 1,000 messages per socket per 30-second window (0006). Each is one more `relay` log line.
- `docs/how-fidant-works.md` and the web text no longer say the relay is used only when no direct route works. They say when the relay restart runs.
