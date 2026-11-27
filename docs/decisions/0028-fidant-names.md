# 0028: The Fidant names

- Status: Superseded by 0029
- Date: 2026-11-27
- Linear: FID-137

## Context

- The product is Fidant (fidant.se). It had an earlier name, and the GitHub organization, the repository, the package scope, the Linear workspace and team, and much of the internal text still carried it.
- On 2026-11-27 the GitHub organization became `fidant-labs` (`fidant` is taken by a GitHub user), the repository became `fidant`, the Linear workspace became `fidant` and its team key became `FID`.
- GitHub redirects web links and git operations to a renamed organization's repositories, but API requests under the old name return 404. For a public repository, it permanently retires an old owner and repository pair that had more than 100 clones in the week before the rename (https://docs.github.com/en/organizations/managing-organization-settings/renaming-an-organization, read 2026-11-27). A maintainer renamed the organization first and the repository second, because renaming the repository first would have left the old URL a plain redirect inside an organization name anyone could claim, and the app box cloned that URL. In the 7 days before the rename, the repository's clone traffic counted 4895, over the 100 that the retirement rule needs. After both renames, `git ls-remote` for `refs/heads/production` printed the same line under the old URL as under `https://github.com/fidant-labs/fidant.git`.
- Some of the old names were not branding. The HKDF info strings, the additional data and the data channel label are part of the protocol: a client with other labels can't open a link that the current client made. The app box's paths, user and units are in `apps/infra/box/user-data.sh`, and a change there replaces the box.

## Options considered

1. **Rename every occurrence.** The protocol labels would break links between old and new clients. The box names would replace the app box, 5–10 minutes down.
2. **Rename what is branding, keep what a running client, box or container depends on.**

## Decision

Option 2, superseded on the same day by 0029, which chose option 1.

## Consequences

- `fidant-ci-deploy` and `fidant-release` trusted the old and the new OIDC subject until FID-364 dropped the old one. The subject carries the organization's and the repository's numeric IDs, so only this repository can present either. The Anthropic federation rule that `.github/workflows/claude-review.yml` signs in with holds only the new subject.
- The cut-over, on 2026-11-27: `FidantCi` was deployed by hand in `fidant-dns` and `fidant-poc` with both subjects before the organization was renamed, after the `app` environment's pre-check in `AGENTS.md` ran under the old name, and afterwards `cdk diff FidantCi` printed `There were no differences` for both profiles. At the rename, the federation rule's subject, edited and not replaced because the workflow pins the rule's ID, became `repo:fidant-labs@360211033/fidant@1468787132:pull_request`, since GitHub no longer issues the old one. After both renames, `gh api repos/fidant-labs/fidant/actions/oidc/customization/sub --jq .sub_claim_prefix` printed `repo:fidant-labs@360211033/fidant@1468787132`.
- Each local clone runs `git remote set-url origin git@github.com:fidant-labs/fidant.git`, and each machine installs ponytail again from the renamed marketplace with `claude plugin install ponytail@fidant-tools --scope project`, then discards the install's rewrite with `git restore .claude/settings.json`.
