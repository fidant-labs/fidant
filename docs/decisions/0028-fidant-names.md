# 0028: The Fidant names

- Status: Accepted
- Date: 2026-11-27
- Linear: FID-137

This record amends 0001, 0002, 0010, 0011, 0018, 0021, 0025, 0026 and 0027. Read them with the replacements under Decision.

## Context

- The product is Fidant (fidant.se). Sigill was its earlier name, and the GitHub organization, the repository, the package scope, the Linear workspace and team, and much of the internal text still carried it.
- On 2026-11-27 the GitHub organization `sigill-labs` became `fidant-labs` (`fidant` is taken by a GitHub user), the repository `sigill` became `fidant`, the Linear workspace became `fidant` and its team key `SIG` became `FID`.
- GitHub redirects web links and git operations to a renamed organization's repositories, but API requests under the old name return 404. For a public repository, it permanently retires an old owner and repository pair that had more than 100 clones in the week before the rename (https://docs.github.com/en/organizations/managing-organization-settings/renaming-an-organization, read 2026-11-27). A maintainer renamed the organization first and the repository second, because renaming the repository first would have left `sigill-labs/sigill` a plain redirect inside an organization name anyone could claim, and the app box clones that URL. In the 7 days before the rename, `gh api repos/sigill-labs/sigill/traffic/clones --jq '[.clones[-7:][].count] | add'` printed 4895, over the 100 that the retirement rule needs. After both renames, `git ls-remote https://github.com/sigill-labs/sigill.git refs/heads/production` printed the same line as the same command against `https://github.com/fidant-labs/fidant.git`.
- Some of the old names are not branding. The HKDF info strings, the additional data and the data channel label are part of the protocol: a client with other labels can't open a link that the current client made. The app box's paths, user and units are in `apps/infra/box/user-data.sh`, and a change there replaces the box.
- Accepted records are never rewritten (`docs/decisions/README.md`).

## Options considered

1. **Rename every occurrence.** The protocol labels would need a version bump and would break links between old and new clients. The box names would replace the app box, 5–10 minutes down, for a box that SIG-264 deletes.
2. **Rename what is branding, keep what a running client, box or container depends on.**

## Decision

Option 2.

Read the amended records with these replacements:

| Old                                                                                          | New                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| the organization `sigill-labs` and the repository `sigill`, in URLs, `gh` commands and prose | `fidant-labs` and `fidant`                             |
| `@sigill/<package>`                                                                          | `@fidant/<package>`                                    |
| `SIGILL_<name>` environment variables                                                        | `FIDANT_<name>`                                        |
| the nightly run's user `sigill-e2e` and its chains `sigill-egress` and `sigill-dns`          | `fidant-e2e`, `fidant-e2e-egress` and `fidant-e2e-dns` |
| canary names `sigill-<token>-…` and MIME types `application/x-sigill-<token>`                | `fidant-<token>-…` and `application/x-fidant-<token>`  |
| the networks suite's names under `sigill.test`                                               | the same names under `fidant.test`                     |
| Sigill, the product                                                                          | Fidant                                                 |

A Linear key `SIG-<number>` in any record opens the same issue as `FID-<number>`.

These keep `sigill`:

- The protocol labels: the HKDF info strings `sigill/v1/signal` and `sigill/v2/file` (and the retired `sigill/v1/file` that a comment in `keys.ts` names), the additional data `sigill/v1/signal|…` and the data channel label `sigill` (`apps/web/src/lib/keys.ts`, `apps/web/src/lib/peer.ts`, `docs/how-fidant-works.md`).
- The app box's names: its clone URL `https://github.com/sigill-labs/sigill.git`, `/opt/sigill`, `/etc/sigill`, `/var/lib/sigill`, the user and unit `sigill`, `sigill-deploy`, `sigill-credential` and `sigill-turn-cert`, the unit description `Sigill app server`, everything else in `apps/infra/box/user-data.sh`, the server's default relay master `/var/lib/sigill/relay-master`, and what mirrors or tests the box, among them the networks suite's copy of it. The clone URL keeps working through GitHub's redirect. The organization name was renamed before the repository, and the redirect was checked after the rename (see Context).
- `/run/sigill` in the signaling image and in `FidantSignal`'s task definition. The image ships through `release.yml` and the task definition through `deploy-infra.yml`, and the queue they share doesn't order the two, so a rename could start a task whose image lacks the directory.
- The old OIDC subjects `repo:sigill-labs@360211033/sigill@1468787132:…` in `apps/infra/src/ci.ts` and `apps/infra/src/stacks.test.ts`, until the follow-up drops them.
- `spikes/split-key` keeps `sigill` in its HKDF info strings `sigill/v2/meta` and `sigill/v2/content`, its bench names, its OPFS file name and its recorded results.
- Accepted records' text.

## Consequences

- `git grep -i sigill` finds the names kept above, accepted records and nothing else.
- `fidant-ci-deploy` and `fidant-release` trust the old and the new subject until a follow-up drops the old one. The subject carries the organization's and the repository's numeric IDs, so only this repository can present either. The Anthropic federation rule that `.github/workflows/claude-review.yml` signs in with holds only the new subject, so the follow-up changes nothing there.
- The cut-over, on 2026-11-27: `FidantCi` was deployed by hand in `fidant-dns` and `fidant-poc` with both subjects before the organization was renamed, after the `app` environment's pre-check in `AGENTS.md` ran under the old name, and afterwards `cdk diff FidantCi` printed `There were no differences` for both profiles. At the rename, the federation rule's subject, edited and not replaced because the workflow pins the rule's ID, became `repo:fidant-labs@360211033/fidant@1468787132:pull_request`, since GitHub no longer issues the old one. After both renames, `gh api repos/fidant-labs/fidant/actions/oidc/customization/sub --jq .sub_claim_prefix` printed `repo:fidant-labs@360211033/fidant@1468787132`.
- Each local clone runs `git remote set-url origin git@github.com:fidant-labs/fidant.git`, and each machine installs ponytail again from the renamed marketplace with `claude plugin install ponytail@fidant-tools --scope project`, then discards the install's rewrite with `git restore .claude/settings.json`.
- SIG-264 removes the box names with the box. Renaming the protocol labels needs a record of its own.
