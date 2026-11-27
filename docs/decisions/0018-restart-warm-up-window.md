# 0018: A warm-up window after the server starts

- Status: Accepted
- Date: 2026-11-25
- Linear: FID-136

## Context

The server keeps hosted links only in memory. Every deploy restarts it, and a crash does too. Until each sender's page reconnects and sends `host` again, the new server doesn't know their links, so a `join` for one gets `refused: unknown`, the same answer as for a link nobody hosts. The recipient page then says "This link isn't active".

FID-88 papered over this on the client: after a socket drop or a failed connection attempt, `ReceivePage.tsx` read `unknown` as "the server may have restarted" and tried again, up to 4 times (`failedBefore` and the `unknown` rejoin branch). That guess only helps a recipient who was already connected during the restart. A recipient who opens the link after the restart, before the sender re-hosts, sees "This link isn't active" for a link that works seconds later.

A restart also looked like a fault to the sender. systemd stops the service with SIGTERM and, if it is still running after `TimeoutStopSec` (90 s by default), with SIGKILL ([systemd.kill(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html), [systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)). The server had no SIGTERM handler, so sockets just dropped. The send page counted that as a failed connection, backed off, and could show "Lost the connection to the server".

The sender's back-off is in `apps/web/src/lib/signaling-client.ts`: after each socket that failed or closed within `STABLE_MS` (10 s) of opening, it waits a random time up to min(`RETRY_MAX_MS`, `RETRY_BASE_MS` × 2^failures), that is up to 30 s.

## Options considered

1. **No window.** `unknown` stays final. Simple and honest, but every restart breaks every link someone opens before its sender is back.
2. **A client-side guess, as in FID-88.** The recipient can't tell a restart from a dead link, so it either retries every dead link or misses recipients who arrive after the restart. It can't be right for both.
3. **Persist hosted links across restarts.** The server would need storage it otherwise doesn't (`AGENTS.md`: add infrastructure only when a feature needs it), and a stored link still has no sender until that sender reconnects.
4. **The server says it has just started.** For a fixed window after start, the server answers a `join` for a link it doesn't know with `starting`. Only the server knows it restarted, so the guess becomes a fact.

## Decision

Option 4, together with a close code that tells clients the server is stopping.

- **Stopping.** On SIGTERM the server closes every socket with close code 1012 and exits within a second (`main.ts`, `signaling.ts`). 1012 is "Service Restart" in IANA's WebSocket close code registry ([IANA](https://www.iana.org/assignments/websocket/websocket.xhtml)), in the 1000–2999 range RFC 6455 reserves for codes the registry defines ([RFC 6455 §7.4.2](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2)). On 1012 the signaling client reconnects at once and resets its failure count, so a restart costs the sender no back-off and no "Lost the connection to the server".
- **Starting.** The protocol gains the refusal reason `starting`, which only the server sends in `refused`; a sender's `refuse` cannot carry it. For `STARTING_MS` after the server starts, a `join` for a link nobody hosts gets `starting` instead of `unknown`; a link with a recipient bound still gets `busy`. After the window, `unknown` means what it says. The window works after a crash too, where no 1012 was sent.
- **Length.** `STARTING_MS` is 60 s, 2 × `RETRY_MAX_MS`, counted from when the server starts. The worst-case sender is one whose last attempt failed just before the new server listened, for example after a crash: it waits at most 30 s before its next attempt, and that attempt connects in well under a second. A hidden tab's timers may fire late: Chrome aligns them to whole seconds, and to whole minutes for chains of timers in tabs hidden 5 minutes ([Chrome 88 timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)); the reconnect timer is set from a close event, not a chain. Doubling the 30 s gives that margin. Both constants live in `@fidant/protocol`, so the window follows the back-off if it changes.
- **Recipient.** On `starting`, the receive page sends `join` again on the same socket after 1 s, and each `join` re-arms its connect timeout, so the server decides when waiting ends. One `join` a second is far below the per-socket message limit. `unknown` always ends the attempt: the FID-88 guess (`failedBefore` and the `unknown` rejoin branch) is removed. `MAX_REJOINS` still bounds new attempts after a socket that drops after opening.
- **Test knob.** `main.ts` reads the environment variable `STARTING_MS` (a non-negative integer of milliseconds, default 60 s). It exists only so the e2e stack can start its server without a window, so the tests that expect `unknown` don't wait 60 s. The stack's restarted servers run with the real window. Production never sets it.

## Consequences

- A recipient who opens a link in the first 60 s after a restart reaches its sender as soon as the sender re-hosts, instead of seeing "This link isn't active".
- A link that really is dead, opened in the first 60 s after a start, shows "Connecting to the sender…" for up to 60 s before "This link isn't active".
- Old pages still loaded when the server restarts: an old receive page doesn't know `starting`, drops the message and fails after its 30 s connect timeout with a server problem, not "This link isn't active". An old send page backs off after 1012 as after any drop; the window is sized to that back-off, so it still covers it.
- Emailed links still end on a restart, as 0012 says: the server drops each email binding with the sender's old socket, so the recipient's `gate` matches nothing and the page says the link no longer works (`unbound`). The window doesn't change that.
- A restart now drops every socket deliberately within a second of SIGTERM, well inside systemd's stop timeout. Transfers whose data channel is open don't need the server and continue.
