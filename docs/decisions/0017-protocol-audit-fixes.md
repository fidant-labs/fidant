# 0017: A file key per recipient attempt, a new link after a refused email, and hosting around a taken link

- Status: Accepted
- Date: 2026-11-25
- Linear: SIG-231

This record amends 0002 and 0012. Read them with the replacements under Decision.

## Context

The security audit of `main` (2026-11-25) found three faults in the signaling and transfer protocol:

- **A replayed INIT made the recipient reuse a nonce (SIG-231).** The file key's salt was the sender's transfer ID alone, and both sides number their frames from 0 in every attempt. Someone who recorded an attempt's INIT and META and can inject data channel traffic without the link's secret, which needs a break of DTLS, could play them to the recipient in a later attempt. The recipient then derived the same key and sealed its first frame a second time under the same key and nonce, which AES-GCM must never do.
- **A refused email left a link whose secret the server had seen (SIG-237).** The `email` message carries the link's secret. When the server answered `limit`, or `failed` before sending anything, the send page offered that same link to share by hand, so a link our server had seen went out as one it never sees.
- **One taken link ID blocked all of a sender's links (SIG-233).** The server refused a whole `host` message if any link ID in it was hosted by another socket. A sender that reconnected while someone else hosted one of its link IDs could host none of them.

## Options considered

1. **SIG-231: a recipient nonce, or a random IV per frame.** Either changes the frame format and the IV rule more than needed. A value the recipient picks in the key's salt gives it a fresh key per attempt with no new frame field, and the recipient already picks a fresh attempt ID for every join.
2. **SIG-237: tell the sender to remove and add the recipient.** It leaves the seen link on screen in the meantime. Replacing the link at once costs nothing: the old one has no join yet that matters, or that join is refused.
3. **SIG-233: keep refusing the whole message.** It keeps a sender's links hostage to any one of them, for as long as the other socket holds it.

## Decision

- The file key is `HKDF-SHA256(secret, salt = transferId ‖ attempt, info "sigill/v2/file")`, where `attempt` is the 16 decoded bytes of the recipient's attempt ID for that join. The sender learns it from `joined`. The frame version is 3, and a frame of any other version fails as "unknown frame version", so a page on another release fails at INIT on the recipient's side, and the sender sees only the connection close. The recipient sees the same message as for unreadable data, and only the page on the older release needs to reload. A server that lies about the attempt ID in `joined` only makes the two keys differ and breaks that one attempt, as dropping messages would.
- When the server answers an `email` registration with `limit` or `failed` and no mark, the send page gives that recipient a new link (new link ID and secret), stops hosting the old link ID, hosts the new one and refuses any join on the old one as `unknown`. When the page answers `failed` itself because its socket was closed, nothing was sent, and it keeps the link. A `failed` with a mark is unchanged: the link stays email-bound.
- A link ID that another socket already hosts is left out of a `host` message as if it were not in it. The server hosts the others and still answers `error` `already-hosted` once, and the page sends its whole list again 5 s later. 0006 ("Anyone can `host` any link ID") and 0012 (someone can host an emailed link's ID once the sender stops hosting it) already accept that anyone can host a link ID nobody hosts, and so hold that one link until their socket closes. That is unchanged. What is new is that one taken link no longer blocks the sender's others.

This replaces, in 0002, "The file key is `HKDF-SHA256(fragmentSecret, salt = transferId, info "sigill/v1/file")`." with: The file key is `HKDF-SHA256(fragmentSecret, salt = transferId ‖ attempt, info "sigill/v2/file")`, where `attempt` is the 16 bytes of the recipient's attempt ID for that join (SIG-231). So the per-attempt key depends on both sides' attempt values, not only on the `transferId` that 0002's `ciphertext.attempt` names.

It replaces, in 0012, "If the server refused the registering message, no notice went out and the link is a plain link." with: If the server refused the registering message, no notice went out, and the send page replaces the link with a new plain link, because the registering message gave the server the old link's secret. Only a page that could not send the message, because its socket was closed, keeps the link.

## Consequences

- A sender and a recipient on different releases across this change can't transfer until both reload.
- A link offered to share by hand is again one whose secret never reached our server.
- A recipient who opened the old link before the page replaced it is cut off and needs the new link.
- `docs/how-fidant-works.md` describes all three under "Keys", "Connecting the two browsers", "Frames", "Registering an emailed link" and "Retries and failures".
