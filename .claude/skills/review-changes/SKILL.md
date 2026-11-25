---

name: review-changes
description: Sigill's review flow. Use before calling a code change done, before opening a pull request, and before pushing finished work to an open pull request. Runs parallel reviewer agents over the branch diff, verifies their findings, and fixes blockers and majors in a loop until none remain. A hook blocks `gh pr create` until this flow marks the diff clean.
---

# Review changes

Run this from the **main session**. Subagents cannot launch subagents, so the reviewers, verifiers and fixers are all dispatched from here. When builder subagents wrote the code, review their combined diff after they return; a builder never reviews its own work.

**Gates.** `pnpm check` (lint, typecheck, tests, build) takes seconds in this repo. It runs in step 7 after the review is clean, and `AGENTS.md` requires it before every commit, so whoever commits runs it first. Builders and fixers otherwise run narrow gates only: `pnpm lint`, `pnpm --filter <package> typecheck`, `pnpm --filter <package> test`. Reviewers and verifiers run no gates.

## 1. Scope

- Base: `git rev-parse --abbrev-ref origin/HEAD`, falling back to `origin/main`. Fetch and merge it first (`git fetch origin && git merge --no-edit origin/main`) so the review sees the merged tree and nothing has to merge after the mark. Never rebase. Outside a worktree, ask before making that merge commit.
- Merge base: `git merge-base <base> HEAD`.
- The diff under review is `git diff <merge-base>` (committed plus uncommitted tracked changes) and any untracked files from `git status --porcelain`.
- **After a clean mark**, review only what changed since it. The marked commit is in `$(git rev-parse --git-path deep-review-clean-head)`. When that commit is an ancestor of `HEAD` (`git merge-base --is-ancestor`), the delta base is the output of `git merge-tree --write-tree <marked commit> <merge-base>` when it exits 0 (a clean merge prints only the tree id): the marked tree with the base merged in, so base changes stay out of the delta. Reviewers then read `git diff <delta base>` plus untracked files, and step 3 picks lanes and applies its tiny and docs-only rules by the delta. The delta narrows only what reviewers read; everywhere else in this skill, "the diff" is the whole-branch diff defined above, untracked files included. When the file is missing, the commit is not an ancestor or `merge-tree` exits non-zero, review the whole branch.
- Record the changed paths, total changed lines and file count. Reviewers run the diff commands themselves; never paste the diff into a prompt.

## 2. Briefing

Write a briefing of at most 15 lines to the session's scratchpad (never inside the repo). Every reviewer and verifier gets it verbatim:

- **Intent:** what the change is for, from the Linear issue (the `SIG-` key in the branch name), the agreed spec or the conversation. Include the issue's "Done when" criteria.
- **Repo rules:** the `AGENTS.md` invariants and conventions that apply to the touched paths.
- **Access model**, only when the diff touches identity, sessions, routing, keys or data access: who can do what, and where that is enforced. Read the code to write this; do not guess.

## 3. Reviewers

Dispatch every matching lane in **one message** so they run in parallel. Cap at 8; queue the rest for a second round. Pass `model` explicitly on every call. The agents live in `.claude/agents/`.

| Lane (`subagent_type`)                                | When                                                                                                                                                               | Model  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `Code Reviewer`                                       | always                                                                                                                                                             | opus   |
| Over-engineering lane (`Code Reviewer`, prompt below) | always                                                                                                                                                             | opus   |
| `Software Architect`                                  | over 200 lines or 5 files, or a new app, package or module boundary                                                                                                | opus   |
| `Application Security Engineer`                       | `apps/server`, crypto or key handling, URLs, logging, identity, uploads, anything near the `AGENTS.md` invariants, `.github/workflows/`, anything under `.claude/` | opus   |
| `Backend Architect`                                   | `apps/server` or server-side packages                                                                                                                              | opus   |
| `Frontend Developer`                                  | `apps/web` components or client state                                                                                                                              | opus   |
| `Database Optimizer`                                  | schema, migrations or queries                                                                                                                                      | opus   |
| `Accessibility Auditor`                               | UI markup or interaction                                                                                                                                           | sonnet |
| `API Tester`                                          | HTTP routes, signaling or other contracts                                                                                                                          | sonnet |
| `Test Results Analyzer`                               | test files changed, or production code changed without tests                                                                                                       | sonnet |
| `UX Architect`                                        | user-facing copy or layout                                                                                                                                         | sonnet |
| `Performance Benchmarker`                             | transfer paths, loops over file data, bundle size                                                                                                                  | sonnet |

**Tiny diff** (under 50 lines or a single file): only `Code Reviewer`, the over-engineering lane, and `Application Security Engineer` when its row matches.

**Docs-only diff** (every changed path is `.md` or `.txt`, and none is any `AGENTS.md` or `CLAUDE.md` or under `.claude/`): only `Code Reviewer`, one round, no fix loop beyond it.

Every reviewer prompt contains:

1. The diff command scoped to that lane's paths. `Software Architect` and the over-engineering lane get the full diff and may read any file to compare with existing patterns. Every lane is read-only.
2. The briefing, verbatim.
3. The severity scale and output contract below.
4. `You are one of N parallel reviewers. Report only findings within your lane. Do not repeat general feedback other lanes cover.`
5. `Report every instance now. When a finding belongs to a class, such as every file a credentialed job reads or every caller of a changed function, list the whole class. Later rounds only check fixes.`

Security findings about authorisation must name the concrete capability an attacker gains beyond the access the role already has. Without that they are not blockers.

**Over-engineering lane prompt:** "Hunt over-engineering only; correctness, security and performance belong to other lanes. Stop at the first rung that holds: (1) does this code need to exist? (2) does a helper already live in this repo? (3) does the stdlib do it? (4) does a native platform feature cover it? (5) does an installed dependency solve it? (6) can it be one line? Read the touched code end to end before flagging. Tag each finding `delete:`, `stdlib:`, `native:`, `yagni:` or `shrink:`. Never flag validation at trust boundaries, error handling that prevents data loss, security, accessibility, a smoke test, or anything the task asked for. Objective removals are `major`, taste is `minor`; never `blocker` or `nit`."

### Severity

- `blocker`: wrong behaviour, security hole, data loss, a broken `AGENTS.md` invariant, a broken acceptance criterion.
- `major`: an objectively correct fix with no judgment call, such as dead code, an unused export, a missing `await`, a null hole, a typo in user-facing text, or a violated `AGENTS.md` or `CLAUDE.md` rule. Test: two competent engineers would agree on the fix without discussion.
- `minor`: an improvement that involves taste. A reasonable reviewer might say "leave it". In a file under `apps/infra/box/`, any change after deploy replaces the box, so lanes rate a minor there `major`; nits stay nits. Step 6's round-2+ demotion and the verifier's downgrades still apply to that rating.
- `nit`: pure style preference.

A coverage gap on production code that is already correct is `minor`, unless the regression it would catch is catastrophic.

### Output contract

```
## <Lane>
- [severity] path/to/file.ts:L<line>: <one-line finding>
  rationale: <at most 2 sentences>
  suggestion: <optional one-line fix>
```

Or the literal line `NO_FINDINGS`. Architect findings may use a directory or `(structural)` as the locator.

## 4. Consolidate

Dedupe on path + line + the first 8 words of the finding, keeping an "also flagged by" list. Sort by severity, then path.

## 5. Verify

Dispatch in parallel one `Reality Checker` (opus) for blockers and one for majors. Skip empty groups. Minors and nits are not verified. Each verifier gets the briefing, the severity scale above, the diff commands, read access to the whole repo including `git blame`, and its findings as JSON `{id, severity, lane, path, line, finding, rationale}`. It returns one JSON line per finding (`keep`, `drop` with a reason, or `downgrade` to minor or nit), following the rules in its agent file. A malformed or missing verdict keeps the finding at its original severity.

## 6. Fix loop

Snapshot the working tree twice with the command below: once before dispatching the fixers and once after they return. It prints a tree id and leaves the real index alone.

```
idx=$(git rev-parse --path-format=absolute --git-path review-snap-index) && GIT_INDEX_FILE=$idx git read-tree HEAD && GIT_INDEX_FILE=$idx git add -A && GIT_INDEX_FILE=$idx git write-tree
```

The round's fix delta is `git diff <before> <after>`. Write both tree ids out literally in the reviewer prompts.

For every remaining blocker and major inside the diff, dispatch one fix subagent (`general-purpose`, sonnet). Never hand a finding back to the builder that wrote the code. Minors and nits are never fixed in this loop; every extra edit is new surface for the next round. Run fixes in parallel only when they touch different files. Each fixer gets the finding, the briefing and these rules:

- Fix the class, not the line: sweep the whole diff for the same pattern and fix every occurrence.
- A reviewer's suggested fix is a hint, not the fix: check what it does on every other path through the code before applying it.
- When the finding is about behaviour, add a `node:test` test that fails before the fix.
- Run the narrow gates for the touched packages. Stay inside the finding's scope.
- Never commit. Run `git add -N` on every file you create, so it shows in `git status` and `git diff` as a new file and the mark refuses until it is committed.

Findings outside the diff and architect "restructure the module" findings are not fixed here. They go into a follow-ups list for the pull request body.

Read each fix delta yourself. A fix is **mechanical** when it only edits comments or docs prose, corrects a typo, removes an unused import or export, or deletes code that nothing references. Every other fix, and any fix you are unsure about, is a behaviour fix. Directive comments such as `biome-ignore` or `@ts-expect-error`, and any change to any `AGENTS.md` or `CLAUDE.md` or to files under `.claude/`, are not mechanical. When every blocker and major not deferred to follow-ups got a fix, every fix is mechanical, and the narrow gates pass, the loop is clean and no reviewer round follows.

Otherwise re-run only the lanes whose paths the fixes touched, verify their new findings, and repeat. From round 2 on, a re-run lane reviews the fix delta (`git diff <before> <after>`), not the whole branch diff; it gets the findings it is checking and may read surrounding code for context. A round-2+ finding on lines the delta did not change is something round 1 missed: it drops to `minor` and goes to the report, unless it is a blocker that names the concrete capability an attacker gains or the data that is lost.

- **Clean:** 0 blockers and 0 majors. Stop.
- **No progress:** a round fixed nothing while blockers or majors remain. Stop and report.
- **Cap:** 3 rounds, with no exception for security. Stop, list the open blockers and majors, and ask the user with `AskUserQuestion` whether to run another round, fix them without another review, or stop. New work that is not a fix gets its own review and its own count.

A stopped loop means the work is not done. Never open a pull request or call the work finished with known blockers or majors.

## 7. Gate, report and mark

When the loop is clean, run `pnpm check`. On failure, dispatch a fixer for the cause with narrow gates, re-run only the lanes the fix touched on its delta, then run `pnpm check` again.

Tell the user: which lanes ran and which were skipped, kept, dropped and downgraded counts per severity, what was fixed, the gate result, and every remaining minor and nit (not fixed, listed for the user to decide). Keep it short.

When the result is clean and the gate is green, commit the reviewed changes once (outside a worktree, ask first), then record the result from the repo or worktree root as a **command of its own**. The `gh pr create` hook checks before anything in the same command runs, so `mark && gh pr create` is always blocked:

```
bash .claude/scripts/review-gate.sh mark
```

It refuses while reviewed changes are uncommitted. The hook only lets `gh pr create` through when this mark matches the branch's current diff, so any later commit needs another review (of the delta, see step 1). A clean merge of the base keeps the mark.
