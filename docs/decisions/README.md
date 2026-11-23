# Decision records

A decision record captures one decision that shapes more than one issue: the context, the options we weighed, what we chose and what follows from it.

- Name files `NNNN-slug.md`, numbered in order, for example `0001-e2e-tests-and-leak-model.md`.
- Start each record with a title and a three-item list:
  - `Status:` Proposed, Accepted, or Superseded by NNNN.
  - `Date:` the day of the last status change, as `YYYY-MM-DD`.
  - `Linear:` the issue key, for example `SIG-38`.
- Sections, in order: Context, Options considered, Decision, Consequences.
- A record counts as accepted when its pull request merges. Until then it may change, even if its status already reads Accepted.
- A Proposed record may change freely. Once Accepted and merged, a record is never rewritten. To change a decision, write a new record and set the old one's status to Superseded by the new number. That status line is the only edit allowed.
