# 0029: No trace of the earlier name

- Status: Accepted
- Date: 2026-11-27
- Linear: FID-381

This record supersedes 0028.

## Context

- 0028 renamed the branding to Fidant and kept the earlier name where a running client, box or container depended on it: the protocol labels, the app box's paths, user and units, the signaling image's run directory, the split-key spike and the text of accepted records. Linear keys from before the team's rename kept the old team key.
- On 2026-11-27 the maintainers decided that no trace of the earlier name or the old team key stays in the repository, and that a short outage at release is acceptable.

## Options considered

1. **Rename everything in one pull request.** One box replacement, one protocol change, one release. Transfers that span the release fail, and the site is down while the new box starts.
2. **Rename in stages, keeping old and new side by side.** No outage, but every stage leaves both names in the code until the last one lands, and the protocol would need to accept both labels for a while.

## Decision

Option 1.

- Every file in the repository uses the new names: `fidant`, `fidant-labs`, `FIDANT_…` and `@fidant/…`, and issue keys `FID-<number>`, project IDs `P-FID-<number>` and branch names `fid-<number>-…`. A Linear issue keeps its number across the team's rename, so `FID-<number>` opens the issue that the old key named.
- That includes accepted records. This is the one rewrite of accepted text that `docs/decisions/README.md` allows: a record now reads with the new names, even for a name that existed only under the earlier one, such as the retired file-key label in 0002 and 0017 or the nightly run's old user and chains in 0027. 0028 keeps its facts without the old names.
- The protocol labels become `fidant/v1/signal` and `fidant/v2/file`, the additional data `fidant/v1/signal|…` and the data channel label `fidant` (`docs/how-fidant-works.md`). Their version numbers stay: a label that differs in any byte already gives a different key.
- The app box's names become `/opt/fidant`, `/etc/fidant`, `/var/lib/fidant`, the user and unit `fidant`, `fidant-deploy`, `fidant-credential` and `fidant-turn-cert`, and it clones `https://github.com/fidant-labs/fidant.git`. The server's default relay master is `/var/lib/fidant/relay-master`, and 0015's rule reads the committed relay list where `/var/lib/fidant` exists.
- The signaling image's run directory, its tmpfs in `FidantSignal`'s task definition, and the networks suite's copy become `/run/fidant`.
- `apps/e2e/src/names.test.ts`, which `pnpm check` runs, fails when a tracked file carries the earlier name or an old issue key.

## Consequences

- The box replacement takes fidant.se down for the 5–10 minutes the new box needs, so a maintainer merges this pull request, promotes `main`'s tip just before and the merge right after, as `AGENTS.md` says for any box replacement.
- Between the two promotions, one box can run the other's code: the old box the new release, or the new box the old one. The server then finds no home directory under the name it expects, reads no relay list and offers the box's own coturn, which the box's `turn.conf` drop-in still configures (0015). Relayed transfers go through the box's coturn until the second promotion reaches the new box.
- The new box makes a new relay master, as every box replacement does (0015), and the relay fetches its new secret from it.
- A client before this release and one after it derive different keys from the same link, so a transfer whose two sides load the site on either side of the release fails to connect: the setup messages don't open, as a tampered one wouldn't (`bad-signal` in `apps/web/src/lib/peer.ts`). The sender makes a new link after reloading.
- The signaling image and `FidantSignal`'s task definition ship through different workflows in no fixed order. Either order works: the tmpfs comes from the task definition, with its owner and mode in the mount options, and the container runtime makes the mount point when the image lacks it. Docker does: on 2026-11-27, `docker run --rm --read-only --user node --tmpfs /run/fidant:noexec,nosuid,nodev,uid=1000,gid=1000,mode=700 node:26.13.1-alpine3.24 sh -c 'touch /run/fidant/x && ls -ld /run/fidant'` printed `drwx------ … node node … /run/fidant` from an image without that directory. Fargate's runtime is untested. If the merge's infra run starts a task that can't write `/run/fidant`, the service's circuit breaker rolls back, CloudFormation returns `FidantSignal` to the old task definition and that job fails. After the second promotion's release ships the image with the directory, re-running that job, while its run is still the newest, deploys the new task definition (see Merging in `AGENTS.md`). `FidantSignal` serves no visitor until the cutover.
- Branches named `sig-<number>-…` no longer get a Linear key from the pull request reminder hook.
- The repository's git history, closed pull requests, GitHub's branch list and Linear's own history keep the earlier name. This record covers the files on `main`.
