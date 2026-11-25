# @sigill/e2e

End-to-end tests on the local stack, with a leak detector that checks every test. The rules it enforces are in [docs/decisions/0001](../../docs/decisions/0001-e2e-tests-and-leak-model.md).

## Running

```sh
pnpm --filter @sigill/e2e exec playwright install chromium  # once per machine
pnpm e2e                                                    # from the repository root
```

`pnpm e2e` builds the web client, starts coturn, Mailpit and the server on free ports, runs the specs in `tests/` and stops them. `pnpm check` does not run it.

coturn is the TURN relay (`brew install coturn` on macOS, the `coturn` package on Linux). It listens on 127.0.0.1 only. The stack makes a relay master for the run and a relay list of two relays on that coturn, each with its own RSA key pair: `bad`, whose secret coturn doesn't know, and `loc`, whose secret, derived from the master, coturn has. The server gets the list and the master as `RELAYS_FILE` and `RELAY_MASTER_FILE`, checks both relays, shows `bad` down and `loc` up at `/relay-status`, and the `joined` signaling message hands each paired browser credentials for `loc`. The server also gets `TURN_URLS` and `TURN_SECRET_FILE`, `loc`'s URLs and secret, which it ignores while it has a list. Without `turnserver` on PATH the stack starts without it and `joined` carries no ICE servers; with `CI` set, that fails the run instead. Global setup sets `SIGILL_E2E_TURN_URLS` only when coturn runs, so a spec that needs the relay can skip on it, and `SIGILL_E2E_RELAYS_FILE` and `SIGILL_E2E_RELAY_MASTER_FILE` to the files' paths, with each relay's private key next to the list as `<id>.key`.

Mailpit catches the server's mail (`brew install mailpit` on macOS, the release binary on Linux). Its SMTP and HTTP API listen on 127.0.0.1 only, on two free ports, and it never sends mail on. The server gets `MAIL_SMTP_URL`, `MAIL_FROM` and `PUBLIC_ORIGIN` (its own `https://localhost:<port>`), so `hello` says mail is on and emailed links point at the stack. Without `mailpit` on PATH the stack starts without mail; with `CI` set, that fails the run instead. Global setup sets `SIGILL_E2E_MAILPIT` to the API's URL only when Mailpit runs, so an email spec can skip on it. Its output (errors only) goes to `observations/run/mailpit.log`. `pnpm e2e:networks` runs no Mailpit.

## Network scenarios

```sh
pnpm e2e:networks  # from the repository root; needs Docker with Compose v2
```

`pnpm e2e:networks` runs only `tests/networks.spec.ts`. Global setup starts `networks/compose.yaml`: two sites behind NAT routers (`networks/router.sh`), a browser container per site address running `playwright run-server` (a1 and a2 at site A, b1 at site B, published on 127.0.0.1:39011, 39012 and 39021), and coturn at 198.51.100.20 on the public network, which has no way out. coturn also serves TURN over TLS on 443 as `turn.sigill.test`, which the browsers resolve to its address, with a self-signed certificate made for the run. Chrome checks TURN certificates despite `ignoreHTTPSErrors`, so the browsers trust that certificate's public key with `--ignore-certificate-errors-spki-list`. The server runs in its own container at 198.51.100.10 on that network, so the browsers reach it through their routers. It reads a relay list (`RELAYS_FILE`) and a relay master (`RELAY_MASTER_FILE`) made for the run: `net`, coturn, which runs with net's secret derived from the master, then `sto`, the relay box. It offers the first relay its check finds up, so the rows use `net`. It listens on 443, the one port router mode `tcp-443` lets out, so the browsers get `https://198.51.100.10` as their base URL. The host never connects to it. On Docker Desktop the host cannot reach 198.51.100.x at all, and does not need to.

The public network also holds the box at 198.51.100.30 (`networks/box`): Ubuntu 24.04 with systemd, running the app server, HAProxy, Caddy, coturn and rsyslog as on the POC box, configured from the rendered `apps/infra/box/user-data.sh` (`src/stack/box.ts`). The browsers reach it as `https://fidant.se` and `turn.fidant.se` through `--host-resolver-rules`. The `the box` test sends one file through its relay, then reads its journal and `/var/log/syslog`: nothing from the four services may reach syslog, journald's settings must resolve to `ForwardToSyslog=no`, `MaxRetentionSec=29day` and `MaxFileSec=1day`, and the app server's journal lines must pass the stdout allowlist and hold no client address or user agent. The first run builds the box image.

The relay box is at 198.51.100.40 (`networks/relay`): Ubuntu 24.04 with systemd and the packages that `apps/infra/relay/install.sh` would install, so the script runs offline at boot, as on a new server. It gets the script's inputs and the run's TURN certificate, in place of a Let's Encrypt one, from `SIGILL_E2E_RELAY_DIR`. The browsers reach it as `sto.relay.sigill.test`. Its `APP_URL` is the server's `https://198.51.100.10`, whose self-signed certificate it doesn't trust, so its timer's fetch gets no secret. The `the relay box` tests check what the script set up, that the relay answers STUN and refuses every allocation while it has no secret, and that its fetch, with the server's certificate pinned, applies sto's secret from the server's hand-out, after which the server finds sto up.

Each row of the spec's table names the sender's and recipient's site, the mode of router-b (`routerMode()` in `src/stack/networks.ts`) and the candidate pair ICE must select. Teardown removes every container and network, also after a failed run; a run that was killed is cleaned up by the next one. The first run pulls the images, so it needs the internet once.

## Writing a test

Import `test` and `expect` from `src/fixtures.ts`, not from `@playwright/test`.

- The default `page` and `context` are recorded as the actor `default`. For more browsers, call `actor("sender")`, `actor("recipient")` and so on. Each gets its own context and page and its own observations file. Do not call `browser.newContext()`: an unrecorded context fails the test.
- `test.use({ remoteBrowsers: { sender: "ws://127.0.0.1:39011/" } })` opens that actor in a browser served by `playwright run-server` at the endpoint, with the project's launch options and the same recording. Start the server with `--unsafe`, or it drops the launch `args`. Downloads from a remote browser have no local `path()`; use `saveAs()` or `createReadStream()`.
- `canary` gives random bytes from the run seed and the test's title. Fork it per canary: `canaryFile(canary.fork("file"))`, `canaryKey(canary.fork("key"))`.
- `leaks.watch(file, label?)` registers a canary file and returns it: its bytes and their SHA-256, the tokens in its name and type, the SHA-256 of its name, and its size. `leaks.watchKey(label, key)` registers a key, as bytes or as text such as a fragment secret. `leaks.watchText(label, text)` registers other text that must not appear whole, such as a recipient name. `leaks.watchContent(label, text)` registers text that is content, such as a text shared from `/secret`: any 16 bytes in a row of its UTF-8, and its SHA-256.
- An emailed link's secret, the sender's typed name, the address, the server's value and the token may appear in a few places ([decision 0012](../../docs/decisions/0012-email-recipients.md)). Pass those places as the last argument of `watchKey` or `watchText` (`Allowed` in `src/leaks/needles.ts`): the signaling messages about the link that may carry it, such as `sent email` (the first one only) or `received token`, and the mail to the address that may carry it, either the body of the notice (by its Mailpit ID) or any part of any mail to it. A mail counts only if it is one plain-text part to that address alone: one To, no Cc or Bcc. Findings anywhere else stand, a second copy of the notice and the headers of the notice itself included.
- After the test, the detector scans what the test observed for every secret it registered and fails the test on any finding. `leaks.scan()` returns the findings so far without failing, and `leaks.check()` returns the report the teardown would throw (undefined when clean). A test that leaks on purpose calls `leaks.expectLeaks()`. `tests/leaks.spec.ts` shows a leak caught in a request URL, a request header, a request body (plain and gzip), a sent websocket frame and a console message. The unit tests in `src/leaks/` cover each encoding, hash, window and size rule.
- Once all tests are done, a run-level sweep scans every observation against every secret of the run, so a leak that shows up in another test's traffic or a later log line still fails the run.

- `restartServer()` from `src/stack/server.ts` restarts the server on the same port and resolves once it listens again, like a deploy or a crash: browsers lose their signaling sockets and the server forgets every link. Global setup's server service does the restart (it starts the server again whenever it exits on SIGTERM), and both runs write to the same logs, so the leak checks cover them. The specs run one at a time (`workers: 1`), so a restart cannot break another test. Local stack only: `pnpm e2e:networks` has no restart.
- Every recorded context logs, as `sigill-e2e:` console warnings, the error of a rejected `createOffer`, `createAnswer`, `setLocalDescription`, `setRemoteDescription` or `addIceCandidate` call on a peer connection and the call stack of every `close()` on a peer connection or data channel, which the app keeps out of its own console. The recorder writes them to the observations, so a failed CI run says why a connection ended. The script runs before any test script, so a test that assigns its own replacement for one of these methods overwrites the logging wrapper, and its injected failures are not logged. A test that wraps a method and calls the original still goes through the logger.

Requests outside the stack are aborted and fail the test. A test may still route the stack's own sockets with `page.routeWebSocket`, as `tamperSignal` in `tests/first-demo.spec.ts` does to alter signaling: a page route takes precedence over the recorder's context route and bypasses its off-stack block for every URL it matches. Match only stack URLs. The recorder still sees the frames on the wire, as the server sends and receives them (what the page sends after the edit, what the server sends before it).

## What is scanned

Today:

- Browser requests and responses: URL, every header and request bodies.
- WebSocket frames, sent and received, including `/signal`.
- Browser console messages: the text and the page URL without its fragment.
- Server stdout and stderr. Stdout must also pass a strict allowlist: one JSON object per line, with known keys and values only (`src/leaks/server-log.ts`).
- coturn's verbose log, `observations/run/coturn.log`, Mailpit's output, `observations/run/mailpit.log`, and the stack's own events, such as an unexpected server exit, `observations/run/stack-events.log`.
- Every mail Mailpit caught, as two captures of its raw source: the headers, unfolded, which carry the envelope as Mailpit records it (Return-Path, Received and, for a recipient not in To or Cc, Bcc), and the body. A finding names the part, such as `observations/<test>/mail/<ID>.eml body`. Each test's check saves the mail that arrived during the test to `observations/<test>/mail/<ID>.eml`, and its teardown deletes those messages from Mailpit. Global teardown saves what is left to `observations/run/mail/`.
- In the network scenarios only, every packet to and from coturn, `observations/run/coturn.pcap`. The `pcap` service of `networks/compose.yaml` runs tcpdump in coturn's network namespace with `NET_RAW`, so no sudo is needed (decision 0001 expected sudo on CI). The file is scanned as raw bytes, one capture per test from where it stood when the test began. It holds STUN and TURN headers, DTLS ciphertext and, for TURN over TLS, TLS ciphertext only, so it is safe as a CI artifact. `pnpm e2e` has no packet capture.
- In the network scenarios only, the box's journal for sigill, haproxy, caddy and coturn (`observations/run/box-journal.jsonl`, the message of each `journalctl -o json --all` entry, one per line, binary ones hex-encoded) and its `/var/log/syslog` (`observations/run/box-syslog.log`), written by the `the box` test after its transfer.

Every capture is decoded into views (percent, JSON escapes, base64, hex, gzip and others, nested) before matching, so encoded leaks are caught too.

Not wired yet. Each arrives with the first issue that needs the service:

| Observation point                            | Issue          |
| -------------------------------------------- | -------------- |
| DynamoDB requests, responses and snapshots   | SIG-42         |
| BankID simulator and TSA, through the proxy  | SIG-42         |
| File-name carriers (`src/leaks/carriers.ts`) | SIG-42, SIG-43 |
| Object storage                               | SIG-43         |

## Adding an observation point

Write the raw data under `observations/`. The run-level sweep fails on any file there that no leak check reads, naming it, so every new file needs one of these:

- A file for the whole run, directly in `observations/run/`: add it to `runSources` in `src/paths.ts`, read as `lines` (a log, one capture per line) or `binary` (raw bytes, such as a packet capture). Both the per-test scan in `src/leak-watch.ts`, which reads what the file grew by during the test, and the sweep in `src/sweep.ts`, which reads all of it, then pick it up. A file that holds nothing a test could leak, such as `server.pid`, goes in as `ignored` with its reason.
- A file per test, in `observations/<test>/`: turn what the point saw into `Capture`s (`src/leaks/scan.ts`), a `point` naming where it was seen, such as `observations/<test>/mail/<ID>.eml`, and the `bytes`, with a `contentEncoding` hint if the bytes are compressed. Add them to the per-test scan in `src/leak-watch.ts`, and add a rule for the file to `formatOf` in `src/sweep.ts`. `src/leaks/captures.ts` does this for browser records (`<actor>.jsonl`) and saved mail (`mail/<ID>.eml`).

## Reproducing a failure

The run prints its seed first:

```
Canary seed: 9d46…d665 (set SIGILL_E2E_SEED to replay it)
```

A failure repeats the seed. Run `SIGILL_E2E_SEED=<seed> pnpm e2e` to get the same canaries.

## Findings are public

A finding prints up to 64 bytes around the match, and `observations/` is uploaded by CI. Both are public. That is acceptable only because canaries and canary keys are throwaway test values. Saved mail is uploaded too: it holds links to the local stack with throwaway keys, and made-up addresses. Never watch real data, real keys or anything else secret.
