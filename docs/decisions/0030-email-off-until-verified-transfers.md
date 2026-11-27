# 0030: Email is off until verified transfers

- Status: Accepted
- Date: 2026-11-27
- Linear: FID-376

This record amends 0012. Read it with the decision below: everything 0012 describes holds only while `MAIL_ENABLED=1`, which no deployment sets.

## Context

- 0012 added emailed links: the sender gives an address, our server emails the link and a one-time code. It is the one mode in which a link's secret reaches our server and the mail service, and every claim on the site that nobody in between can read the file needed an exception for it (0014).
- Manual testing found that emailed links don't belong in the free version. They will be needed with verified transfers, where the recipient's identity matters (FID-380).
- The server turned mail on whenever `MAIL_SMTP_URL`, `MAIL_FROM` and `PUBLIC_ORIGIN` were all set. The box's command that turns mail on writes those settings, so turning mail off depended on nobody running it.

## Options considered

- **Delete the email code.** The pages get simpler, but FID-380 would rebuild the server's bindings, limits, codes and their tests from history.
- **Leave the code on and hide the field in the web client.** The server would still send mail for any client that asks, a modified one included.
- **A server switch, off by default, plus removing the page text.** The server sends nothing and `hello` says `mail: false`, so the send page never offers the field. The code and its tests stay.

## Decision

- The server sends mail only when `MAIL_ENABLED` is `1` and the three mail settings are set. Any other value of `MAIL_ENABLED` stops it at start. Without the switch it ignores the mail settings, so a box that has them still starts and sends nothing.
- No deployment sets `MAIL_ENABLED`. `pnpm e2e` sets it with Mailpit, so the email tests keep running.
- The public pages (`/how`, `/how/traces`, `/privacy`, `/security`, `/terms`) don't describe emailed links. Text that only the email flow renders stays with the code. The removal is one commit, so FID-380 can revert it.
- `docs/how-fidant-works.md` keeps describing the email code, because it describes the code on `main` and `packages/protocol/src/transfer-paths.test.ts` checks it, and says that email is off.

## Consequences

- fidant.se sends no mail and its link secrets never leave the browser, unless a deployment sets `MAIL_ENABLED=1`.
- The invariants' email exceptions in `AGENTS.md` stay, because the code exists, and say that email is off.
- Turning email back on (FID-380) takes the switch on the box, which changes `apps/infra/box/user-data.sh` or what it renders and so replaces the box, and a revert of the page text, brought up to date with what changed since.
