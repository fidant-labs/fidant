# 0027: Large files and a loopback-only user in the nightly

- Status: Accepted
- Date: 2026-11-26
- Linear: SIG-47

This record amends 0001 (`0001-e2e-tests-and-leak-model.md`). Read 0001 with the replacements under Decision.

## Context

- 0001's "Nightly" asks for 1 GB and 5 GB files, checking memory and checksum, and an egress block: the stack and browsers run as a dedicated user, iptables lets that user reach loopback only, and the job fails if the LOG counter is non-zero. Its "Commands" names `pnpm e2e:nightly`, for all browser projects plus `@nightly` tests.
- Since SIG-268, `.github/workflows/nightly.yml` runs the suite in Firefox and WebKit, one job per engine, chosen with `SIGILL_E2E_BROWSER`. It had no large files and no egress block.
- The recipient page saves a file through `createSink` in `apps/web/src/lib/sink.ts`. Where the browser has `showSaveFilePicker`, which only Chromium has, `FileSystemSink` streams the file to the file the user picks. Everywhere else, `BlobSink` collects it in memory and the page downloads one Blob at the end. The transfer specs delete `showSaveFilePicker`, so the file arrives as a download through `BlobSink`, except in the few that stub the dialog.
- Playwright's headless Chromium runs off the record, so its Blobs are not paged to disk, and its Blob memory is capped at 2 GiB. This was read in Chromium's source during planning, not measured. A 5 GB file can't fit in `BlobSink` there, and a sink that holds the whole file can't show that memory stays bounded.
- A GitHub-hosted `ubuntu-latest` runner for a public repository has 4 vCPUs, 16 GB of memory and a 14 GB SSD. On a 16-core Mac, the 1 GB and 5 GB transfers took about 7 minutes together. On a runner they are not measured yet.
- The runner resolves names through systemd-resolved's stub at 127.0.0.53. The stub forwards each lookup off the machine as its own user, so a rule that matches the test user's packets sees the lookup only on loopback.
- 0001's "Indexing cost" says the pull request suite sends files of 4 MiB or less. It sends 6 MiB and 8 MiB files too (`tests/first-demo.spec.ts`), and indexes every window of them.

## Options considered

### The recipient's sink for large files

1. **`BlobSink`, as the transfer specs use.** Out of reach for 5 GB in headless Chromium, and it holds the file, so memory grows with it by design.
2. **A save dialog stub that counts bytes.** `fakeSavePicker` in `apps/e2e/src/fixtures.ts` replaces `showSaveFilePicker` through an init script. The app takes its `FileSystemSink` path, as a Chromium user's page does, and every write adds its byte count to `globalThis.written` and keeps nothing. Memory then shows what the page itself holds.

### The memory metric

1. **The page's JavaScript heap.** It misses what the browser holds outside V8: Blob storage, data channel buffers, the GPU and network processes.
2. **The summed RSS of the browser's processes.** Every process the Playwright worker started, sampled once a second (`apps/e2e/src/rss.ts`). It sees all of it, with noise from everything else the browser does.

### Name lookups on loopback

1. **Allow them with the rest of loopback.** Every lookup the stub forwards would leave unseen.
2. **Block and count them.** Any lookup to a loopback port 53 is logged and refused before loopback is allowed. The local stack needs none: its addresses are IP literals and `localhost`.

### How the nightly picks what to run

1. **`pnpm e2e:nightly`, as 0001 planned.** A root script for all engines in one invocation, which the suite can't do: the server respawned after the restart tests keeps its warm-up window, which the next engine's early tests would hit.
2. **Environment variables.** `SIGILL_E2E_BROWSER` already picks one engine per job, and `SIGILL_E2E_LARGE=1` turns the large files on. No new root script.

### Where a failed night is reported

1. **A Linear issue.** CI would need a stored Linear API key.
2. **A GitHub issue per failed run.** Through the workflow's own token, but each night adds an issue.
3. **One open GitHub issue, a comment per failed run.** Through the workflow's own token, and every failure since the last fix sits in one thread.

## Decision

Option 2 for the sink, option 2 for memory, option 2 for lookups, option 2 for picking what runs, and option 3 for reporting.

### Large files

- `apps/e2e/tests/large-files.spec.ts` sends a 1 GB and a 5 GB canary, each up to 10 MB larger, in Chromium only, and only with `SIGILL_E2E_LARGE=1`. It skips otherwise.
- The sender's canary is written to `os.tmpdir()` a MiB at a time (`writeLargeCanary` in `apps/e2e/src/leaks/canary.ts`) and chosen by its path, so Node never holds the file.
- The recipient saves into `fakeSavePicker`. The test passes only if the stub took exactly the file's size, the recipient page says it is exactly the file that was sent, both pages show the SHA-256 that Node computed while writing the file, and the sender's page says it was delivered.
- Memory: the summed RSS of the browser's processes, sampled once a second from just before Download until the page confirms the file. Its peak must stay less than 1 GiB above the first sample. A later pull request tightens the bound from the peaks of the first 7 nights.
- Chromium only: Firefox and Safari users get `BlobSink`, so a run with the stub there would test a path their users never take.
- The leak check searches a large file's sampled bytes. `largeFileSamples` in `canary.ts` takes the first and last MiB and one MiB at every multiple of 64 MiB, cut at the end of the file, joining samples that overlap or touch. Each sample is a content needle of its own, labelled with its offset, so the check finds any 16-byte window inside a sample, and no window that spans two. The SHA-256 of the whole file is a needle too. That is 16 MiB of the 1 GB file and 76 MiB of the 5 GB one, at 9.4–13.3 bytes of index per sampled byte, measured during planning: about 1 GiB of index for the 5 GB file.
- The tests' timeouts are 4 and 16 minutes, and the Chromium job's is 45. Each test logs its rate in MB/s and its RSS before and at peak.
- The job prints `df -h` and `free -m` before the tests, and the Chromium job fails before them if `/tmp` has less than 8 GB free. The 1 GB canary is deleted before the 5 GB one is written.

### The loopback-only user

- All three jobs, Chromium (which runs the large files), Firefox and WebKit, build as `runner` and run the suite as `sigill-e2e`, a user the job creates. It gets execute on the directories down to the checkout, write on `apps/e2e` itself (global setup replaces `observations/`, and Playwright writes `test-results/` and `playwright-report/`), and nothing else. The browsers are installed in `/opt/ms-playwright`, outside the runner's home.
- Playwright runs from `apps/e2e/node_modules/.bin`, not through pnpm, whose update check would reach the registry. It gets only `PATH`, `HOME`, `LANG`, `CI`, `PLAYWRIGHT_BROWSERS_PATH`, `SIGILL_E2E_BROWSER` and `SIGILL_E2E_LARGE`. Global setup starts coturn, Mailpit and the server as that user, as `pnpm e2e` does.
- In both `iptables` and `ip6tables`, a chain `sigill-egress` logs each packet with `--log-uid` and the prefix `sigill-egress: `, then rejects it. Four rules at the top of OUTPUT match `-m owner --uid-owner sigill-e2e`: udp to port 53 on `lo` and tcp to port 53 on `lo` go to the chain, the rest of `lo` is accepted, and everything else goes to the chain. Linux sends packets to the machine's own addresses through `lo`, so ICE host candidates on the runner's own addresses stay allowed.
- Before the tests, three checks run as the user. Each must fail and raise the chain's LOG count: `curl http://1.1.1.1/`, `getent hosts example.com` and `curl 'http://[::1]:53/'`. Then the counters are zeroed.
- After the tests, the job prints both chains and the kernel's `sigill-egress: ` lines since the counters were zeroed, and fails if the LOG count is above 0. Every packet counts, a browser's background traffic included. Such a packet is not a finding of the leak detector; the runbook says how to tell what sent it.
- The block and its checks are inline in `nightly.yml`, a path that needs a `maintainers` approval. A script under `apps/e2e` that runs with sudo would not.
- The owner match sees IP packets only. Traffic that the user hands to a daemon running as another user leaves unseen when it goes through a UNIX socket or D-Bus. Lookups sent to the stub on port 53 are the one such path the rules count.

### A failed night

- A job `report`, which runs when a job of the night failed and the run is not for a pull request, comments on the open issue titled "Nightly failed" that the Actions bot opened. If there is none, it opens one. The comment names the run's URL, its branch and each job that did not succeed. The job has `issues: write` and `actions: read`, which reading the run's jobs needs; the workflow keeps `contents: read`.
- Whoever fixes the failure closes the issue. The next failed night then opens a new one.

### Replacements to 0001

- "Nightly": "Firefox and WebKit projects" reads "Chromium, Firefox and WebKit, one job per engine". "1 GB and 5 GB files, checking memory and checksum" reads "1 GB and 5 GB files in Chromium only, as under Large files above". "iptables OUTPUT rules" reads "iptables and ip6tables OUTPUT rules, as under The loopback-only user above". "Background browser chatter is not counted as an app leak" reads "Background browser traffic fails the night like any other packet, and is not a finding of the leak detector".
- "Commands": there is no `pnpm e2e:nightly` and no `@nightly` tag. `.github/workflows/nightly.yml` sets `SIGILL_E2E_BROWSER` per job and `SIGILL_E2E_LARGE=1` in the Chromium job.
- "Indexing cost": "with files of 4 MiB or less" reads "with files of a few MiB, 8 MiB at most today". The nightly's sampled bytes are as under Large files above.

## Consequences

- A night is red whenever anything the test user runs tries to leave loopback or look a name up. The first nights show what each engine sends. WebKit names its host candidates by mDNS, so a page that looks its peer's `.local` name up through the system resolver would hit the port 53 rule. No browser flag is added only to quiet the block: a flag goes in once a night shows the packet and the packet is understood.
- The Chromium suite runs on every pull request without the block, and each night under it.
- `pnpm e2e` and the pull request jobs have no egress block. The table in `apps/e2e/README.md` still describes them.
- The large files run only where `SIGILL_E2E_LARGE=1` is set. A pull request that changes the transfer code gets them only from the next night, or from a run dispatched by hand.
- Memory and rate on a runner are measured from the first nights, and SIG-47 gets the results.

## Runbook

### Dispatch the nightly by hand

A run on a branch cancels a run in progress on the same branch, so this cancels a running scheduled night on `main`.

```sh
gh workflow run nightly.yml --ref main
gh run list --workflow nightly.yml --event workflow_dispatch --limit 1 --json databaseId,headBranch,status,createdAt --jq '.[0] | [.databaseId, .headBranch, .status, .createdAt] | @tsv'
```

The second command prints the run's ID, `main`, its status and when it was created, separated by tabs. If that time is before the first command ran, the new run isn't listed yet: run the second command again. Once the status is `completed`, `gh run view <ID> --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'` must print `e2e (chromium)`, `e2e (firefox)` and `e2e (webkit)`, each with a tab and `success`, and `report` with a tab and `skipped`. Any other output means the night failed. A dispatched run that fails comments on the "Nightly failed" issue like a scheduled one.

### Read the block's output

- In each job's log, the step "Let the test user reach loopback only" prints the OUTPUT rules, `/etc/resolv.conf` and the `hosts:` line of `/etc/nsswitch.conf`. If a check fails, the step ends with `The test user ran <command> past the block` or `The block did not log <command>`, and the suite doesn't run.
- The step "Count what the test user sent off loopback" prints both chains with their counters, then the kernel's lines since the counters were zeroed. A clean night prints `0` in the `pkts` column of both `LOG` rows and no `sigill-egress: ` line, and the step passes. Otherwise the step ends with `The test user sent <N> packets off loopback or to a resolver`.
- Each kernel line reads `sigill-egress: IN= OUT=<interface> SRC=<address> DST=<address> ... PROTO=<protocol> SPT=<port> DPT=<port> ... UID=<uid> GID=<gid>`. `OUT=lo` with `DPT=53` is a name lookup; the line doesn't hold the name. Any other `OUT=` is a packet that would have left the machine, to `DST` on `DPT`: `DST=224.0.0.251 DPT=5353` is mDNS, and `DST=239.255.255.250 DPT=1900` is SSDP. The line's time, against the timestamps of the step "Run the suite as the test user" (Show timestamps in the log's settings), tells which test was running.
