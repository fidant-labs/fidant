# Sigill

Secure file transfer. Files are encrypted in the sender's browser, and no infrastructure (our servers, hosts, relays, email) can read file content. Verified transfers add BankID identity, a signed receipt, and a tamper-evident audit log.

Planning lives in Linear: workspace `sigill`, team `SIG`, issue keys like `SIG-21`.

## Commands

- `pnpm install`: installs dependencies and the git hooks.
- `pnpm check`: lint, typecheck and unit tests across the workspace. Run it before every commit. The pre-push hook runs it too.
- `pnpm format`: fixes formatting and safe lint issues.

## Prerequisites

- Node 24 (see `.node-version`).
- pnpm, at the version pinned in `package.json` (`packageManager`).
- gitleaks (`brew install gitleaks`). The pre-commit hook fails without it.

## Layout

- `apps/*`: things we run or ship, such as the server and the web client.
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

## Invariants

- Never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them. The one deliberate exception: the BankID receipt text names the file.
- Keys live only in the URL fragment or in browser memory.
- This repository is public. Never commit secrets, real personal data or customer data. The pre-commit hook runs gitleaks.
- The project must run fully local for tests and demos, with no internet. Add infrastructure (database, storage, relay) only when a feature needs it.
