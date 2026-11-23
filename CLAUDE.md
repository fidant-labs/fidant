@AGENTS.md

## Claude Code

- In a new git worktree, run `pnpm install` first. It installs dependencies and the git hooks for that worktree.
- When several worktrees run the app at once, give each its own `PORT`.
- Edited files are formatted automatically by a hook in `.claude/settings.json`.
- The review flow is the `review-changes` skill. Run it before calling a change done, before opening a pull request, and before pushing finished work to an open one. It dispatches the reviewer agents in `.claude/agents/`, fixes blockers and majors, runs `pnpm check` and marks the diff clean. A hook blocks `gh pr create` until the mark matches the branch's diff.
- Other hooks: a warning before `git push` or `gh pr create` when the branch is behind `origin/main`, and a Linear reminder after `gh pr create` and `gh pr merge`.
- The project enables the superpowers and ponytail plugins. Claude Code offers to install them the first time you trust this folder.
