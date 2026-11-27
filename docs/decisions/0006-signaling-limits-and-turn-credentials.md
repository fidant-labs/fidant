# 0006: Signaling limits and TURN credential hand-out

- Status: Accepted
- Date: 2026-11-24
- Linear: FID-51

## Context

- The signaling server at `/signal` is public. Before FID-51 it had no cap on sockets, messages or bytes queued to a slow reader. One client could exhaust it.
- `GET /ice-servers` handed TURN credentials to anyone who asked, valid for 12 hours. Anyone could use our relay.
- Anyone can `host` any link ID, so a check on `host` alone proves nothing. Only a pairing (a host and a guest on one link) shows a transfer is about to start.
- Sealed signals were bound to the link and direction, not to one join attempt. A server could replay an old attempt's signals into a new one, and a late `refuse` could hit the next attempt.
- In production Caddy terminates TLS in front of Node (FID-75), so the TCP peer is Caddy, not the client.

## Options considered

| Option                                          | For                                                               | Against                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fixed limits as constants in the server         | Simple. No config to get wrong. Tests override them.              | A change needs a deploy.                                                                                          |
| Configurable limits                             | Tunable per host.                                                 | Config for values nobody tunes yet.                                                                               |
| Close the socket on every protocol error        | Hostile clients go away fast.                                     | `not-on-link` hits honest clients through races, and one host socket carries up to 256 links. One race kills all. |
| Close only on bad messages and rate overrun     | Honest races survive. The rate cap still bounds a hostile client. | A hostile client can send errors up to the rate cap.                                                              |
| Trust X-Forwarded-For always                    | Works behind any proxy.                                           | Any client can pick its own address and escape the per-address cap.                                               |
| Trust X-Forwarded-For from a loopback peer only | Only a proxy on the same host can set it.                         | A proxy in another container or host puts every client in one bucket.                                             |
| TURN credentials from `/ice-servers`            | Already built.                                                    | Anyone gets them, no pairing needed.                                                                              |
| TURN credentials in `joined`, per pairing       | Only paired sockets get them. No extra request.                   | Anyone can still pair with themselves.                                                                            |

## Decision

### Limits

| Limit                    | Value                            | When hit                                                             |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------- |
| Open sockets             | 1000                             | Upgrade rejected with 503                                            |
| Open sockets per address | 32                               | Upgrade rejected with 429                                            |
| Messages per socket      | 1000 per heartbeat window (30 s) | Socket closed with 1008, server logs `rate-limited`                  |
| Bytes queued to a socket | 256 KiB                          | The relay is dropped, server logs `relay-dropped`; sender stays open |

- Messages that fail to parse count toward the rate and close with 1008 as before (`bad-message`).
- Protocol errors (`wrong-role`, `already-hosted`, `already-joined`, `not-on-link`) get an error reply and keep the socket open.
- The window is fixed and reset by the heartbeat, so a socket can send twice the limit across a boundary. A token bucket comes if that matters.

### Client address

- X-Forwarded-For is trusted only when the TCP peer is loopback. The server takes the rightmost entry, the one the proxy wrote.
- IPv4-mapped IPv6 counts as IPv4. Other IPv6 addresses count by their /64, since one host usually owns a whole /64.
- The address is only a key in an in-memory count. It is never logged.

### Per-attempt ID

- The recipient makes a random 16-byte attempt ID for each join and each "Try again". It travels in `join`, `joined` and `refuse`.
- The sealed-signal AAD is `fidant/v1/signal|<link>|<attempt>|<dir>`. Signals from one attempt don't open in another.
- The server ignores a `refuse` whose attempt doesn't match the bound guest's.
- The attempt ID is never logged.

### TURN credentials

- `joined` goes to both ends of a pairing, guest first, and carries `iceServers`. Credentials are minted per pairing and expire after 5 minutes. `/ice-servers` is gone.
- Measured: coturn 4.19 kept a relayed connection alive, and accepted its refreshes, 11 minutes after a 20-second credential had expired. Expiry gates only new allocations and doesn't limit how long a transfer runs. So 5 minutes is enough to start, and a leaked credential stops working soon after.
- The TURN secret stays in the server process. `main.ts` reads it from `TURN_SECRET_FILE`, and only minted credentials leave the process.
- `main.ts` checks `TURN_URLS` at startup with the protocol's `parseIceServers` (1 to 4 `turn:`, `turns:` or `stun:` URLs). A bad URL would make every browser reject `joined`, so the server refuses to start instead.

## Consequences

- One address can no longer exhaust the server's sockets or memory, and a slow reader can't make the server buffer without bound.
- A refused upgrade socket is destroyed after the response is written, and errors on it are ignored. A client that resets or never closes its side can neither crash the server nor hold the socket.
- Accepted for the POC: 32 sources can still fill the global cap of 1000, after which upgrades get 503. A source is one IPv4 address, or one /64, so 32 /64s from a single IPv6 /48 is enough. The upgrade path is Caddy and coturn limits on the host (FID-75, FID-77) and a wider IPv6 prefix.
- Deploy (FID-75): Caddy and Node must run on the same host, and Caddy must set X-Forwarded-For. A proxy in a container or on another host reaches Node from a non-loopback address, and every client then shares one bucket of 32 sockets.
- A replayed signal from an old attempt fails to decrypt, and a stale `refuse` no longer unbinds the next guest. Accepted residue: a server that lies about the attempt in `joined` can break that one attempt, nothing more. The server can already drop any message.
- Accepted for the POC: anyone can pair with themselves and get TURN credentials. The per-address caps and coturn quotas on the host (FID-77) slow that down. Revisit with BankID-verified transfers.
- Accepted without a fix:
  - Total hosted links. They are bounded by sockets × 256 links per socket.
  - A Host header allowlist. TLS and Caddy already cover it.
