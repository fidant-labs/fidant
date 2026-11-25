# 0016: Limits that hold against a stranger with many addresses or a socket that stops reading

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-239

This record amends 0006 and 0012. Read them with the replacements under Decision.

## Context

The security audit of `main` at 880e783 (2026-11-25) found four limits that did not hold the way 0006 and 0012 say:

- **Notices had no server-wide cap (SIG-221).** 0012 says the notice limits bound how much mail anyone can make Fidant send. They were per socket, per client address and per email address, and a client address was an IPv6 /64. Someone with a routed /48 holds 65,536 /64s, and a test sent 4,000 notices from 200 of them in under a second.
- **A stranger could use up an address's code limit (SIG-223).** Codes were limited per link and per email address, not per client. Someone with nobody's link could register links of their own to a person's address and ask for codes on them, so the person's real code request got `wait` for an hour.
- **Replies to a socket that stopped reading piled up (SIG-234).** 0006 says "a slow reader can't make the server buffer without bound". Only relays checked the queue. Every other reply, such as `error`, `joined` or `refused`, was queued however much already waited, so a client that never read could grow the server's memory for as long as it kept sending.
- **The per-address limits leak a count.** A sender who gets `limit` while under its own limits knows the address's notice limit was reached, so it can count notices others sent to that address in the last hour. 0012 did not say this.

## Options considered

1. **Only per-client limits, keyed more coarsely.** Keying IPv6 by /48 alone still lets someone with many /48s, or many IPv4 addresses, send without bound.
2. **A server-wide cap as well.** It bounds the total whatever the addresses. Its cost is that anyone can use it up and stop emailed links for everyone for up to an hour.
3. **Hide which limit was hit.** Answering `failed` instead of `limit` changes nothing: a sender still sees sent or not sent. Answering `sent` without sending would mislead honest senders.

## Decision

Option 2, with option 1 alongside it, and the count leak accepted.

- The server sends at most 500 notices and 500 codes an hour in total (`noticesTotal`, `codesTotal`), well under the mail service's daily quota, so one source can't use the quota or the sender reputation that real users share.
- For notices and codes, an IPv6 client counts by its /48, a site's usual allocation, not its /64. Socket limits still count by /64.
- A client may ask for at most 5 codes an hour (`codesPerClient`). Its own limit is checked first, so codes it is refused don't count against the address.
- A socket that has more than twice the relay limit waiting (512 KiB) is ended at the next message the server would send it. Relays to it are still dropped from 256 KiB, so an honest reader that is only slow keeps its socket.
- Anyone, a stranger with no link included, can use up the limits per email address or for the whole server: they can stop notices or codes to one address, or all of them, for up to an hour, and can tell that an address's notice limit was reached. We accept this. The alternative is no limit on what Fidant emails.

This replaces, in 0006, "a slow reader can't make the server buffer without bound" with: a socket that stops reading is ended once 512 KiB waits for it. It replaces, in 0012, "The not-verified marker in the notice and the notice limits bound it" with: the notice limits, including the server-wide one, bound it, and anyone can use those limits up for an hour.

## Consequences

- A flood of notices or codes from many addresses now stops at 500 an hour and leaves emailed links unavailable to everyone until the hour passes. That outage is the price of the bound.
- Five people behind one IPv6 /48 or one IPv4 address share 50 notices and 5 codes an hour. That is enough for the proof of concept. A larger customer behind one address would need a higher limit.
- `docs/how-fidant-works.md` lists the new limits under "What the server keeps, and limits" and the 512 KiB bound under "The web app and the server".
