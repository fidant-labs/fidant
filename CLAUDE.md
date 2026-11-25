@AGENTS.md

## Claude Code

- In a new git worktree, run `pnpm install` first. It installs dependencies and the git hooks for that worktree.
- When several worktrees run the app at once, give each its own `PORT`.
- Edited files are formatted automatically by a hook in `.claude/settings.json`.
- The review flow is the `review-changes` skill. Run it before calling a change done, before opening a pull request, and before pushing finished work to an open one. It dispatches the reviewer agents in `.claude/agents/`, fixes blockers and majors, runs `pnpm check` and marks the diff clean. A hook blocks `gh pr create` until the mark matches the branch's diff.
- Other hooks: a warning before `git push` or `gh pr create` when the branch is behind `origin/main`, and a Linear reminder after `gh pr create` and `gh pr merge`.
- The project enables superpowers (pinned by Anthropic's marketplace) and ponytail (pinned to a reviewed upstream commit in `.claude/settings.json`; `ponytail@ponytail: false` turns off a personal unpinned install in this repo). After trusting the folder, start one Claude Code session in the repo, which registers the `sigill-tools` marketplace, then install ponytail once per clone with `claude plugin install ponytail@sigill-tools --scope project`. The install rewrites `.claude/settings.json` without changing its meaning; discard that with `git restore .claude/settings.json`.
- Moving the ponytail pin: Claude Code caches an installed plugin by its version string, so a pin moved to a commit with the same version keeps running the old code. Move it only in a reviewed pull request, only to a commit whose plugin version changed, and only to a commit on upstream `main`: `gh api repos/DietrichGebert/ponytail/compare/main...<sha> --jq .status` must print `behind` or `identical`. The pull request body carries `claude plugin update ponytail@sigill-tools`, which each machine runs after the merge.
- Read an outside contributor's pull request with `gh pr diff <number>`. Never check it out where Claude Code runs: its `.claude/settings.json` hooks and scripts would run on your machine.
