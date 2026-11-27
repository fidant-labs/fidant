# 0001: End-to-end tests and leak model

- Status: Accepted
- Date: 2026-11-23
- Linear: FID-38

## Context

### The invariant

AGENTS.md says: never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them. The one deliberate exception: the BankID receipt text names the file. Keys live only in the URL fragment or in browser memory.

The invariant is easy to state and easy to break by accident: a log line, a debug header, a hash sent "for convenience". End-to-end tests should catch such breaks. To do that they need a concrete definition of a leak and a way to observe everything that leaves the browser.

### Split key for verified transfers

In a verified transfer the key is split in two:

- one half travels in the link's URL fragment;
- the other half is held by the server and released to a recipient only after their BankID receipt is signed.

The sender's browser generates both halves. It sends the server half to the server in the create-transfer request.

The server half is therefore a secret the server may hold, but only in specific places.

### The local stack

The project must run fully local. The stack the tests will run against:

| Service                   | Role                                          |
| ------------------------- | --------------------------------------------- |
| App server                | Serves the web client, signaling, API         |
| Postgres                  | Transfers, server key halves, receipts, audit |
| Object storage            | Encrypted files for stored transfers          |
| Mail catcher              | Notices sent by mail, never a key             |
| coturn                    | TURN relay for peer-to-peer transfers         |
| BankID simulator          | Identity and signing                          |
| Local timestamp authority | Timestamps on receipts and the audit log      |

Most of these do not exist yet. This record covers them ahead of time so each feature adds its observation point when it adds the service.

### What exists today

- One Node process (`apps/server`) serves the built web client over HTTPS.
- It generates a self-signed certificate in `.certs/`. The path is hardcoded in `main.ts`.
- Every response sets `referrer-policy: no-referrer` and a CSP with `default-src 'self'`.
- The server prints human-readable startup text to stdout.

### What FID-21 brings

FID-21 is in progress on another branch. It adds:

- WebSocket signaling at `wss://<host>/signal`, with message types in `packages/protocol` (`@fidant/protocol`).
- Client messages: `host`, `join`, `relay`, `refuse`. Server messages: `joined`, `left`, `relay`, `refused`, `host-gone`, `error`.
- Link IDs: 22 characters of base64url.
- Recipient links: `/r/<linkId>#<secret>`, where the secret is 43 characters of base64url (32 bytes).
- `relay.data` is `base64url(iv ‖ AES-GCM(SDP/ICE JSON))`, under a key derived from the fragment secret.
- Server stdout is strictly one JSON object per line:
  - events: `listening`, `upgrade-rejected`, `bad-message`, `error`, `host`, `host-gone`, `host-closed`, `joined`, `refused`, `relay`, `relay-dropped`, `left`;
  - fields: `event`, `link` (first 6 characters only), `links`, `bytes`, `reason`, `code`, `port`;
  - human text goes to stderr.
- `@fidant/protocol` exports the enums the log check needs: `ErrorCode` (`bad-message`, `wrong-role`, `already-hosted`, `already-joined`, `not-on-link`) and `LogReason` (`RefuseReason` plus `"path"` and `"origin"`).
- File transfer frames in `apps/web/src/lib/frames.ts`:
  - `paddedLength(n)` applies Padmé, then rounds up to whole 48 KiB chunks. Every CHUNK frame is full size.
  - The exact size travels only inside the encrypted META frame.
  - The META plaintext is padded to exactly 1024 bytes (`META_PADDED_BYTES`), and the reader requires that length. `encodeMeta` throws if the JSON does not fit, and the send page refuses that file with an inline error.
  - Each CHUNK frame has a 10-byte header and a 16-byte tag.
  - The file checksum (END and RECEIPT frames) travels only over the encrypted data channel, never through signaling.
  - FID-7 may replace `paddedLength` later.
- Key derivations live in `apps/web/src/lib/keys.ts`, not in a workspace package. AGENTS.md says to create a package only once a second consumer exists.
- An interim Playwright test in `apps/web/e2e/`, run by the CI job `first-demo-e2e`. FID-41 later moves it onto the harness this record describes.

## Options considered

### Capturing browser HTTP

| Option                                        | For                                                   | Against                                                               |
| --------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| TLS-terminating recording proxy (MITM)        | Sees every byte on the wire, any browser              | Extra moving part; cert trust; WebSocket and HTTP/2 quirks            |
| Server instrumentation                        | Simple; sees decoded bodies                           | Misses requests to other hosts; trusts the code under test            |
| Playwright `context.on('request'/'response')` | Built in; every host; headers, bodies, URLs; per test | Depends on Playwright exposing everything; some bodies may be missing |

### Capturing WebSocket frames

| Option                 | For                                               | Against                                                 |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| Server-side tap        | Sees what the server actually got                 | Trusts the code under test; one more hook in the server |
| `page.on('websocket')` | Built in; sees frames in both directions per page | Must be attached in every context                       |

### Capturing server-to-dependency traffic

| Option               | For                                     | Against                                                          |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Per-tool logs        | No extra process                        | Each tool logs differently, often partially; easy to miss a body |
| Recording HTTP proxy | One capture format for every dependency | Must be wired in through the server's URLs                       |

### Postgres

| Option                        | For                                          | Against                                          |
| ----------------------------- | -------------------------------------------- | ------------------------------------------------ |
| Dump only                     | Simple                                       | Misses rows that were inserted and later deleted |
| Dump plus `log_statement=all` | Sees every statement, including deleted rows | Larger logs; test instance only                  |

### Capturing keys for the detector

| Option                                                           | For                                                     | Against                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------ |
| Test build flag or debug endpoint                                | Direct access to every key                              | Test-only code paths in the app; a flag left on is itself a leak   |
| Init-script hook on `crypto.subtle`                              | No app changes; sees every key                          | Fragile; depends on keys being extractable; hooks the code we test |
| Read the fragment, reproduce derivations with exported functions | No test-only code in the app; uses the real derivations | Derivations must be exported from a workspace package              |

### SDP over signaling

| Option                       | For                                                        | Against                                                  |
| ---------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Plaintext                    | Simple; easy to debug                                      | A hostile signaling server can swap the DTLS fingerprint |
| Encrypted under the link key | Protects the DTLS fingerprint; server sees only ciphertext | Tests must decrypt to inspect candidates                 |

FID-21 chose encrypted.

### Receipt checksum

The receipt must commit to the file so a verifier can check it later.

| Option           | For                                         | Against                                                                    |
| ---------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| Plain SHA-256    | Simple; anyone with the file can verify     | Confirms a guessed file to anyone who sees the hash (BankID, server, logs) |
| Salted SHA-256   | Hides the hash from anyone without the salt | Verifier needs the salt as well as the file                                |
| Key-derived HMAC | Hides the hash; no extra secret             | Verifier needs the key; evidence depends on the transfer key               |

### File size

The exact size is metadata, and ciphertext length reveals it.

| Option               | For                                                 | Against                                            |
| -------------------- | --------------------------------------------------- | -------------------------------------------------- |
| No padding           | No overhead                                         | Exact size visible to storage, TURN and the server |
| Power-of-two buckets | Strong hiding; simple                               | Up to 100% overhead                                |
| Padmé                | Leaks O(log log N) bits; at most about 11% overhead | Slightly more code                                 |

### Certificate trust in tests

| Option              | For                                    | Against                                               |
| ------------------- | -------------------------------------- | ----------------------------------------------------- |
| `ignoreHTTPSErrors` | One line; `isSecureContext` stays true | Chromium blocks service workers on certificate errors |
| Local CA            | Real trust; service workers work       | Per-browser trust stores; setup on CI                 |
| Chromium SPKI flag  | Real trust in Chromium                 | Chromium only                                         |

### Package location

| Option           | For                                              | Against                           |
| ---------------- | ------------------------------------------------ | --------------------------------- |
| `apps/e2e`       | Fits the workspace layout; a normal pnpm package | Not something we ship             |
| Top-level `e2e/` | Clearly separate                                 | Outside the workspace conventions |

### Whether `pnpm check` runs e2e

| Option | For                                        | Against                                            |
| ------ | ------------------------------------------ | -------------------------------------------------- |
| Yes    | Every commit runs the full suite           | Slow; needs browsers and services on every machine |
| No     | `pnpm check` stays fast and offline-simple | e2e runs separately, locally or in CI              |

### Blocking the network

| Option                | For                                       | Against                                                   |
| --------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Playwright route only | Built in; records what was attempted      | Does not cover ICE, DNS or browser background traffic     |
| Route plus DNS rules  | Also stops name lookups outside the stack | Browser-specific flags                                    |
| OS-level (iptables)   | Covers everything                         | Needs root; Linux CI only; also blocks background chatter |

### Matching secrets in captured data

| Option                   | For                                            | Against                                                 |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------- |
| Encode the needle only   | Simple; fast                                   | Misses secrets inside compressed or nested-encoded data |
| Also decode the haystack | Finds secrets under gzip, base64 in JSON, MIME | More code; more CPU                                     |

### Window length for partial matches

A leak may be a truncation of a secret, so the detector matches windows, not only whole values.

| Length   | For                                           | Against                                  |
| -------- | --------------------------------------------- | ---------------------------------------- |
| 8 bytes  | Catches short truncations                     | False positives at nightly data volumes  |
| 12 bytes | Middle ground                                 | Margin thin at nightly volumes           |
| 16 bytes | False positives negligible even at GB volumes | Misses truncations shorter than 16 bytes |

## Decision

### Secret classes and where each may appear

- **C, content**: the plaintext bytes. Allowed nowhere outside the sender's and recipients' browsers.
- **M, metadata**: file name, MIME type, exact byte size N, and recipient labels the sender types in P2P mode.
  - Allowed nowhere, except the receipt exception for the file name.
  - Labels must never appear in `host` or `join` frames.
- **K, keys**: the fragment secret, the full key, every derived key (signaling key, file and chunk keys), and the receipt salt. Allowed nowhere.
  - The ICE pwd is treated as K for the detector. It is not a key we create, but it must never reach coturn, the server or logs in plaintext. The ufrag stays not secret.
- **S, the server key half**: the sender's browser generates it along with the fragment half. Allowed only in four places:
  - the create-transfer request body from the sender's browser;
  - its Postgres column (and that INSERT in the Postgres statement log);
  - the release response to that recipient after their receipt is signed;
  - server memory.

  Never in logs, mail, storage, BankID, the TSA, coturn, signaling, any response to the sender, or any response before signing.

- **Not secret**:
  - link IDs and their 6-character prefixes; transfer IDs; IVs and nonces; ciphertext; `paddedLength`; timestamps; identity data in verified mode;
  - `relay.data` and its length;
  - ICE and SDP transport data (host candidates, mDNS names, ports, ufrag). The server sees client IPs from TCP anyway, and TURN sees endpoints by nature.
  - SDP is still encrypted, to protect the DTLS fingerprint against a hostile signaling server swapping it. That is a tampering test (FID-46), not a leak rule.
  - In P2P mode the recipient sees the sender's local IPs. This is accepted for the POC.
- Link IDs must be generated independently of keys. The detector checks that a link ID shares no 16-byte window with any K value. That catches reuse, but only code review can confirm independent generation.

### Derived-value rule

A value computed from a secret has that secret's class. There are five exceptions:

- (a) AEAD ciphertext under a key no infrastructure holds, including the encrypted name, type and size, and `relay.data`.
- (b) `paddedLength(N)`.
- (c) The receipt commitment `SHA-256(salt ‖ plaintext)`, where the salt is 32 random bytes that only the sender and recipients hold. The salt travels inside the encrypted metadata.
- (d) A MAC under a key derived from the full key.
- (e) Hashes of the signed receipt text or of the BankID signature, which go to the TSA and the audit log. They are not M.

Everything else counts as a secret: plain hashes, fingerprints, key IDs, checksums, truncations. The detector also searches for SHA-256 of C, of the name, and of each K value, as hex and base64. So a plain SHA-256 of the plaintext must never leave the browser. In FID-21 the file checksum in the END and RECEIPT frames travels only over the encrypted data channel, which exception (a) covers.

Consequence: to check a receipt, a verifier needs the file and the salt. The sender's and recipient's evidence copies must carry the salt. FID-6, FID-19 and FID-20 must follow this.

- The receipt download response must not contain the salt.
- Evidence copies that need the salt are assembled in the browser from the decrypted META.
- The receipt download's Content-Disposition filename is generic (for example `receipt-<transferId>.pdf`), never the file name.

### File size: Padmé, testable

- All ciphertext that crosses infrastructure (storage, TURN, P2P chunks) is padded with Padmé rounding, then up to whole chunks: at most about 11% overhead plus one chunk.
- The encrypted META frame (name, type, exact size, salt) is padded to a fixed size, so its ciphertext length reveals neither name length nor type length.
  - The META plaintext is exactly 1024 bytes (`META_PADDED_BYTES`). This bounds the name length in bytes.
  - The browser refuses a file whose name does not fit.
- `paddedLength(n)` comes with FID-21 in `apps/web/src/lib/frames.ts` (Padmé, then whole 48 KiB chunks). It moves into the shared crypto package with the key derivations (see Key capture). FID-7 owns that shared crypto code and may replace the function.
- Assertions:
  - (i) N never appears as a whole numeric token (decimal or hex, bounded by non-digits).
    - Canary sizes N have at least 6 digits and do not fall on a chunk boundary.
    - (i) is skipped for the 0-byte and exact-one-chunk cases. (ii) and (iii) cover them.
  - (ii) Visible sizes (upload `Content-Length`, object size) are a fixed function of `paddedLength(N)`: the padded chunks, their per-chunk IVs, headers and tags, and the fixed-size META. They do not depend on N within a bucket.
  - (iii) Twin test: two files that differ in N (same bucket) and in name length give identical visible sizes.
- coturn byte counts are not asserted.
- The receipt text names the file but not its exact size.

### Where the file name may appear: value-based allowlist

The allowed places:

1. The browser→Fidant sign-start body, in a single field (`receiptText`).
2. Fidant→BankID simulator sign `userVisibleData` (base64 UTF-8).
3. The BankID collect response `completionData.signature`.
4. The one Postgres column that stores the signature, and that INSERT in the statement log.
5. The receipt download response to the sender and to that recipient.
6. The BankID simulator's own logs.

Not allowed: the TSA (it gets hashes only, exception (e)), the audit log (it stores a hash of the signature, exception (e); FID-9 must follow this), mail, storage, coturn, signaling, URLs, headers, server stdout and stderr.

Mechanism:

- The detector collects carrier values from their origin fields (receipt text, its base64, the signature blob).
- It expands each carrier value into every needle encoding, including Postgres bytea hex and the nested base64 inside the signature XML.
- At the listed points only, it masks them with a placeholder, then scans for M as usual.
- A second check fails if a carrier value appears anywhere else.

### Observation points

| Point                                                            | How captured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser HTTP to any host                                         | Playwright `context.on('request'/'response')`: URL including query, `allHeaders()` including Referer, cookies, Content-Disposition, Content-Type and Content-Length. This is the source for URLs, headers and the host allowlist. `postDataBuffer()` can omit Blob, File and streamed bodies, and response bodies can be evicted, so Playwright is not the source for bodies to and from storage.                                                                                                                                                                                                                                                                   |
| Browser↔object storage bodies                                    | Browser uploads and downloads to object storage (presigned or not) go through the recording proxy, which captures bodies byte for byte. If the browser ever uploads to the app server directly, that traffic goes through the proxy too.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Signaling frames                                                 | A `websocket` listener attached to every page through `context.on('page')`, recording `framesent`/`framereceived` and scanning `ws.url()`. The handshake (cookies, Origin, `Sec-WebSocket-Protocol`) is recorded by the recording proxy in front of the app server for the upgrade too (preferred), or by a test-only server-side capture outside the app code. Sockets opened from workers are a known gap for the page listener; the proxy covers them. Plus a shape check against `@fidant/protocol`: only known message types and fields. `relay.data` must be ciphertext: decode one, assert it does not parse as JSON and contains no `v=0` or `a=candidate`. |
| Server stdout                                                    | Strict JSONL with a field allowlist: every line parses as one JSON object, with keys only `event`, `link`, `links`, `bytes`, `reason`, `code`, `port`. Value checks: `event` from the known set; `link` matches `^[A-Za-z0-9_-]{6}$`; `links`, `bytes` and `port` are non-negative integers; `reason` from `LogReason` and `code` from `ErrorCode` in `@fidant/protocol`. New fields or enum values need a reviewed change to the allowlist. The full canary and key scan also runs over stdout.                                                                                                                                                                    |
| Server stderr                                                    | Free text, full canary and key scan. The server logs only to stdout and stderr, never to files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Postgres                                                         | `log_statement=all` in the test instance (catches rows inserted and later deleted), plus `pg_dumpall` after each test and at the end of the run. The log shows bind parameters only in text format, and drivers may send Buffers as binary, so the deliberate-leak self-test writes S through the real driver and asserts that the log or the dump catches it. Dumps use COPY per table, so "only in this column" is checked by masking per table and column.                                                                                                                                                                                                       |
| Server→HTTP dependencies (object storage, BankID simulator, TSA) | A plain-HTTP recording proxy in `apps/e2e` between the server and each dependency, configured through the server's URLs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Object storage at rest                                           | List every object with its metadata and bytes after each test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Mail                                                             | Mailpit (offline binary with an API). Raw source of every message, also decoded (RFC 2047, quoted-printable, base64). Envelope included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| coturn                                                           | `--verbose` logs piped, plus a tcpdump pcap of the relay ports (required on CI Linux, optional on macOS). Data channels are SCTP inside DTLS, so only ciphertext. coturn may see transport addresses and the ICE ufrag; never the ICE pwd in plaintext, K, canary bytes or names.                                                                                                                                                                                                                                                                                                                                                                                   |
| BankID simulator and TSA                                         | The recording proxy plus their own logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Requests outside the local stack                                 | Recorded, then aborted via `context.route` plus `context.routeWebSocket`. Any such request fails the test. ICE does not go through route, so the test decrypts captured `relay.data` with the derived signaling key and asserts no srflx or relay candidates from non-local servers. It also asserts that `iceServers` from `RTCPeerConnection.getConfiguration()` are local only.                                                                                                                                                                                                                                                                                  |

### Encodings and windows

- **Haystack decoding**: content-encoding (gzip, br, deflate, zstd), MIME transfer encodings, JSON string unescaping, and recursive decoding (depth 2) of base64, base64url and hex runs of 24 or more characters. The raw haystack is scanned too.
- **Byte needles (C, K, S)**: raw; hex lower and upper case; base64 and base64url, padded and unpadded, at all 3 alignments; Postgres bytea hex.
- **Text needles (name, type, labels)**: UTF-8 in NFC and NFD; UTF-16LE and UTF-16BE; percent-encoding (upper and lower case, `+` for space); JSON `\u` escapes; base64 and base64url of the UTF-8.
- **Fragment secret**: also the literal 43-character string.
- **Windows**: any 16-byte window of a byte needle: 32 hex characters, or the 20 fully determined base64 characters (120 bits) at any alignment.
- **Text canaries**: names built around a random 16-character base32 token (80 bits), for example `fidant-<token>-räksmörgås.<rand3>`. A match is any 12-character substring of the token. MIME type `application/x-fidant-<token>`.
- **Canary content**: random bytes from a seeded CSPRNG, with the seed logged.
- **False positives**: about H·W·2^-120 for bytes (the base64 window is the weakest), where H is haystack bytes and W is needle windows. That is about 2^-54 even nightly, with H and W around 2^33, and still negligible. About 2^-60 per position for names.
- **Failure report**: observation point, offset, encoding, and ±64 bytes of context.
- **Indexing cost**: the PR suite indexes every window, with files of 4 MiB or less. Nightly 1 GB and 5 GB files index every window in the first and last MiB, plus one full MiB at every 64 MiB offset.

### Key capture

- Tests read the fragment secret from the link URLs they hold.
- Derived keys are computed by importing the app's own derivation functions and applying them to the secret.
- The full verified key comes from the fragment half plus the server half read from the captured release response.
- No test endpoint, no build flag, no debug global.
- Where the derivations live:
  - FID-21 puts them in `apps/web/src/lib/keys.ts`, next to the frames and `paddedLength`. Until the harness exists, the interim test imports them from `apps/web` directly.
  - When the harness becomes their second consumer, in FID-41 at the latest, key derivations, frames and base64url move into a workspace package (for example `@fidant/crypto`). `@fidant/protocol` stays the home of message types and enums only.
- Fallback, rejected for now: a test-only init-script hook on `crypto.subtle`, if a key ever has no importable derivation.

### Suite shape

- **Package**: `apps/e2e` (`@fidant/e2e`).
  - `src/leaks/`: the pure detector. `src/stack/`: service startup and the recording proxy. `tests/*.spec.ts`: the specs.
  - The directory is `tests/` so `node --test`'s default globs skip the specs.
  - Depends on `@fidant/protocol` and, from FID-41, the crypto package.
- **Commands**:
  - Root `pnpm e2e` runs the build, then `pnpm --filter @fidant/e2e e2e`. It is explicitly filtered. Never `pnpm -r run e2e`, which would also run the interim test in `apps/web`.
  - `pnpm e2e:nightly` runs all browser projects plus `@nightly` tests.
- **`pnpm check`** does not run e2e. It does run the detector's pure `node:test` unit tests.
- **CI**: a new parallel job `e2e` on `pull_request` and on push to `main`.
  - Installs Chromium with deps (cached, keyed on the Playwright version) and runs `pnpm e2e`.
  - Uploads traces and `observations/` when a test fails.
  - Becomes a required check once stable.
  - Coexists with `first-demo-e2e` until FID-41.
  - The nightly workflow `.github/workflows/nightly.yml` (cron plus `workflow_dispatch`) is owned by FID-47.
- **Playwright version**: one exact version in a pnpm catalog in `pnpm-workspace.yaml`, used by `apps/web` and `apps/e2e`.
- **Stack startup**:
  - Playwright `globalSetup` starts the stack (not `webServer`).
  - The server starts with `PORT=0`; the harness reads the port from `{"event":"listening","port":N}`.
  - A `CERT_DIR` env var points the server at a per-run temporary certificate. `main.ts` hardcodes `.certs/` today; FID-39 adds the env var.
  - `workers: 1` until per-worker clean state exists.
- **Detector**: a Playwright auto fixture asserts at teardown with that test's canaries. A run-level sweep checks every canary against the final dumps and logs.
- **Every PR**:
  - Chromium only.
  - Small files: 0 bytes, one chunk, a few MiB, a same-bucket twin pair.
  - Detector on in every flow test, plus the deliberate-leak self-test.
  - Route-level egress record and block.
  - coturn pcap where a TURN test exists.
  - Target under 5 minutes.
- **Nightly**:
  - Firefox and WebKit projects, with `test.fixme` per project and a reason for known failures.
  - 1 GB and 5 GB files, checking memory and checksum.
  - An egress block, applied after install. The stack and browsers run as a dedicated user. iptables OUTPUT rules with `-m owner --uid-owner` for that user allow loopback only, and LOG then REJECT everything else. The job fails if the LOG counter is non-zero. The runner's own connection is unaffected. Background browser chatter is not counted as an app leak.
  - Real Safari stays a manual check.
- **Certificate trust**: `ignoreHTTPSErrors` per context (`isSecureContext` stays true). If FID-7 picks a service worker for streaming downloads, switch to SPKI or CA trust, because Chromium blocks service workers on certificate errors.
- **Browser launch options**, test-only:
  - Chromium: `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost` and `--disable-features=WebRtcHideLocalIpsWithMdns`. No inner quotes: Playwright passes args without a shell.
  - Firefox: `media.peerconnection.ice.obfuscate_host_addresses=false`.

## Consequences

- **App conventions**:
  - Server stdout is JSONL with the field allowlist; human text goes to stderr.
  - Key derivations, frames (including `paddedLength`) and base64url move from `apps/web` into a workspace package (for example `@fidant/crypto`) when the harness becomes their second consumer, in FID-41 at the latest.
  - Padmé padding on everything that crosses infrastructure.
  - A fixed-size META frame (1024 bytes of plaintext); the browser refuses names that do not fit.
  - The receipt signs a salted hash; no plain hash of the plaintext leaves the browser.
  - A single `receiptText` field.
  - The audit log stores a hash of the signature, not the signature.
  - The `CERT_DIR` env var.
- **Issues that must follow this record**: FID-6, FID-7, FID-9, FID-19, FID-20, FID-21, FID-39 to FID-47.
- **Out of scope**:
  - What the browser stores locally, observers on the local network, and a malicious served web app (FID-35).
  - Timing: transfer duration and frame timing reveal approximate size to the server and TURN. Accepted for the POC.
- **Cost**: the coturn pcap needs sudo on CI.
