# 0008: The sender can refuse the relay

- Status: Accepted
- Date: 2026-11-24
- Linear: FID-101

## Context

- 0007 put a TURN relay on the app box. When two browsers can't connect directly, the file passes through it, still encrypted. The relay sees both browsers' IP addresses and the encrypted traffic.
- Some senders don't want their file to pass through our relay at all. This is the first sender choice that changes what our infrastructure sees.
- The server hands out TURN credentials in `joined`, minted per pairing (0006). Only our server can mint them, but coturn can't tie a credential to one pairing.
- The browsers already detect which path each connection took. The sender reports it to the server as `direct`, `stun`, `relay` or `failed`.

## Options considered

| Option                                                                | For                                                                            | Against                                                                                                                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enforce it in the browser: the sender drops remote `relay` candidates | No server change.                                                              | A recipient that sends its connectivity checks through a relay shows up on the sender's side as a peer-reflexive candidate, which looks like a direct one. |
| The server withholds TURN for a refused send                          | Unmodified browsers never get relay access. Nothing to trust in the recipient. | A modified recipient can still use credentials from another pairing (see Consequences).                                                                    |
| A flag per link                                                       | Could later differ per recipient.                                              | The checkbox is per send. More protocol for no use today.                                                                                                  |
| One flag per send, on `host`                                          | Matches the checkbox. Changing it re-sends `host`.                             | A change applies only to joins after it.                                                                                                                   |
| A new path value, `refused`                                           | Path counts would tell a refused relay from a failure.                         | A new log value, and /privacy's log list changes.                                                                                                          |
| Report a refused connection as `failed`                               | Log fields and /privacy's log list stay as they are.                           | Path counts can't tell the two apart.                                                                                                                      |
| Empty-string credentials on a STUN-only entry                         | One `IceServer` shape.                                                         | Looks like a TURN credential.                                                                                                                              |
| No credential keys on a STUN-only entry                               | The parser can require that such an entry lists only `stun:` URLs.             | Two shapes.                                                                                                                                                |

## Decision

- The send page has a checkbox, "Allow our relay if a direct connection isn't possible". It is on by default, applies to that send only and isn't remembered. It stays editable after recipients are added.
- `host` carries `turn: boolean` for the whole send, and the sender re-sends `host` whenever the checkbox changes. The server keeps the latest value per sender, in memory only, and never logs it.
- `join` reads the sender's current value. `joined` carries it as `turn` to both browsers, so each attempt knows the setting it got.
- With `turn: false`, `joined.iceServers` keeps only the `stun:` URLs, with no `username` or `credential`, and the server mints no credential. With no `stun:` URL configured, `iceServers` is empty.
- `parseIceServers` accepts an entry without credentials only when all its URLs are `stun:`.
- A connection that can't be made without the relay reports `failed`. There is no new path value or log field.
- When a refused attempt ends before its data channel opens, both pages say so in plain words. The sender's card says that allowing the relay may let the recipient connect when they try again. The recipient is told that the sender doesn't allow the relay, and that another network may work. "Try again" on the receive page starts a new attempt, which follows the sender's current setting.
- Backstop: if the sender's selected candidate pair still reads `relay` on a refused attempt, the sender ends the attempt and reports `failed`.
- The "Holds" row on the send page and the list of what our server sees, on /privacy and the landing page, name the sender's relay choice.

## Consequences

- Our server never hands out relay access for a refused send, and an unmodified browser never uses our relay on one, whatever its network does. That is the whole guarantee:
  - A modified recipient can get valid credentials from another pairing, for example by hosting and joining a link of its own, and route its end through our relay. If it doesn't send that relay candidate, the sender sees a peer-reflexive candidate and reads the path as `stun`.
  - It can do the same with any public TURN server.
  - That recipient can decrypt the file anyway. The opt-out only decides which infrastructure carries the encrypted traffic.
- The backstop is best effort, and it fails open: `connectionPath` returns `direct` when it finds no selected pair, and `readPath` does the same when `getStats` fails. It runs only after the data channel opens, so the encrypted setup frames (INIT and META) may already have passed. File chunks start only after the recipient accepts, so in practice it fires before any file data.
- Refused sends still use STUN on the relay box (`stun:turn.fidant.se`). coturn sees each browser's address for the binding request. No file data passes through it.
- Unticking the box doesn't affect a recipient who has already joined, including one already connected through the relay. Ticking it helps a refused recipient only once they press "Try again".
- A refused connection can take up to `SETUP_TIMEOUT_MS` (20 s) to show its message. Without relay candidates, ICE may never start, and then the sender's setup timeout ends the attempt.
- Under `turn: false`, any attempt that ends before its channel opens is shown as a refused relay, even when the cause was something else, for example the recipient closing the tab while connecting. The sender's message says "may" for that reason.
- The local demo has no TURN server. The flag is still sent and echoed, so the messages appear there too.
- Tabs opened before the deploy that added `turn` stop working until they are reloaded. The server rejects an old `host`, and an old receive page ignores the new `joined`.
