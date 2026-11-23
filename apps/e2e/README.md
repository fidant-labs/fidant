# @sigill/e2e

End-to-end tests on the local stack, with a leak detector that checks every test. The rules it enforces are in [docs/decisions/0001](../../docs/decisions/0001-e2e-tests-and-leak-model.md).

## Running

```sh
pnpm --filter @sigill/e2e exec playwright install chromium  # once per machine
pnpm e2e                                                    # from the repository root
```

`pnpm e2e` builds the web client, starts the server on a free port, runs the specs in `tests/` and stops the server. `pnpm check` does not run it.

## Writing a test

Import `test` and `expect` from `src/fixtures.ts`, not from `@playwright/test`.

- The default `page` and `context` are recorded as the actor `default`. For more browsers, call `actor("sender")`, `actor("recipient")` and so on. Each gets its own context and page and its own observations file. Do not call `browser.newContext()`: an unrecorded context fails the test.
- `canary` gives random bytes from the run seed and the test's title. Fork it per canary: `canaryFile(canary.fork("file"))`, `canaryKey(canary.fork("key"))`.
- `leaks.watch(file, label?)` registers a canary file and returns it: its bytes and their SHA-256, the tokens in its name and type, the SHA-256 of its name, and its size. `leaks.watchKey(label, key)` registers a key, as bytes or as text such as a fragment secret.
- After the test, the detector scans what the test observed for every secret it registered and fails the test on any finding. `leaks.scan()` returns the findings so far without failing, and `leaks.check()` returns the report the teardown would throw (undefined when clean). A test that leaks on purpose calls `leaks.expectLeaks()`. `tests/leaks.spec.ts` shows each kind of leak the detector catches.
- Once all tests are done, a run-level sweep scans every observation against every secret of the run, so a leak that shows up in another test's traffic or a later log line still fails the run.

Requests outside the stack are aborted and fail the test.

## What is scanned

Today:

- Browser requests and responses: URL, every header and request bodies.
- WebSocket frames, sent and received, including `/signal`.
- Server stdout and stderr. Stdout must also pass a strict allowlist: one JSON object per line, with known keys and values only (`src/leaks/server-log.ts`).

Every capture is decoded into views (percent, JSON escapes, base64, hex, gzip and others, nested) before matching, so encoded leaks are caught too.

Not wired yet. Each arrives with the first issue that needs the service:

| Observation point                            | Issue          |
| -------------------------------------------- | -------------- |
| Postgres statement log and dumps             | SIG-42         |
| BankID simulator and TSA, through the proxy  | SIG-42         |
| File-name carriers (`src/leaks/carriers.ts`) | SIG-42, SIG-43 |
| Object storage and mail (Mailpit)            | SIG-43         |
| coturn logs and packet capture               | SIG-44         |

## Adding an observation point

Turn what the point saw into `Capture`s (`src/leaks/scan.ts`): a `point` naming where it was seen, such as `observations/run/mail.eml:3`, and the `bytes`. Add a `contentEncoding` hint if the bytes are compressed. Write the raw data under `observations/`, then add the captures to the per-test scan in `src/leak-watch.ts` and to the sweep in `src/sweep.ts`. `src/leaks/captures.ts` does this for browser records and logs.

## Reproducing a failure

The run prints its seed first:

```
Canary seed: 9d46…d665 (set SIGILL_E2E_SEED to replay it)
```

A failure repeats the seed. Run `SIGILL_E2E_SEED=<seed> pnpm e2e` to get the same canaries.

## Findings are public

A finding prints up to 64 bytes around the match, and `observations/` is uploaded by CI. Both are public. That is acceptable only because canaries and canary keys are throwaway test values. Never watch real data, real keys or anything else secret.
