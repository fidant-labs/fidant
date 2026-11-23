---

name: next-issue
description: Pick the next Linear issue that moves the Sigill POC toward its current milestone, implement it in its own git worktree with subagents, commit in reviewable chunks, and open a pull request. Use when asked to "take the next issue", "work on the next milestone", or given an issue key like SIG-21.
argument-hint: "[SIG-<number>]"
---

# Next issue

Takes one Linear issue from idea to pull request. One issue, one worktree, one branch, one PR.

Read `AGENTS.md` first. Its conventions and invariants apply to every step and every subagent.

If an argument like `SIG-21` was given, skip step 1 and use that issue.

## 1. Pick the issue

1. List milestones of the project `Sigill POC` (`P-SIG-1`) with `mcp__linear__list_milestones`. Order them by `sortOrder`. The current milestone is the first one with open issues.
2. List the project's issues with `mcp__linear__list_issues` (team `SIG`, project `P-SIG-1`, fields `title`, `status`, `projectMilestone`, `priority`, `assignee`).
3. Candidates are the current milestone's issues in `Backlog` or `Todo`. Skip `In Progress`, `Done`, `Canceled` and `Duplicate`.
4. Read each candidate with `mcp__linear__get_issue` and its comments with `mcp__linear__list_comments`. Drop candidates that are blocked by an open issue, or whose description says they depend on work that is not done (milestone descriptions state such orderings too, for example "starts only after the first laptop-to-laptop transfer works").
5. Rank what is left: issues that unblock others first, then priority (Urgent > High > Medium > Low > none), then milestone order in the description.
6. Present the top pick with one line on why, plus up to two alternatives, using `AskUserQuestion`. Wait for the answer.

If no candidate is unblocked, say so, list what blocks each one, and stop.

## 2. Claim it

- Set the issue to `In Progress` and assign it to `me` with `mcp__linear__save_issue`.
- Branch name: `sig-<number>-<short-slug>`, slug of 2 to 5 words from the title (for example `sig-21-first-demo`). Do not use Linear's suggested `gitBranchName`; it has a user prefix.

## 3. Create the worktree

From the main checkout:

```sh
git fetch origin
git worktree add .claude/worktrees/<branch> -b <branch> origin/main
cd .claude/worktrees/<branch> && pnpm install
```

If `pnpm` is missing or `node -v` is not 26, the shell is on another nvm version: prefix commands with `export PATH=~/.nvm/versions/node/v26.<x>/bin:$PATH` (Node 26 ships without Corepack: run `npm install -g pnpm@<version>` once under it if needed, with the version from `package.json`), and pass the same prefix to every subagent. Run `pnpm check` once to confirm the baseline is green before changing anything.

`.claude/worktrees/` is gitignored and excluded from biome. Every later step works inside this worktree. Pass its absolute path to every subagent and tell them to use absolute paths or `git -C <worktree>`, never the main checkout.

If the branch or worktree already exists, the issue was started before: reuse it, read `git log origin/main..HEAD`, and continue from where it stopped.

## 4. Plan (Plan subagent)

Spawn a `Plan` subagent with: the issue title, description, comments, the milestone description, the worktree path, and `AGENTS.md`. Ask it for:

- Acceptance criteria, taken from the issue, made concrete and testable.
- An ordered list of **commits**. Each commit is one idea a human reviewer can read in a few minutes: a conventional-commit subject (imperative, under 72 characters), the files it touches, and what it adds. Each commit must leave `pnpm check` green. Typical order: scaffolding or types, core logic with tests, wiring, docs.
- Open questions where the issue is ambiguous.

Issue types that are not code still get a PR:

- **Decide ...** issues: the deliverable is a decision record in `docs/decisions/NNNN-<slug>.md` (context, options considered, decision, consequences). Commits: options and context first, then the decision.
- **Spike ...** issues: the deliverable is a small, runnable experiment under `spikes/<slug>/` plus a findings write-up with measurements.

Show the plan to the user. If there are open questions that change the design, ask them with `AskUserQuestion` before implementing. Otherwise continue.

## 5. Implement (one subagent per commit)

Work through the planned commits **in order**, one `general-purpose` subagent each. They share the worktree, so do not run them in parallel.

Each subagent prompt contains:

- The worktree's absolute path, and the rule to work only there.
- The full plan, with its own commit marked, and the commits already made (`git log --oneline origin/main..HEAD`).
- The `AGENTS.md` invariants, verbatim. Especially: never send or log file content, file names, metadata or keys; keys live only in the URL fragment or browser memory; everything must run locally without internet.
- The instructions: implement only this commit; write `node:test` tests next to the code; run `pnpm check` in the worktree until green; then stage only the files for this commit and commit with the planned subject plus the attribution trailer from the system reminder. No `--no-verify`. Report the commit hash, what changed, and anything it deviated from or found surprising.

After each subagent returns, check `git -C <worktree> log -1 --stat` yourself. If the commit is too big, mixes ideas, or breaks the plan, fix it before moving on (amend while it is still the latest commit, or add a follow-up commit). If the plan turns out wrong, update the remaining commits instead of forcing them.

## 6. Review

1. With the shell in `<worktree>`, run the `review-changes` skill. It dispatches the reviewer agents, fixes blockers and majors, runs `pnpm check`, commits the fixes and marks the diff clean. The `gh pr create` hook in step 7 refuses until that mark matches the branch.
2. Read the full diff yourself.

## 7. Open the pull request

```sh
git -C <worktree> push -u origin <branch>
cd <worktree> && gh pr create --repo sigill-labs/sigill --base main --head <branch> \
  --title "SIG-<number>: <issue title>" --body-file <scratchpad>/pr-body.md
```

`<worktree>` must be the literal absolute path, because the review gate follows a literal `cd` and does not expand variables.

PR body: fill in the sections of `.github/pull_request_template.md` (Linear issue, What and why, How it was checked) and add a commit walkthrough. For example:

```markdown
## Linear issue

SIG-<number>

## What and why

<2 to 4 sentences: what this delivers and how it moves the milestone forward>

## Commits

<one line per commit, in order, saying what to look at in each. Reviewers read the PR commit by commit.>

## How it was checked

- [x] `pnpm check` passes
      <commands to run locally, with no internet, and what was checked by hand>

## Notes

<decisions made, deviations from the issue, follow-ups not done here>

<attribution line from the system reminder>
```

If follow-up work came up, create Linear issues for it in the same project and milestone (check for duplicates with `list_issues` first) and list them under Notes.

## 8. Report

Tell the user: the issue, the PR URL, the commit list, and the worktree path. Leave the worktree in place for review fixes. After the PR merges, clean up with:

```sh
git worktree remove .claude/worktrees/<branch> && git branch -d <branch>
```
