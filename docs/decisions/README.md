# Decision records

A decision record captures one decision that shapes more than one issue: the context, the options we weighed, what we chose and what follows from it.

- Name files `NNNN-slug.md`, numbered in order, for example `0001-e2e-tests-and-leak-model.md`.
- Start each record with a title and a three-item list:
  - `Status:` Proposed, Accepted, or Superseded by NNNN.
  - `Date:` the day of the last status change, as `YYYY-MM-DD`.
  - `Linear:` the issue key, for example `SIG-38`.
- Sections, in order: Context, Options considered, Decision, Consequences.
- A record counts as accepted when its pull request merges. Until then it may change, even if its status already reads Accepted.
- A record's number is settled only when its pull request merges. Until then another pull request can take it.
- A Proposed record may change freely. Once Accepted and merged, a record is never rewritten. To change a decision, write a new record and set the old one's status to Superseded by the new number. That status line is the only edit allowed.

## Runbooks

Runbooks live in records and in the root `AGENTS.md`.

- A check proves only what its output can contradict. A script that exits 0 on failure passes every check built on its exit status, so each check states the exact output that means success, the way 0007 says `stat -c '%a %U:%G' /etc/turnserver.conf` must print `640 root:turnserver`.
- A restart or delete that a check gates comes after that check, and the command itself enforces the gate, for example `[ "$(...)" = 1 ] && systemctl restart x`. Prose after a command doesn't stop someone who pastes the block.
- A timer on the box can run between two steps, so each step holds whether or not it has run.
- A resource that CDK doesn't name gets a deployed name with generated parts, for example `FidantApp-RelayCapSchedule<hash>`, so a command that names it uses the deployed name, not the construct ID. Every `aws` command names its `--profile`, and a command for a regional service also names its `--region`.
- In `a | b`, `a` runs to the end even when `b` fails, so whatever `a` creates exists either way.
