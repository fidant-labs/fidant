# Sigill

Secure file transfer. Files are encrypted in the sender's browser, and no infrastructure (our servers, hosts, relays, email) can read file content. Verified transfers add BankID identity, a signed receipt, and a tamper-evident audit log.

Planning lives in Linear: workspace `sigill`, team `SIG`, issue keys like `SIG-21`.

## Commands

- `pnpm install`: installs dependencies and the git hooks.
- `pnpm start`: builds the web client and serves it over HTTPS on `PORT` (default 8443), on all network interfaces, and prints the addresses to open. The first start creates a self-signed certificate in `.certs/` (or in `CERT_DIR` if set); browsers show a warning once. On macOS, a browser on another laptop needs Local Network access (System Settings → Privacy & Security → Local Network) or the page "can't be reached", even though `curl` works.
- `pnpm check`: lint, typecheck, unit tests and build across the workspace. Run it before every commit. The pre-push hook runs it too.
- `pnpm format`: fixes formatting and safe lint issues.
- `pnpm e2e`: builds the web client, starts the local stack and runs the Playwright suite in `apps/e2e` (Chromium). It is not part of `pnpm check`. Browser traffic and server logs are written to `apps/e2e/observations/`. Playwright traces and reports stay local and are never uploaded. One-time setup: `pnpm --filter @sigill/e2e exec playwright install chromium`.
- `pnpm --filter @sigill/infra cdk deploy FidantDns --profile fidant-dns` and `pnpm --filter @sigill/infra cdk deploy FidantApp --profile fidant-poc`: deploy the AWS infrastructure in `apps/infra`, all of it in eu-north-1. Sign in first with `aws sso login --sso-session fidant`. The app reads the two account IDs from the untracked `apps/infra/.env` (see `.env.example`) and gives each profile only its own account's stacks, so a deploy under the wrong profile finds no stack. Bootstrap each account once with `pnpm --filter @sigill/infra cdk bootstrap --profile <profile>`.
  - The first deploy has a fixed order, because the DNS records need the box's address from another account: deploy `FidantApp` with the `fidant-poc` profile, copy its `PublicIp` output into `boxAddress` in `apps/infra/src/config.ts`, deploy `FidantDns` with the `fidant-dns` profile and commit the value. At the registrar (a separate AWS account), fidant.se, fidant.eu and fidant.org point at the name servers that `FidantDns` outputs. `FidantDns` has termination protection, so `cdk destroy` refuses it until the protection is turned off.
  - A push to `main` that touches one of the files the workflow checks out, or the workflow itself, deploys `FidantDns` and `FidantApp` through `.github/workflows/deploy-infra.yml`. The workflow checks out only `apps/infra/`, the root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and `.node-version`. It runs in the GitHub environment `production`, which deploys only from `main` (deployment branches set to selected branches, exactly `main`, and no tag rules) and holds the account IDs as the secrets `FIDANT_DNS_ACCOUNT` and `FIDANT_POC_ACCOUNT`. The environment must exist with that policy and both secrets before anything else: a workflow run creates a missing `production` with no branch policy, and any branch could then get a token the role trusts. It signs in to each account through GitHub OIDC as the role `fidant-ci-deploy`, which trusts only that environment's token and may only assume the CDK bootstrap roles.
  - `FidantCi` holds that role and the OIDC provider, one per account. CI never deploys it. Deploy it by hand once per account, only after the `production` environment is set up, and again after changing `apps/infra/src/ci.ts`: `pnpm --filter @sigill/infra cdk deploy FidantCi --profile fidant-dns`, then the same with `--profile fidant-poc`. The first change that triggers the workflow merges only after that.
  - `FidantApp` (account `fidant-poc`) is the Lightsail box that serves the app at fidant.se and redirects the other five names to it. Caddy serves HTTPS with Let's Encrypt certificates, so fidant.se must point at the box before Caddy can get one; if it pointed elsewhere when the box booted, `systemctl restart caddy` through Lightsail's browser SSH makes Caddy retry at once instead of after a growing delay. The box deploys the app itself: every minute it reads `main` from GitHub and builds a new commit into `/opt/sigill/releases/<sha>`. It switches `/opt/sigill/current` to the new release only if the build succeeds, and switches back if the server does not answer within about a minute. A commit whose build or start fails is marked in `/opt/sigill/failed-<sha>` and not retried; delete that file to retry. The box's instance name carries a hash of `apps/infra/box/user-data.sh`, so changing that script, `.node-version` or the pnpm version replaces the box. The static IP moves to the new box at once, and the site is down for the 5–10 minutes it needs to install, get certificates and build. Lightsail runs the script through `/bin/sh`, so it must stay POSIX sh.

## Prerequisites

- Node 26 (see `.node-version`).
- pnpm, at the version pinned in `package.json` (`packageManager`). Node 26 ships without Corepack, so install it with `npm install -g pnpm@<version>`.
- gitleaks (`brew install gitleaks`). The pre-commit hook fails without it.
- openssl, for the local certificate. macOS and Linux ship with it.
- jq, for the Claude Code hooks. Recent macOS versions include it; on Linux, install it with the package manager.
- AWS CLI v2, only for deploying `apps/infra`. Its SSO profiles (`fidant-mgmt`, `fidant-dns`, `fidant-poc`) are in SIG-54.

## Layout

- `apps/*`: things we run or ship. `apps/web` is the Preact client, built by Vite into `apps/web/dist`. `apps/server` is the Node process that serves it and relays signaling messages between browsers over a WebSocket at `/signal`. `apps/e2e` is the end-to-end harness (see `docs/decisions/0001-e2e-tests-and-leak-model.md`).
- `apps/infra` (`@sigill/infra`): the AWS CDK app. `FidantDns` (account `fidant-dns`) holds the hosted zones for fidant.se, fidant.eu and fidant.org and every record in them; all six site names point at the box's static IP, copied by hand into `boxAddress` in `apps/infra/src/config.ts`. `FidantApp` (account `fidant-poc`) is the app box; its first-boot script is `apps/infra/box/user-data.sh`. `FidantCi` (both accounts) holds the role that CI deploys with. Every stack is in eu-north-1.
- `packages/*`: code used by more than one app. Create a package only when a second consumer exists.
- `packages/protocol` (`@sigill/protocol`): signaling message types, parsers and limits shared by the server and the web client.
- `docs/decisions/`: decision records. See its README for the format.
- Workspace packages export TypeScript source directly (`"exports": { ".": "./src/index.ts" }`). Internal packages have no build step.
- Every package with TypeScript has a `typecheck` script (`tsc --noEmit -p .`) and, if it has tests, a `test` script. The root scripts run them recursively.

## Conventions

- Node runs `.ts` files directly through type stripping. Use only erasable TypeScript syntax (no `enum`, `namespace` or constructor parameter properties). Relative imports include the `.ts` extension.
- `apps/web` is Preact 11 with Vite, not React or Next.js. React guidance, including the `vercel-react-best-practices` skill, applies only where Preact has the same API. Check the Preact docs (https://preactjs.com) before using an API, and import from `preact` and `preact/hooks`. Skip rules about Next.js, React Server Components, `React.cache`, `<Activity>` and server actions. `startTransition`, `useTransition` and `useDeferredValue` from `preact/compat` run updates synchronously with no deferral (`isPending` is always `false`), so rules that rely on them for responsiveness or pending UI don't apply. Don't add the libraries the skill suggests (SWR, `better-all`, `lru-cache`) without a separate decision.
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
- Pull requests that touch `.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `.agents/**`, `.mcp.json`, `skills-lock.json` or the files the infra deploy checks out (`apps/infra/**`, the root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and `.node-version`) also need an approval from the `maintainers` team. Authors cannot approve their own pull requests, so the other developer approves. The `sensitive-paths` ruleset enforces this, and repository admins can bypass it.
- Agents never approve pull requests, never merge with `--admin` or any other rule bypass, and never change rulesets, teams or repository settings.

## Invariants

- Never send file content, file names, file metadata or keys to the server or any other infrastructure, and never log them. The one deliberate exception: the BankID receipt text names the file.
- Keys live only in the URL fragment or in browser memory. The one exception: the server-held half of a verified transfer's split key, which the server stores and releases only after the receipt is signed (see `docs/decisions/0001-e2e-tests-and-leak-model.md`).
- What counts as a leak, concretely, is defined in `docs/decisions/0001-e2e-tests-and-leak-model.md`.
- This repository is public. Never commit secrets, real personal data or customer data. The pre-commit hook runs gitleaks.
- The project must run fully local for tests and demos, with no internet. Add infrastructure (database, storage, relay) only when a feature needs it.
