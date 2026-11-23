@AGENTS.md

## Claude Code

- In a new git worktree, run `pnpm install` first. It installs dependencies and the git hooks for that worktree.
- When several worktrees run the app at once, give each its own `PORT`.
- Edited files are formatted automatically by a hook in `.claude/settings.json`.
- Before opening a pull request, run `pnpm check` and review the full diff.
