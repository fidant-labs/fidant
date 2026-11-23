# Sigill

Secure file transfer. Files are encrypted in the sender's browser, and no infrastructure (our servers, hosts, relays, email) can read file content. Verified transfers add BankID identity, a signed receipt, and a tamper-evident audit log.

Planning lives in Linear: workspace `sigill`, team `SIG`, issue keys like `SIG-21`.

## Commands

- `pnpm install`: installs dependencies and the git hooks.
- `pnpm start`: builds the web client and serves it over HTTPS on `PORT` (default 8443), on all network interfaces, and prints the addresses to open. The first start creates a self-signed certificate in `.certs/` (or in `CERT_DIR` if set); browsers show a warning once. On macOS, a browser on another laptop needs Local Network access (System Settings → Privacy & Security → Local Network) or the page "can't be reached", even though `curl` works.
- `pnpm check`: lint, typecheck, unit tests and build across the workspace. Run it before every commit. The pre-push hook runs it too.
- `pnpm format`: fixes formatting and safe lint issues.
- `pnpm e2e`: builds the web client, starts the local stack and runs the Playwright suite in `apps/e2e` (Chromium). It is not part of `pnpm check`. Browser traffic and server logs are written to `apps/e2e/observations/`. Playwright traces and reports stay local and are never uploaded. One-time setup: `pnpm --filter @sigill/e2e exec playwright install chromium`.
- `pnpm --filter @sigill/web e2e`: Playwright end-to-end test of the first demo in headless Chromium against the real server. Run `pnpm build` first. Install the browser once with `pnpm --filter @sigill/web exec playwright install chromium`. `pnpm check` does not run it; CI runs it as the `first-demo-e2e` job. SIG-41 moves it onto `apps/e2e`.

## Prerequisites

- Node 24 (see `.node-version`).
- pnpm, at the version pinned in `package.json` (`packageManager`).
- gitleaks (`brew install gitleaks`). The pre-commit hook fails without it.
- openssl, for the local certificate. macOS and Linux ship with it.
- jq, for the Claude Code hooks. Recent macOS versions include it; on Linux, install it with the package manager.

## Layout

- `apps/*`: things we run or ship. `apps/web` is the Preact client, built by Vite into `apps/web/dist`. `apps/server` is the Node process that serves it and relays signaling messages between browsers over a WebSocket at `/signal`. `apps/e2e` is the end-to-end harness (see `docs/decisions/0001-e2e-tests-and-leak-model.md`).
- `apps/web/e2e`: Playwright end-to-end tests for the first demo, with their own `tsconfig.json`. They move onto the shared e2e harness in SIG-41.
- `packages/*`: code used by more than one app. Create a package only when a second consumer exists.
- `packages/protocol` (`@sigill/protocol`): signaling message types, parsers and limits shared by the server and the web client.
- `docs/decisions/`: decision records. See its README for the format.
- Workspace packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Internal packages have no build step.
- Every package with TypeScript has a `typecheck` script (`tsc --noEmit -p .`) and, if it has tests, a `test` script. The root scripts run them recursively.

## Conventions

- Node runs `.ts` files directly through type stripping. Use only erasable TypeScript syntax (no `enum`, `namespace` or constructor parameter properties). Relative imports include the `.ts` extension.
- Unit tests use `node:test` and sit next to the code as `*.test.ts`.
- End-to-end specs live in `apps/e2e/tests/` and import `test` from `apps/e2e/src/fixtures.ts` and open browsers with its `actor` fixture, so traffic is recorded.
- Dependencies: `pnpm add --filter <package> <dep>`. pnpm is strict, so each package declares everything it imports.
- Workspace packages: add one as a dependency with `pnpm add --filter <consumer> --workspace <package>`, which links and saves `workspace:*`. Without `--workspace`, pnpm can resolve the name from the public npm registry.
- Commits: conventional commits, subject line only, imperative, under 72 characters, for example `feat: add signaling server`.
- Branches: `sig-<number>-<short-slug>` after the Linear issue. One pull request per issue. `main` is protected: changes land only through pull requests with green CI.
- Pull request titles start with the Linear issue key (`SIG-21: ...`) so Linear links them.
- Keep the Linear issue's status current while working: assign it and set "In Progress" when work starts, link the pull request when it opens, and set "Done" when it merges.

## Merging

- An agent may merge a pull request when the required `check` passed and the latest review by `github-actions[bot]` on the pull request's current head commit is an approval. The approval counts only with a successful `Claude review` run on that same commit, because any workflow in this repository can post a review as `github-actions[bot]`.
- Pull requests that touch `.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.agents/**`, `.mcp.json` or `skills-lock.json` also need an approval from the `maintainers` team. Authors cannot approve their own pull requests, so the other developer approves. The `sensitive-paths` ruleset enforces this, and repository admins can bypass it.
- Agents never approve pull requests, never merge with `--admin` or any other rule bypass, and never change rulesets, teams or repository settings.

## Invariants

- Never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them. The one deliberate exception: the BankID receipt text names the file.
- Keys live only in the URL fragment or in browser memory. The one exception: the server-held half of a verified transfer's split key, which the server stores and releases only after the receipt is signed (see `docs/decisions/0001-e2e-tests-and-leak-model.md`).
- What counts as a leak, concretely, is defined in `docs/decisions/0001-e2e-tests-and-leak-model.md`.
- This repository is public. Never commit secrets, real personal data or customer data. The pre-commit hook runs gitleaks.
- The project must run fully local for tests and demos, with no internet. Add infrastructure (database, storage, relay) only when a feature needs it.
