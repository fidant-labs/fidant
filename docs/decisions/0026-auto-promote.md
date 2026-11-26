# 0026: Promoting every merge automatically, for now

- Status: Accepted
- Date: 2026-11-26
- Linear: SIG-330

This record amends 0020 and 0023, which are not superseded. Read them with the replacements under Decision. SIG-331 takes this record back before fidant.se has real users.

## Context

- 0020 put a maintainer between a merge to `main` and fidant.se: app code ships only when a maintainer pushes its commit to the `production` branch.
- This early, fidant.se has no users to protect, and two developers promote after nearly every merge. The step costs time and catches nothing yet.
- 0020 chose a push by hand over a workflow so that no credential in CI may move `production`.

## Options considered

| Option                                                     | For                                                                                            | Against                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Keep promoting by hand                                     | 0020 holds as written.                                                                         | A command and its checks after every merge.                                             |
| Point the box and `release.yml` back at `main`             | No `production` branch to keep.                                                                | Replaces the app box once, and going back to 0020 later replaces it again.              |
| A workflow that pushes each merge to `production` (chosen) | The box, `release.yml` and the rulesets stay. Deleting one workflow and one key restores 0020. | A deploy key in CI may move `production`. What its holder can do is under Consequences. |

## Decision

`.github/workflows/promote.yml` runs on every push to `main` and pushes that commit to `refs/heads/production`. The box and `release.yml` then deploy it as after a promotion by hand.

- It pushes over SSH with a deploy key that has write access. A push with the workflow's own `GITHUB_TOKEN` would start no `release.yml` run.
- The private key is the secret `PROMOTE_DEPLOY_KEY` of the GitHub environment `promote`, whose only deployment branch is `main`. A workflow on any other branch gets no key. `.github/**` needs a `maintainers` approval (AGENTS.md, Merging), so a change to what the key's job runs needs one too.
- The `production-maintainers` ruleset has deploy keys on its bypass list. That lets every deploy key of the repository update the branch, so the repository has exactly one. The `production` ruleset is unchanged: nothing deletes the branch or moves it other than forward.
- A run whose commit `production` already holds does nothing and passes. Runs go one at a time.
- The box still builds only a commit on `main`'s first-parent history, and `release.yml` still releases only `production`'s tip.
- A maintainer can still promote by hand (AGENTS.md, Releasing), for example after a failed run. Agents still never push to `production`, and the hook stays.

### Set up by hand, before this merges

Agents never change repository settings, so a maintainer runs these, from an empty directory outside any clone.

1. Make the key pair and add its public half: `ssh-keygen -q -t ed25519 -N "" -C promote -f promote-key && gh repo deploy-key add promote-key.pub --allow-write --title promote --repo sigill-labs/sigill`. Then `gh repo deploy-key list --repo sigill-labs/sigill --json title,readOnly --jq '.[] | [.title, .readOnly] | @tsv'` must print exactly one line, `promote` and `false` separated by a tab.
2. Make the environment with its branch policy: `gh api -X PUT repos/sigill-labs/sigill/environments/promote -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true' --jq .name` must print `promote`, and `gh api -X POST repos/sigill-labs/sigill/environments/promote/deployment-branch-policies -f name=main -f type=branch --jq .name` must print `main`. Then `gh api repos/sigill-labs/sigill/environments/promote/deployment-branch-policies --jq '.branch_policies[] | [.name, .type] | @tsv'` must print exactly one line, `main` and `branch` separated by a tab.
3. Only after that check, store the private half and delete both files: `gh secret set PROMOTE_DEPLOY_KEY --env promote --repo sigill-labs/sigill < promote-key && rm promote-key promote-key.pub`. Then `gh secret list --env promote --repo sigill-labs/sigill --json name --jq '.[].name'` must print `PROMOTE_DEPLOY_KEY`, and `ls` must print nothing.
4. In the repository's settings, under Rules, Rulesets, `production-maintainers`, add "Deploy keys" to the bypass list. `gh api repos/sigill-labs/sigill/rulesets --jq '.[] | select(.name == "production-maintainers") | .id'` prints its ID, and `gh api repos/sigill-labs/sigill/rulesets/<id> --jq '.bypass_actors[].actor_type'` must then print a line `DeployKey`.

After the merge, run `git fetch origin`, then, with `sha` set to the merge's full sha, `git merge-base --is-ancestor "$sha" refs/remotes/origin/production && echo promoted`. It must print `promoted`. It prints nothing while the run is still going. If it still prints nothing after a few minutes, the newest `promote.yml` run in the Actions tab shows why.

### Replacements to 0020 and 0023

| Where it says                                                                                                                                         | Read                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0020, Decision: "Only the `maintainers` team moves it, only forward"                                                                                  | The `maintainers` team and `promote.yml`'s deploy key move it, only forward.                                                                                                                                                                                                                                            |
| 0020, Decision: "`production-maintainers` refuses updates from anyone but the `maintainers` team."                                                    | `production-maintainers` refuses updates from anyone but the `maintainers` team and the repository's deploy keys.                                                                                                                                                                                                       |
| 0020, Consequences: "App code merged to `main` reaches fidant.se only when a maintainer promotes it."                                                 | App code merged to `main` reaches fidant.se when `promote.yml` promotes it, within minutes of the merge, or when a maintainer promotes it by hand.                                                                                                                                                                      |
| 0020, Consequences: "The maintainer promotes `main`'s tip just before the merge and the merge right after it lands."                                  | The maintainer checks that `production` is at `main`'s tip just before the merge. `promote.yml` promotes the merge.                                                                                                                                                                                                     |
| 0020, Consequences: "Whoever merges any other pull request asks a maintainer to promote that merge right after it lands", to its sentence's end       | Whoever merges a pull request whose `promote.yml` run fails asks a maintainer to promote that merge by hand.                                                                                                                                                                                                            |
| 0020, Consequences: "A rollback or an app fix in an emergency waits for a maintainer.", and the three sentences after it                              | A rollback or an app fix is a pull request on `main`, which `promote.yml` promotes when it merges. It ships everything merged before it.                                                                                                                                                                                |
| 0020 and 0023, wherever a step waits for a maintainer to promote a commit                                                                             | The step waits for `promote.yml`'s run for that commit, or for a maintainer's promotion by hand after a failed run.                                                                                                                                                                                                     |
| 0023, twice: "no app code reaches visitors unless a maintainer promoted it", and 0023: "which only maintainers can move (0020)"                       | App code reaches visitors from the box only if it merged to `main`. For the signaling image the same holds, except through the release workflow's gap until SIG-285 closes it. `promote.yml` promotes every merge, so the reviews that AGENTS.md asks for under Merging are the only step before visitors get the code. |
| 0023, Context: "builds the commit a maintainer promotes to the `production` branch"                                                                   | builds the commit that `promote.yml` or a maintainer promotes to the `production` branch                                                                                                                                                                                                                                |
| 0023, on the build job's check: "Only maintainers can move `production`, so the gap needs a maintainer's push or a maintainer's account."             | The `maintainers` team and whoever holds `promote.yml`'s deploy key can move `production`, so the gap needs a maintainer's push, a maintainer's account or that key.                                                                                                                                                    |
| 0020, Options: "The box serves a `production` branch that only maintainers move (chosen)" and "A maintainer decides when app code reaches fidant.se." | The box serves a `production` branch that only maintainers and `promote.yml`'s deploy key move. `promote.yml` decides when app code reaches fidant.se, within minutes of each merge.                                                                                                                                    |

## Consequences

- The risk 0020 closed is open again: one compromised GitHub account, or one pull request that misleads the reviewer, can serve every visitor code that sends keys out, within minutes of its merge. Agents may merge pull requests outside `sensitive-paths` on the reviewer's approval alone (AGENTS.md, Merging), and those now ship with no maintainer reading them. That is accepted only while fidant.se has no real users. SIG-331 removes the workflow.
- Infra and app go live closer together, since both follow the merge. They are still two runs: `deploy-infra.yml` waits in its queue, and the box builds for a few minutes.
- Whoever holds the deploy key's private half can move `production` forward to a commit that is not on `main`. The box refuses it. But GitHub runs that commit's own copy of `release.yml`, which need not keep the check that the commit is on `main` (the gap in 0023 that SIG-285 closes), and its release job gets the `app` environment's token and with it the `fidant-release` role. So the holder could put a signaling image live.
- After such a push the branch only moves forward, so every later `promote.yml` push fails until `main` contains that commit (AGENTS.md, Releasing, says how).
- The holder can also push to any branch that no ruleset closes to deploy keys, workflow files included, and those workflows run with the repository's secrets that are not behind an environment.
- The key lives only in the `promote` environment's secret. If it leaks, delete the deploy key first. Then `git fetch origin && git merge-base --is-ancestor refs/remotes/origin/production refs/remotes/origin/main && echo on-main` must print `on-main`. Look through the repository's branches, tags and recent `release.yml` runs for pushes nobody made, then follow the set-up again.
- A second deploy key added to the repository could also update `production`. Add none while this record holds.
- To take this back: delete `promote.yml`, the deploy key and the `promote` environment, take deploy keys off the ruleset's bypass list, and write a record that withdraws the replacements above (SIG-331).
