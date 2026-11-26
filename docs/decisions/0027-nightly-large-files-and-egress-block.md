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
2. **Block and count them.** Any lookup to a loopback port 53 is logged and refused before loopback is allowed. The local stack needs none: its addresses are IP literals and `localhost`. Before the block goes up, the job maps the machine's own names to 127.0.1.1 in `/etc/hosts`, the Debian and Ubuntu default, wherever the runner image left them out: something that starts with the suite looks the machine's full name up, and on such an image the lookup reached the resolver (run 45872122005, four lookups of a 28-character name, `ip-10-0-135-138.ec2.internal`, on the Firefox leg). Every other name still goes to the resolver and counts. A lookup fails the Chromium and Firefox legs. The WebKit leg prints how many it refused and fails only on packets that leave loopback, because WebKit looks up the other peer's mDNS host candidate names through the resolver when the machine has no mDNS (see Consequences).

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
- The sender's canary is written to `os.tmpdir()` a MiB at a time (`writeLargeCanary` in `apps/e2e/src/leaks/canary.ts`) and chosen by its path, so Node never holds the file. A file chosen by its path gets its MIME type from its extension, so a large canary carries no MIME type the leak check could find: its `mime` token never reaches the browser.
- The recipient saves into `fakeSavePicker`. The test passes only if the stub took exactly the file's size, the recipient page says it is exactly the file that was sent, both pages show the SHA-256 that Node computed while writing the file, and the sender's page says it was delivered.
- Memory: the summed RSS of the browser's processes, sampled once a second from just before Download until the page confirms the file. Its peak may rise above the first sample by less than a bound set in `apps/e2e/tests/large-files.spec.ts`, 1 GiB to start with. After the first 7 nights, a pull request tightens it there from their peaks. The bound is a value to tune, and changing it needs no new record.
- Chromium only: Firefox and Safari users get `BlobSink`, so a run with the stub there would test a path their users never take.
- The leak check searches a large file's sampled bytes. `largeFileSamples` in `canary.ts` takes the first and last MiB and one MiB at every multiple of 64 MiB, cut at the end of the file, joining samples that overlap or touch. Each sample is a content needle of its own, labelled with its offset, so the check finds any 16-byte window inside a sample, and no window that spans two. The SHA-256 of the whole file is a needle too. That is 16 MiB of the 1 GB file and 76 MiB of the 5 GB one, at 9.4–13.3 bytes of index per sampled byte, measured during planning: about 1 GiB of index for the 5 GB file. Global teardown's sweep indexes both files' samples together with every other test's secrets, so it needs about 0.9–1.2 GiB for these two files alone.
- The tests' timeouts are 8 and 24 minutes, and the Chromium job's is 45. Within a test, the two slow waits, for the sender's page to show the SHA-256 and for the recipient's page to confirm the file, get 2 minutes per GB each, and the test's timeout caps them together. Each test logs its rate in MB/s and its RSS before and at peak. On the pull request's first run (run 45869245893, a 4-vCPU `ubuntu-latest`), both files moved at 16.6 MB/s: the 1 GB test took 2.1 minutes with 111 MB of RSS growth, the 5 GB test 10.1 minutes with 188 MB, and the Chromium job 18 minutes.
- The job prints `df -h` and `free -m` before the tests, and the Chromium job fails before them if `/tmp` has less than 8 GB free. The 1 GB canary is deleted before the 5 GB one is written.

### The loopback-only user

- All three jobs, Chromium (which runs the large files), Firefox and WebKit, build as `runner` and run the suite as `sigill-e2e`, a user the job creates. It gets execute on the directories down to the checkout, write on `apps/e2e` itself (global setup replaces `observations/`, and Playwright writes `test-results/` and `playwright-report/`), and nothing else. The browsers are installed in `/opt/ms-playwright`, outside the runner's home.
- Playwright runs from `apps/e2e/node_modules/.bin`, not through pnpm, whose update check would reach the registry. It gets only `PATH`, `HOME`, `LANG`, `CI`, `PLAYWRIGHT_BROWSERS_PATH`, `SIGILL_E2E_BROWSER` and `SIGILL_E2E_LARGE`. Global setup starts coturn, Mailpit and the server as that user, as `pnpm e2e` does.
- In both `iptables` and `ip6tables`, two chains each log a packet with `--log-uid` and a prefix of their own name, then reject it: `sigill-dns` takes name lookups and `sigill-egress` everything else that would leave loopback. Four rules at the top of OUTPUT match `-m owner --uid-owner sigill-e2e`: udp to port 53 on `lo` and tcp to port 53 on `lo` go to `sigill-dns`, the rest of `lo` is accepted, and everything else goes to `sigill-egress`. Linux sends packets to the machine's own addresses through `lo`, so ICE host candidates on the runner's own addresses stay allowed.
- Before the tests, three checks run as the user. Each must fail and raise the chain's LOG count: `curl http://1.1.1.1/`, `getent hosts example.com` and `curl 'http://[::1]:53/'`. Then the counters are zeroed.
- After the tests, the job kills every process of the test user, so nothing it left running can send after the count or plant a symlink before the upload. It then prints the chains and the kernel's `sigill-egress: ` and `sigill-dns: ` lines since the counters were zeroed. It fails if `sigill-egress` logged anything, and if `sigill-dns` did on any leg but WebKit's, where it warns with the count. Every packet counts, a browser's background traffic included. Such a packet is not a finding of the leak detector; the runbook says how to tell what sent it.
- The block and its checks are inline in `nightly.yml`, a path that needs a `maintainers` approval. A script under `apps/e2e` that runs with sudo would not. That guards only the steps themselves: the block also trusts every step before it, which runs as `runner`, a user with sudo. Among them, `pnpm install` runs the lifecycle scripts it allows, such as the root `prepare`, and `pnpm run build` runs each workspace package's build script, most of which a pull request can change without a `maintainers` approval.
- The owner match sees only the packets the user itself sends. Whatever it hands to a daemon running as another user, through a UNIX socket, D-Bus or a loopback port, leaves as that daemon's user, unseen. Lookups to a loopback port 53 are the one such path the rules see, and they are refused on every leg. The `coturn` package starts a coturn service as `turnserver` that relays for anyone on every address, so the job stops and disables it right after the install; the stack starts its own coturn as the test user.

### A failed night

- A job `report`, which runs when a job of the night failed or was cancelled and the run is not for a pull request, comments on the open issue titled "Nightly failed" that the Actions bot opened. If there is none, it opens one. A job past its `timeout-minutes` can end cancelled, not failed, so a night that runs out of time comments too, and so does a run cancelled by hand or by a later run on the same branch. The comment names the run's URL and its branch only; the run's page shows which jobs did not succeed. The job has `issues: write` and nothing else; the workflow keeps `contents: read`.
- Whoever fixes the failure closes the issue. The next failed night then opens a new one.

### Replacements to 0001

- "Nightly": "Firefox and WebKit projects" reads "Chromium, Firefox and WebKit, one job per engine". "1 GB and 5 GB files, checking memory and checksum" reads "1 GB and 5 GB files in Chromium only, as under Large files above". "iptables OUTPUT rules" reads "iptables and ip6tables OUTPUT rules, as under The loopback-only user above". "Background browser chatter is not counted as an app leak" reads "Background browser traffic fails the night like any other packet, and is not a finding of the leak detector".
- "Commands": there is no `pnpm e2e:nightly` and no `@nightly` tag. `.github/workflows/nightly.yml` sets `SIGILL_E2E_BROWSER` per job and `SIGILL_E2E_LARGE=1` in the Chromium job.
- "Indexing cost": "with files of 4 MiB or less" reads "with files of a few MiB, 8 MiB at most today". The nightly's sampled bytes are as under Large files above.

## Consequences

- A night is red whenever anything the test user runs tries to leave loopback, or sends a name lookup to a loopback port 53 on the Chromium or Firefox leg. No browser flag is added only to quiet the block: a flag goes in once a night shows the packet and the packet is understood.
- WebKit names its host candidates by mDNS, and the runner resolves names through `files dns` only, so WebKit looks up the other peer's `.local` name through the resolver. The pull request's first run (run 45869245893) showed it: the WebKit suite passed under the block, and its leg logged 444 lookups and nothing that left loopback. The lookups came in pairs, at UDP lengths 79 and 131: a query for a 42-character name, a UUID and `.local`, then the same name with the runner's search domain appended. Each pair came as a test connected two pages. The names are random and say nothing about a transfer, and every lookup was refused, so the WebKit leg counts them without failing. A lookup on that leg that isn't such a name still passes unnoticed, but the Chromium and Firefox legs run the same app code and fail on any lookup.
- The Chromium suite runs on every pull request without the block, and each night under it.
- `pnpm e2e` and the pull request jobs have no egress block. The table in `apps/e2e/README.md` still describes them.
- The large files run only where `SIGILL_E2E_LARGE=1` is set. A pull request that changes the transfer code gets them only from the next night, or from a run dispatched by hand.
- Memory and rate on a runner are measured from the first nights, and SIG-47 gets the results.

## Runbook

### Dispatch the nightly by hand

A run on a branch cancels a run in progress on the same branch, and the cancelled night would comment on the "Nightly failed" issue, so the first command dispatches only while no nightly run on `main` is in progress. It prints nothing either way.

```sh
[ -z "$(gh run list --workflow nightly.yml --branch main --json status --jq '.[] | select(.status != "completed") | .status')" ] && gh workflow run nightly.yml --ref main
gh run list --workflow nightly.yml --event workflow_dispatch --limit 1 --json databaseId,headBranch,status,createdAt --jq '.[0] | [.databaseId, .headBranch, .status, .createdAt] | @tsv'
```

The second command prints the run's ID, `main`, its status and when it was created, separated by tabs. If that time is before the first command ran, either the new run isn't listed yet or a night was in progress and nothing was dispatched: run the second command again, and if the time stays the same, wait for that night to end and start over. Once the status is `completed`, `gh run view <ID> --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'` must print `e2e (chromium)`, `e2e (firefox)` and `e2e (webkit)`, each with a tab and `success`, and `report` with a tab and `skipped`. Any other output means the night failed. A dispatched run that fails or is cancelled comments on the "Nightly failed" issue like a scheduled one.

### Read the block's output

- In each job's log, the step "Let the test user reach loopback only" prints the OUTPUT rules, `/etc/resolv.conf`, the `hosts:` line of `/etc/nsswitch.conf` and every listening socket with its process (`ss -tulpn`). A listener on loopback whose process is not the test user's, other than `systemd-resolved` on port 53, is a daemon the test user could hand traffic to past the block. If a check fails, the step ends with `The test user ran <command> past the block` or `The block did not log <command>`, and the suite doesn't run.
- The step "Count what the test user sent off loopback" prints both chains with their counters, then the kernel's lines since the counters were zeroed. A clean night prints `0` in the `pkts` column of every `LOG` row and no line containing `sigill-egress: IN=` or `sigill-dns: IN=`, which each of the chains' kernel lines holds, and the step passes. The `LOG` rows themselves show their prefix, such as `prefix "sigill-egress: "`. A packet that left loopback ends the step with `The test user sent <N> packets off loopback`. A lookup ends it with `The test user sent <N> packets to the resolver` on the Chromium and Firefox legs, and on the WebKit leg the step passes with the warning `WebKit sent <N> name lookups to the resolver, all refused`.
- Each kernel line reads `<chain>: IN= OUT=<interface> SRC=<address> DST=<address> ... PROTO=<protocol> SPT=<port> DPT=<port> ... UID=<uid> GID=<gid>`. A `sigill-dns` line is a name lookup; it doesn't hold the name, but its second `LEN=`, the UDP length, does say how long the name is: 79 is WebKit's 42-character mDNS name, and 131 is that name with the search domain appended. Any other `OUT=` is a packet that would have left the machine, to `DST` on `DPT`: `DST=224.0.0.251 DPT=5353` is mDNS, and `DST=239.255.255.250 DPT=1900` is SSDP. The line's time, against the timestamps of the step "Run the suite as the test user" (Show timestamps in the log's settings), tells which test was running.
