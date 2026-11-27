# 0028: The Fidant names

- Status: Accepted
- Date: 2026-11-27
- Linear: FID-137

This record amends 0001, 0002, 0010, 0011, 0018, 0021, 0025 and 0027. Read them with the replacements under Decision.

## Context

- The product is Fidant (fidant.se). Sigill was its working title, and the GitHub organization, the repository, the package scope, the Linear workspace and team, and much of the internal text still carried it.
- On 2026-11-27 the GitHub organization `sigill-labs` became `fidant-labs` (`fidant` is taken by a GitHub user), the repository `sigill` became `fidant`, the Linear workspace became `fidant` and its team key `SIG` became `FID`.
- GitHub redirects web links and git operations to a renamed organization's repositories, but API requests under the old name return 404. It permanently retires an old owner and repository pair that had more than 100 clones in the week before the rename (https://docs.github.com/en/organizations/managing-organization-settings/renaming-an-organization, read 2026-11-27). `sigill-labs/sigill` had 4,895 clones in the 14 days before, so nobody can create a repository at the old URL.
- Some of the old names are not branding. The HKDF info strings, the additional data and the data channel label are part of the protocol: a client with other labels can't open a link that the current client made. The app box's paths, user and units are in `apps/infra/box/user-data.sh`, and a change there replaces the box.
- Accepted records are never rewritten (`docs/decisions/README.md`).

## Options considered

1. **Rename every occurrence.** The protocol labels would need a version bump and would break links between old and new clients. The box names would replace the app box, 5–10 minutes down, for a box that SIG-264 deletes.
2. **Rename what is branding, keep what a running client, box or container depends on.**

## Decision

Option 2.

Read the amended records with these replacements:

| Old                                                                                 | New                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `sigill-labs/sigill` in URLs and `gh` commands                                      | `fidant-labs/fidant`                                   |
| `@sigill/<package>`                                                                 | `@fidant/<package>`                                    |
| `SIGILL_<name>` environment variables                                               | `FIDANT_<name>`                                        |
| the nightly run's user `sigill-e2e` and its chains `sigill-egress` and `sigill-dns` | `fidant-e2e`, `fidant-e2e-egress` and `fidant-e2e-dns` |
| canary names `sigill-<token>-…` and MIME types `application/x-sigill-<token>`       | `fidant-<token>-…` and `application/x-fidant-<token>`  |
| the networks suite's names under `sigill.test`                                      | the same names under `fidant.test`                     |
| Sigill, the product                                                                 | Fidant                                                 |

A Linear key `SIG-<number>` in any record opens the same issue as `FID-<number>`.

These keep `sigill`:

- The protocol labels: the HKDF info strings `sigill/v1/signal` and `sigill/v2/file`, the additional data `sigill/v1/signal|…` and the data channel label `sigill` (`apps/web/src/lib/keys.ts`, `apps/web/src/lib/peer.ts`, `docs/how-fidant-works.md`).
- The app box's names: its clone URL `https://github.com/sigill-labs/sigill.git`, `/opt/sigill`, `/etc/sigill`, `/var/lib/sigill`, the user and unit `sigill`, `sigill-deploy`, `sigill-credential` and `sigill-turn-cert`, the server's default relay master `/var/lib/sigill/relay-master`, and the networks suite's copy of the box. The clone URL keeps working through GitHub's redirect, and the retired pair can't be taken over.
- `/run/sigill` in the signaling image and in `FidantSignal`'s task definition. The image ships through `release.yml` and the task definition through `deploy-infra.yml`, and the queue they share doesn't order the two, so a rename could start a task whose image lacks the directory.
- `spikes/split-key`, apart from its package name, because its results are recorded output.
- Accepted records' text.

## Consequences

- `git grep -i sigill` finds the names kept above, accepted records and nothing else.
- `fidant-ci-deploy` and `fidant-release` trust the old and the new subject until a follow-up drops the old one. The subject carries the organization's and the repository's numeric IDs, so only this repository can present either.
- Each local clone runs `git remote set-url origin git@github.com:fidant-labs/fidant.git`, and each machine installs ponytail again from the renamed marketplace with `claude plugin install ponytail@fidant-tools --scope project`, then discards the install's rewrite with `git restore .claude/settings.json`.
- SIG-264 removes the box names with the box. Renaming the protocol labels needs a record of its own.
