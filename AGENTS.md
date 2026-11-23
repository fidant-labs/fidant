# Sigill

Secure file transfer. Files are encrypted in the sender's browser, and no infrastructure (our servers, hosts, relays, email) can read file content. Verified transfers add BankID identity, a signed receipt, and a tamper-evident audit log.

Planning lives in Linear: workspace `sigill`, team `SIG`, issue keys like `SIG-21`.

## Commands

- `pnpm install`: installs dependencies and the git hooks.
- `pnpm start`: builds the web client and serves it over HTTPS on `PORT` (default 8443), on all network interfaces, and prints the addresses to open. The first start creates a self-signed certificate in `.certs/`; browsers show a warning once. On macOS, a browser on another laptop needs Local Network access (System Settings → Privacy & Security → Local Network) or the page "can't be reached", even though `curl` works.
- `pnpm check`: lint, typecheck, unit tests and build across the workspace. Run it before every commit. The pre-push hook runs it too.
- `pnpm format`: fixes formatting and safe lint issues.

## Prerequisites

- Node 24 (see `.node-version`).
- pnpm, at the version pinned in `package.json` (`packageManager`).
- gitleaks (`brew install gitleaks`). The pre-commit hook fails without it.
- openssl, for the local certificate. macOS and Linux ship with it.

## Layout

- `apps/*`: things we run or ship. `apps/web` is the Preact client, built by Vite into `apps/web/dist`. `apps/server` is the Node process that serves it.
- `packages/*`: code used by more than one app. Create a package only when a second consumer exists.
- Workspace packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Internal packages have no build step.
- Every package with TypeScript has a `typecheck` script (`tsc --noEmit -p .`) and, if it has tests, a `test` script. The root scripts run them recursively.

## Conventions

- Node runs `.ts` files directly through type stripping. Use only erasable TypeScript syntax (no `enum`, `namespace` or constructor parameter properties). Relative imports include the `.ts` extension.
- Unit tests use `node:test` and sit next to the code as `*.test.ts`.
- Dependencies: `pnpm add --filter <package> <dep>`. pnpm is strict, so each package declares everything it imports.
- Workspace packages: add one as a dependency with `pnpm add --filter <consumer> --workspace <package>`, which links and saves `workspace:*`. Without `--workspace`, pnpm can resolve the name from the public npm registry.
- Commits: conventional commits, subject line only, imperative, under 72 characters, for example `feat: add signaling server`.
- Branches: `sig-<number>-<short-slug>` after the Linear issue. One pull request per issue. `main` is protected: changes land only through pull requests with green CI.
- Pull request titles start with the Linear issue key (`SIG-21: ...`) so Linear links them.

## Merging

- An agent may merge a pull request when the required `check` passed and the latest review by `github-actions[bot]` on the pull request's current head commit is an approval. The approval counts only with a successful `Claude review` run on that same commit, because any workflow in this repository can post a review as `github-actions[bot]`.
- Pull requests that touch `.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.agents/**`, `.mcp.json` or `skills-lock.json` also need an approval from the `maintainers` team. Authors cannot approve their own pull requests, so the other developer approves. The `sensitive-paths` ruleset enforces this, and repository admins can bypass it.
- Agents never approve pull requests, never merge with `--admin` or any other rule bypass, and never change rulesets, teams or repository settings.

## Invariants

- Never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them. The one deliberate exception: the BankID receipt text names the file.
- Keys live only in the URL fragment or in browser memory.
- This repository is public. Never commit secrets, real personal data or customer data. The pre-commit hook runs gitleaks.
- The project must run fully local for tests and demos, with no internet. Add infrastructure (database, storage, relay) only when a feature needs it.
