# 0025: A private close code for a server restart

- Status: Accepted
- Date: 2026-11-26
- Linear: FID-287

This record amends 0018 (`0018-restart-warm-up-window.md`). Read 0018 with the replacements under Decision.

## Context

- 0018's "Stopping" has the server close every socket with 1012, "Service Restart" in IANA's registry, when it stops on SIGTERM. On 1012 the signaling client reconnects at once and resets its failure count.
- Playwright's WebKit never reports 1012. In a probe for FID-268, a `ws` server closed with each code and a page in each engine read it. In WebKit, 1012 and 1013 arrived as 1005 on macOS and 1006 on Linux, with or without a reason, while 1000, 1001, 1011, 4000 and 4012 arrived as sent. Chromium and Firefox reported 1012. On 2026-11-26 the e2e test "recipients wait for a sender that hosts again late after the restart" passed in WebKit on macOS except for its check for 1012, which received 1005.
- On Linux this matches libsoup, WebKit's network library there: its source accepts the codes it names, up to 1011, and 3000–4999, and fails the connection on any other (`close_connection()` in [`soup-websocket-connection.c`](https://gitlab.gnome.org/GNOME/libsoup/-/blob/master/libsoup/websocket/soup-websocket-connection.c), read 2026-11-26).
- What a page in WebKit loses is small. On any close of a socket that was open for 10 s or more, the signaling client resets its failure count and retries after a random wait of up to 1 s (`signaling-client.ts`). The restart code saves that wait, and for a socket opened less than 10 s before, it also keeps the close from counting as a failure.

## Options considered

1. **Keep 1012.** It is the registered code for exactly this, but pages in WebKit, and probably in Safari, never see it.
2. **1001, Going Away.** Registered, and WebKit passes it. But it says the endpoint is going away, not that it will be back, and others send it: Caddy, in front of the server on the box, writes a 1001 close frame of its own when it closes the WebSockets it proxies (`writeCloseControl` in [`streaming.go`](https://github.com/caddyserver/caddy/blob/master/modules/caddyhttp/reverseproxy/streaming.go), read 2026-11-26). So 1001 wouldn't tell the client that our server is restarting.
3. **A private code, 4012.** RFC 6455 reserves 4000–4999 for private use by prior agreement between applications, and these codes can't be registered ([RFC 6455 §7.4.2](https://www.rfc-editor.org/rfc/rfc6455#section-7.4.2)). Only our server sends it, only our client reads it, and WebKit passes it. Its last three digits match 1012's, so a reader sees what it stands for.

## Decision

Option 3, and the client keeps reading 1012 as a restart.

- **Stopping** (replaces 0018's bullet of that name). On SIGTERM the server closes every socket with close code 4012 (`SERVICE_RESTART` in `@fidant/protocol`) and exits within a second (`main.ts`, `signaling.ts`). On 4012, and on 1012, the signaling client reconnects at once and resets its failure count, so a restart costs the sender no back-off and no "Lost the connection to the server".
- **1012 stays a restart.** Every server built before this record sends it, and a page can talk to one: a rollback can bring one back, and 0023 plans to release the pages and the signaling server in separate steps. It is IANA's code for exactly this, so an endpoint that sends it means what the client does on it, and reading it costs one comparison.
- In 0018's "Starting", read "no 1012 was sent" as "no restart close code was sent". In its Consequences, read "backs off after 1012" as "backs off after the restart close code".

## Consequences

- A send page loaded since this change reconnects at once after a restart in WebKit too, as in Chromium and Firefox, and the e2e restart test runs in WebKit again.
- A send page loaded before this change, in any engine, takes 4012 for a dropped connection: it retries within 1 s, or backs off if its socket had opened less than 10 s before. The warm-up window is sized to that back-off (0018), so it still covers it. After a reload the page reconnects at once again.
- CI checks Playwright's WebKit, not Safari. FID-287 says how to check Safari by hand.
- 0018 stays Accepted.
