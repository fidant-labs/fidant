# 0001: End-to-end tests and leak model

Status: Proposed
Date: 2026-11-23
Linear: SIG-38

## Context

### The invariant

AGENTS.md says: never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them. The one deliberate exception: the BankID receipt text names the file. Keys live only in the URL fragment or in browser memory.

The invariant is easy to state and easy to break by accident: a log line, a debug header, a hash sent "for convenience". End-to-end tests should catch such breaks. To do that they need a concrete definition of a leak and a way to observe everything that leaves the browser.

### Split key for verified transfers

In a verified transfer the key is split in two:

- one half travels in the link's URL fragment;
- the other half is held by the server and released to a recipient only after their BankID receipt is signed.

The server half is therefore a secret the server may hold, but only in specific places.

### The local stack

The project must run fully local. The stack the tests will run against:

| Service                   | Role                                          |
| ------------------------- | --------------------------------------------- |
| App server                | Serves the web client, signaling, API         |
| Postgres                  | Transfers, server key halves, receipts, audit |
| Object storage            | Encrypted files for stored transfers          |
| Mail catcher              | Links and notifications sent by mail          |
| coturn                    | TURN relay for peer-to-peer transfers         |
| BankID simulator          | Identity and signing                          |
| Local timestamp authority | Timestamps on receipts and the audit log      |

Most of these do not exist yet. This record covers them ahead of time so each feature adds its observation point when it adds the service.

### What exists today

- One Node process (`apps/server`) serves the built web client over HTTPS.
- It generates a self-signed certificate in `.certs/`. The path is hardcoded in `main.ts`.
- Every response sets `referrer-policy: no-referrer` and a CSP with `default-src 'self'`.
- The server prints human-readable startup text to stdout.

### What SIG-21 brings

SIG-21 is in progress on another branch. It adds:

- WebSocket signaling at `wss://<host>/signal`, with message types in `packages/protocol` (`@sigill/protocol`).
- Client messages: `host`, `join`, `relay`, `refuse`. Server messages: `joined`, `left`, `relay`, `refused`, `host-gone`, `error`.
- Link IDs: 22 characters of base64url.
- Recipient links: `/r/<linkId>#<secret>`, where the secret is 43 characters of base64url (32 bytes).
- `relay.data` is `base64url(iv ‖ AES-GCM(SDP/ICE JSON))`, under a key derived from the fragment secret.
- Server stdout is strictly one JSON object per line:
  - events: `listening`, `upgrade-rejected`, `bad-message`, `error`, `host`, `host-gone`, `host-closed`, `joined`, `refused`, `relay`, `relay-dropped`, `left`;
  - fields: `event`, `link` (first 6 characters only), `links`, `bytes`, `reason`, `code`, `port`;
  - human text goes to stderr.
- `@sigill/protocol` exports the enums the log check needs: `ErrorCode` (`bad-message`, `wrong-role`, `already-hosted`, `already-joined`, `not-on-link`) and `LogReason` (`RefuseReason` plus `"path"` and `"origin"`).
- File transfer frames in `apps/web/src/lib/frames.ts`:
  - `paddedLength(n)` applies Padmé, then rounds up to whole 48 KiB chunks. Every CHUNK frame is full size.
  - The exact size travels only inside the encrypted META frame.
  - The file checksum (END and RECEIPT frames) travels only over the encrypted data channel, never through signaling.
  - SIG-7 may replace `paddedLength` later.
- Key derivations live in `apps/web/src/lib/keys.ts`, not in a workspace package. AGENTS.md says to create a package only once a second consumer exists.
- An interim Playwright test in `apps/web/e2e/`, run by the CI job `first-demo-e2e`. SIG-41 later moves it onto the harness this record describes.

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

SIG-21 chose encrypted.

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
| Padmé                | Leaks O(log log N) bits; at most about 12% overhead | Slightly more code                                 |

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

Pending.

## Consequences

Pending.
