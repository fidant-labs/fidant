# Split-key encryption spike (SIG-7)

Throwaway code that answers the questions in SIG-7: can a browser encrypt and
decrypt multi-gigabyte files in chunks under a key split between the link
fragment and the server, and how does it save the result to disk in each
browser. Nothing here ships. The findings and the recommended format go into
the issue, and production code gets written fresh in `packages/` or `apps/web`.

The key split:

- `F`, the fragment half (32 bytes), travels in the link after `#`.
- `S`, the server half (32 bytes), is generated in the sender's browser, held
  by the server, and released only after the receipt is signed.
- `metaKey = HKDF-SHA256(F, salt = transferId, info "sigill/v2/meta")`
- `contentKey = HKDF-SHA256(F ‖ S, salt = transferId, info "sigill/v2/content")`

## Tests

```sh
pnpm --filter @sigill/spike-split-key test
```

`pnpm check` at the root lints, typechecks and tests this package too.

## Bench

```sh
pnpm --filter @sigill/spike-split-key bench
```

This builds the bench page into `dist/` and serves it:

- `http://127.0.0.1:8450/` on this machine. Loopback HTTP is a secure context
  in every browser, so no certificate is involved.
- `https://<LAN address>:8451/` for phones and other laptops, with the same
  self-signed certificate as `pnpm start` (from `CERT_DIR`, or `.certs/` at the
  repository root, created on first use). Accept the warning once.

`BENCH_PORT` and `BENCH_HTTPS_PORT` change the ports. The server prints the
addresses, logs nothing per request, and sends every response with COOP and
COEP so the page is cross-origin isolated.

On the page, "Run microbenchmarks" pushes the chosen amount of seeded data
(256 MiB by default) through each stage in a dedicated worker:

| Stage             | What it measures                                            |
| ----------------- | ----------------------------------------------------------- |
| `generator`       | the seeded test-data generator, 1 MiB at a time             |
| `sha256-js`       | the app's JavaScript SHA-256 (`apps/web/src/lib/sha256.ts`) |
| `aes-gcm-encrypt` | `StreamWriter.encrypt` per chunk, at each chosen chunk size |
| `aes-gcm-decrypt` | `StreamReader.decrypt` per chunk, at each chosen chunk size |

MB/s is 10^6 bytes per second of stage time. "Copy JSON" copies the full
report: the results and the environment block (user agent, core count, device
memory, cross-origin isolation, `storage.estimate()`, and which memory and file
APIs exist). The report has no keys, file names or file content; keys are
random per run and never leave the worker.

### Service worker sink

The `sw` sink streams decrypted plaintext from the bench worker through the
page into a service worker (`src/bench/sw.ts`, built to `/sw.js`), which
answers a hidden iframe's navigation to `/spike-dl/<random id>` with an
attachment response. The download never touches the network, and its name
(`bench-output.bin`) is set in the browser. The run's JSON records
`delivery: "sw-stream"` and `swTransport`: `transferable-stream` where the
engine can transfer a `ReadableStream` with `postMessage`, otherwise
`message-port` (one chunk per pull over a `MessagePort`).

Service workers need a secure context. `http://127.0.0.1` is one. On the LAN
address the certificate must be trusted: Chromium and Safari refuse to
register a service worker on a page whose certificate error was clicked
through, so with the self-signed certificate the sink reports "unsupported".
The e2e harness (`apps/e2e`) currently sets `serviceWorkers: "block"`, so a
service worker download in the app would need that changed, and the
recorder may not see requests a service worker answers.
