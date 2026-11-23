# Split-key encryption spike (SIG-7)

Throwaway code that answers the questions in SIG-7: can a browser encrypt and
decrypt multi-gigabyte files in chunks under a key split between the link
fragment and the server, and how does it save the result to disk in each
browser. Nothing here ships. The findings and the recommended format go into
the issue, and production code gets written fresh in `packages/` or `apps/web`.

Results, answers and recommendations: [findings.md](findings.md).

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

### Runner

```sh
pnpm --filter @sigill/spike-split-key bench:run
pnpm --filter @sigill/spike-split-key bench:run --engines webkit --sizes 1GiB,5GiB
```

`src/runner/run.ts` builds the page, serves it with `serve.ts` on free
`127.0.0.1` ports and drives it in Chromium, Firefox and WebKit through
Playwright, headless. Install the two extra engines once, with the
repository's Playwright version:

```sh
pnpm --filter @sigill/e2e exec playwright install firefox webkit
```

Per engine it launches a fresh browser with a new persistent profile under
`.runs/` (WebKit has no OPFS in Playwright's ephemeral contexts:
`getDirectory()` fails with `UnknownError`), runs the microbenchmarks once, then every size × sink × chunk size of the pipeline from
the seeded generator. For each run it:

- samples the browser's resident memory every 250 ms (`src/runner/rss.ts`),
- waits for the page's download of `bench-output.bin` and checks its size and
  SHA-256 against Node regenerating the same seeded stream
  (`src/runner/verify.ts`),
- deletes the download and clicks "Clear OPFS".

| Flag         | Default                   | Values                                          |
| ------------ | ------------------------- | ----------------------------------------------- |
| `--engines`  | `chromium,firefox,webkit` |                                                 |
| `--sizes`    | `64MiB`                   | presets `64MiB,1GiB,5GiB` or any whole MiB      |
| `--sinks`    | `opfs,fsa-opfs,blob,sw`   | `fsa` needs a save picker; `fsa-opfs` stands in |
| `--chunks`   | `256KiB,1MiB`             | `48KiB,256KiB,1MiB,4MiB`                        |
| `--seed`     | `1`                       |                                                 |
| `--micro`    | `256MiB`                  | bytes per microbenchmark stage, `0` skips       |
| `--out`      | `results/`                | where `<YYYY-MM-DD>-<engine>.json` goes         |
| `--runs-dir` | `.runs/`                  | profiles and downloads, removed as it goes      |
| `--headed`   | off                       | show the browser windows                        |
| `--no-build` | off                       | serve the existing `dist/`                      |

A run may take a minute plus half a second per MiB before the runner gives up
on it, so 5 GiB runs (only with `--sizes`) allow about 45 minutes each. They
need about twice the file size free on disk: the ciphertext in OPFS and the
download.

The results file is rewritten after every run, so an interrupted grid keeps
what it measured. Per run it holds the page's record (phases, MB/s, storage,
delivery, error), whether the download matched, and the RSS window: summed RSS
just before the click and the peak until the download finished. An outcome of
`mismatch` means the page reported success but the file was wrong;
`runner-error` means the runner timed out or no download came.

Which processes count as the browser: descendants of the runner (outside the
bench server), plus processes that launchd started from the engine's build in
Playwright's cache. The second rule is for WebKit on macOS, whose WebContent,
Networking and GPU processes are XPC services with parent pid 1, not
descendants of the runner. Another Playwright WebKit running at the same time
would be counted too. Summed RSS counts shared pages once per process, so it
overstates the footprint; compare a run's peak with its baseline.

## Fragment handoff check

`/handoff.html` on the bench server checks whether a link fragment survives
the channels people send links through. It makes a probe link with a dummy F
(random per link, never a real key):

```text
<origin>/handoff.html?probe=1#k=<43 chars of F>.<8 chars of check>
```

The check is the first 6 bytes of SHA-256(F) in base64url, so the landing page
can verify F without knowing it in advance. `probe=1` marks a landing even when
the fragment is lost and shows whether the query was rewritten. Share (where
the browser has `navigator.share`), Email (`mailto:`) and Copy send the link.
Open the page on the LAN address (`https://<LAN address>:8451/handoff.html`)
so the receiving device can reach it.

Opening a probe link reports one verdict:

| Verdict     | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `intact`    | the fragment arrived exactly, or percent-encoded and decoded once        |
| `trailing`  | F and the check verify, but characters follow (an autolinker's `)`, `.`) |
| `truncated` | a clean prefix of the fragment arrived                                   |
| `altered`   | wrong prefix, separator or characters, or the check does not match F     |
| `missing`   | no fragment, or one without `k=`                                         |

It also shows which part failed (prefix, length, charset, check), the length
that arrived, whether it was percent-encoded, whether the path or query
changed (for example by a link scanner such as Outlook Safe Links), and
whether the fragment was moved into the query. It shows lengths only, never
the fragment text. After reading the fragment it removes it from the address
bar with `history.replaceState`, as the real receive page should. "Check a
pasted link" runs the same check on a link copied out of a message, for
channels whose links cannot reach the bench server. The page sends nothing
and logs nothing.

Percent-encoded fragments are accepted after one `decodeURIComponent`: F and
the check use only base64url characters, so decoding cannot make two
different fragments equal.

### Results (human runs)

Send a fresh link per row. Open it on the receiving device by tapping or
clicking it in the channel, not by copying it into a browser, unless the row
says so.

| Channel                         | Sender → receiver | Verdict | Path/query changed | Notes |
| ------------------------------- | ----------------- | ------- | ------------------ | ----- |
| Gmail web → Gmail web           |                   |         |                    |       |
| Outlook (Safe Links on)         |                   |         |                    |       |
| Outlook (Safe Links off)        |                   |         |                    |       |
| Apple Mail (macOS, iOS)         |                   |         |                    |       |
| iMessage                        |                   |         |                    |       |
| WhatsApp                        |                   |         |                    |       |
| Signal                          |                   |         |                    |       |
| Slack                           |                   |         |                    |       |
| Microsoft Teams                 |                   |         |                    |       |
| SMS (Android)                   |                   |         |                    |       |
| Link at the end of a sentence   |                   |         |                    |       |
| Link in parentheses             |                   |         |                    |       |
| Copy and paste into the browser |                   |         |                    |       |
